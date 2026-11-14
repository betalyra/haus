//! Streams (spec §6): a file of values, each followed by a comma, read as
//! the values arrive.
//!
//! ```
//! # fn main() -> Result<(), haus::Error> {
//! let input = "Heartbeat,\nUserCreated { id: 1 },\n".as_bytes();
//! for value in haus::stream::values(input) {
//!     println!("{:?}", value?);
//! }
//! # Ok(())
//! # }
//! ```
//!
//! [`Reader`] does no I/O: push chunks of bytes, split anywhere, and get
//! every value that is complete. [`values`], [`decode`] and [`encode`] use it
//! with `std::io`; an async adapter is the same loop around `.await`.
//!
//! Memory is bounded by the largest single value, not by the stream.

use crate::error::Position;
use crate::parser::{parse_rest, parse_single};
use crate::{Decode, Encode, Error, Limits, SyntaxError, Value, to_string};
use std::collections::VecDeque;
use std::io::{self, Read, Write};

/// How to read a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub limits: Limits,
    /// The most characters in one top-level value (spec §7: 64 Mi).
    pub max_value_length: usize,
    /// Require a comma after every value, the last one too: a stream that
    /// ends without one is reported as cut off. Recommended for network streams.
    pub require_terminator: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { limits: Limits::default(), max_value_length: 64 * 1024 * 1024, require_terminator: false }
    }
}

/// What the scanner is inside of. It only tracks what it needs to find the
/// commas between values; the parser checks everything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    String,
    Block,
    LineComment,
    Comment { depth: usize },
}

/// Reads a stream from chunks of bytes. After an error it must not be used again.
#[derive(Debug)]
pub struct Reader {
    options: Options,
    /// Bytes received and not yet parsed. The current value starts at `start`;
    /// the bytes before it belong to values already returned, and are dropped
    /// once per chunk rather than after each value, which would make a chunk
    /// with many values take quadratic time.
    buf: Vec<u8>,
    start: usize,
    /// How far `buf` has been scanned.
    scanned: usize,
    /// Characters scanned in the current value (bytes that start a code point).
    chars: usize,
    mode: Mode,
    depth: usize,
    /// Where the current value starts in the whole input.
    origin: Position,
    started: bool,
}

impl Default for Reader {
    fn default() -> Self {
        Reader::new(Options::default())
    }
}

impl Reader {
    pub fn new(options: Options) -> Reader {
        Reader {
            options,
            buf: Vec::new(),
            start: 0,
            scanned: 0,
            chars: 0,
            mode: Mode::Normal,
            depth: 0,
            origin: Position::START,
            started: false,
        }
    }

    /// Add a chunk; returns the values it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, SyntaxError> {
        self.buf.extend_from_slice(chunk);
        if !self.started && !self.buf.is_empty() {
            if self.buf.len() < 3 && b"\xEF\xBB\xBF".starts_with(&self.buf) {
                return Ok(vec![]); // maybe a byte order mark: wait for more
            }
            self.started = true;
            if self.buf.starts_with(b"\xEF\xBB\xBF") {
                self.buf.drain(..3);
                self.origin = Position::AFTER_BOM;
            }
        }
        self.scan(false)
    }

    /// The input is complete: returns the last value, if it had no comma after it.
    pub fn finish(mut self) -> Result<Vec<Value>, SyntaxError> {
        let mut out = self.scan(true)?;
        let text = self.text(self.buf.len())?;
        let rest = parse_rest(text, &self.options.limits, self.at_file_start()).map_err(|e| e.from(self.origin))?;
        if !rest.is_empty() && self.options.require_terminator {
            let end = self.origin.after(text);
            let reason = "stream ended without ',' after the last value (truncated?)";
            return Err(SyntaxError { reason: reason.into(), offset: end.offset, line: end.line, column: end.column });
        }
        out.extend(rest);
        Ok(out)
    }

    /// Finds the commas between values and parses what is before them.
    fn scan(&mut self, last: bool) -> Result<Vec<Value>, SyntaxError> {
        let mut out = Vec::new();
        // Is the byte `n` places ahead there (or will it never come)?
        let has = |buf: &[u8], i: usize, n: usize| last || i + n < buf.len();
        let mut i = self.scanned;
        while i < self.buf.len() {
            if self.chars > self.options.max_value_length {
                let reason = format!("value longer than {} characters", self.options.max_value_length);
                let at = self.origin;
                return Err(SyntaxError { reason, offset: at.offset, line: at.line, column: at.column });
            }
            let c = self.buf[i];
            // `step` bytes are part of the value; 0: wait for more input.
            let step = match self.mode {
                Mode::Normal => match c {
                    b'/' if !has(&self.buf, i, 1) => 0,
                    // At the end of the input (`last`), there may be no next byte.
                    b'/' => match self.buf.get(i + 1) {
                        Some(b'/') => {
                            self.mode = Mode::LineComment;
                            2
                        }
                        Some(b'*') => {
                            self.mode = Mode::Comment { depth: 1 };
                            2
                        }
                        _ => 1,
                    },
                    b'"' if !has(&self.buf, i, 2) => 0,
                    b'"' if self.buf[i..].starts_with(b"\"\"\"") => {
                        self.mode = Mode::Block;
                        3
                    }
                    b'"' => {
                        self.mode = Mode::String;
                        1
                    }
                    b'{' | b'[' | b'(' => {
                        self.depth += 1;
                        1
                    }
                    b'}' | b']' | b')' if self.depth == 0 => return Err(self.unbalanced(i)),
                    b'}' | b']' | b')' => {
                        self.depth -= 1;
                        1
                    }
                    b',' if self.depth == 0 => {
                        out.push(self.cut(i)?);
                        i += 1;
                        continue;
                    }
                    _ => 1,
                },
                Mode::LineComment => {
                    if c == b'\n' {
                        self.mode = Mode::Normal;
                    }
                    1
                }
                Mode::Comment { depth } => match c {
                    b'/' | b'*' if !has(&self.buf, i, 1) => 0,
                    _ if self.buf[i..].starts_with(b"/*") => {
                        self.mode = Mode::Comment { depth: depth + 1 };
                        2
                    }
                    _ if self.buf[i..].starts_with(b"*/") => {
                        self.mode = if depth == 1 { Mode::Normal } else { Mode::Comment { depth: depth - 1 } };
                        2
                    }
                    _ => 1,
                },
                Mode::String => match c {
                    b'\\' if !has(&self.buf, i, 1) => 0,
                    b'\\' => 2,
                    // A line break can't be in a string: the parser reports it at the next cut.
                    b'"' | b'\n' => {
                        self.mode = Mode::Normal;
                        1
                    }
                    _ => 1,
                },
                Mode::Block => match c {
                    b'\\' if !has(&self.buf, i, 1) => 0,
                    b'\\' => 2,
                    b'"' if !has(&self.buf, i, 2) => 0,
                    b'"' if self.buf[i..].starts_with(b"\"\"\"") => {
                        self.mode = Mode::Normal;
                        3
                    }
                    _ => 1,
                },
            };
            if step == 0 {
                break;
            }
            let end = (i + step).min(self.buf.len());
            self.chars += self.buf[i..end].iter().filter(|&&b| b & 0xC0 != 0x80).count();
            i = end;
        }
        self.buf.drain(..self.start);
        self.scanned = i - self.start;
        self.start = 0;
        Ok(out)
    }

    /// Parse the value before the comma at `comma`; the next one starts after it.
    fn cut(&mut self, comma: usize) -> Result<Value, SyntaxError> {
        let origin = self.origin;
        let text = self.text(comma)?;
        let value = parse_single(text, &self.options.limits, self.at_file_start()).map_err(|e| e.from(origin))?;
        self.origin = origin.after(text).after(",");
        self.start = comma + 1;
        self.chars = 0;
        Ok(value)
    }

    /// Whether the current value starts the file (after a byte order mark).
    fn at_file_start(&self) -> bool {
        matches!(self.origin, Position::START | Position::AFTER_BOM)
    }

    /// The current value's text, up to `end`.
    fn text(&self, end: usize) -> Result<&str, SyntaxError> {
        let bytes = &self.buf[self.start..end];
        std::str::from_utf8(bytes).map_err(|e| {
            let valid = std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap_or_default();
            let at = self.origin.after(valid);
            SyntaxError { reason: "invalid UTF-8".into(), offset: at.offset, line: at.line, column: at.column }
        })
    }

    /// A closing bracket without an opening one: let the parser say what's wrong.
    fn unbalanced(&self, at: usize) -> SyntaxError {
        let error = |text: &str| match parse_single(text, &self.options.limits, self.at_file_start()) {
            Err(e) => e.from(self.origin),
            Ok(_) => SyntaxError::at(text, at - self.start, format!("unexpected '{}'", self.buf[at] as char))
                .from(self.origin),
        };
        match self.text(at + 1) {
            Ok(text) => error(text),
            Err(e) => e,
        }
    }
}

/// The values of a stream read from `input`, one by one.
pub fn values<R: Read>(input: R) -> Values<R> {
    values_with(input, Options::default())
}

/// [`values`], with options.
pub fn values_with<R: Read>(input: R, options: Options) -> Values<R> {
    Values { input, reader: Some(Reader::new(options)), ready: VecDeque::new(), chunk: vec![0; 64 * 1024] }
}

/// An iterator over the values of a stream. It ends after the first error.
pub struct Values<R> {
    input: R,
    /// None once the input is finished, or after an error.
    reader: Option<Reader>,
    ready: VecDeque<Value>,
    chunk: Vec<u8>,
}

impl<R: Read> Values<R> {
    /// Read until there are values, or the input ends.
    fn fill(&mut self) -> Result<(), Error> {
        while self.ready.is_empty() {
            let Some(reader) = self.reader.as_mut() else { return Ok(()) };
            let n = match self.input.read(&mut self.chunk) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            let values = match n {
                0 => self.reader.take().map_or(Ok(vec![]), Reader::finish)?,
                n => reader.push(&self.chunk[..n])?,
            };
            self.ready.extend(values);
        }
        Ok(())
    }
}

impl<R: Read> Iterator for Values<R> {
    type Item = Result<Value, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Err(e) = self.fill() {
            self.reader = None;
            return Some(Err(e));
        }
        self.ready.pop_front().map(Ok)
    }
}

/// The values of a stream read from `input`, decoded as `T` one by one.
/// Errors say which value: `[3].total: …`.
pub fn decode<T: Decode, R: Read>(input: R) -> impl Iterator<Item = Result<T, Error>> {
    values(input).enumerate().map(|(i, value)| Ok(T::decode(&value?).map_err(|e| e.index(i))?))
}

/// Write `values` as a stream: one per line, each followed by a comma.
pub fn encode<T: Encode, W: Write>(mut output: W, values: impl IntoIterator<Item = T>) -> io::Result<()> {
    values.into_iter().try_for_each(|v| writeln!(output, "{},", to_string(&v)))?;
    output.flush()
}
