use std::fmt;

/// A syntax error, with its position (spec §8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    /// The message, without position.
    pub reason: String,
    /// Byte offset in the input.
    pub offset: usize,
    /// 1-based line.
    pub line: usize,
    /// 1-based column, in Unicode code points.
    pub column: usize,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at {}:{}", self.reason, self.line, self.column)
    }
}

impl std::error::Error for SyntaxError {}

impl SyntaxError {
    /// An error at byte offset `at` of `src`.
    pub(crate) fn at(src: &str, at: usize, reason: impl Into<String>) -> SyntaxError {
        let at = Position::START.after(&src[..floor_char_boundary(src, at.min(src.len()))]);
        SyntaxError { reason: reason.into(), offset: at.offset, line: at.line, column: at.column }
    }

    /// The same error, in a piece of text that starts at `origin` of the whole input.
    pub(crate) fn from(self, origin: Position) -> SyntaxError {
        SyntaxError {
            offset: origin.offset + self.offset,
            column: if self.line == 1 { origin.column + self.column - 1 } else { self.column },
            line: origin.line + self.line - 1,
            ..self
        }
    }
}

/// A place in the input: byte offset, 1-based line and column (in code points).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Position {
    pub offset: usize,
    pub line: usize,
    pub column: usize,
}

impl Position {
    pub const START: Position = Position { offset: 0, line: 1, column: 1 };

    /// Where the input is after `text`, starting here.
    pub fn after(self, text: &str) -> Position {
        text.chars().fold(Position { offset: self.offset + text.len(), ..self }, |p, c| match c {
            '\n' => Position { line: p.line + 1, column: 1, ..p },
            _ => Position { column: p.column + 1, ..p },
        })
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// A value that doesn't match its type, with where it is: `.total(Money)[1]: …`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    /// Where in the value, outermost first; empty at the root.
    pub path: Vec<Segment>,
    pub reason: String,
}

/// One step into a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    /// A record field: `.name`, or `["pt-BR"]` for keys that aren't identifiers.
    Field(String),
    /// An array item or a payload value: `[2]`.
    Index(usize),
    /// The payload of a tag: `(Money)`.
    Tag(String),
}

impl DecodeError {
    pub fn new(reason: impl Into<String>) -> DecodeError {
        DecodeError { path: Vec::new(), reason: reason.into() }
    }

    /// The same error, one step further out. Errors are built from the
    /// inside out, so this prepends.
    fn within(mut self, segment: Segment) -> DecodeError {
        self.path.insert(0, segment);
        self
    }

    /// The same error, inside field `key`.
    pub fn field(self, key: &str) -> DecodeError {
        self.within(Segment::Field(key.to_owned()))
    }

    /// The same error, inside item `i` of an array or a payload.
    pub fn index(self, i: usize) -> DecodeError {
        self.within(Segment::Index(i))
    }

    /// The same error, inside the payload of `tag`.
    pub fn tag(self, tag: &str) -> DecodeError {
        self.within(Segment::Tag(tag.to_owned()))
    }
}

impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Segment::Field(key) if is_identifier(key) => write!(f, ".{key}"),
            Segment::Field(key) => write!(f, "[{key:?}]"),
            Segment::Index(i) => write!(f, "[{i}]"),
            Segment::Tag(tag) => write!(f, "({tag})"),
        }
    }
}

/// A key written without quotes: `name`, `_id`.
fn is_identifier(key: &str) -> bool {
    key.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.path.iter().try_for_each(|s| s.fmt(f))?;
        if self.path.is_empty() { f.write_str(&self.reason) } else { write!(f, ": {}", self.reason) }
    }
}

impl std::error::Error for DecodeError {}

/// Reading a typed value: the input can't be read, isn't haus, or doesn't match its type.
#[derive(Debug)]
pub enum Error {
    Syntax(SyntaxError),
    Decode(DecodeError),
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Syntax(e) => e.fmt(f),
            Error::Decode(e) => e.fmt(f),
            Error::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Syntax(e) => Some(e),
            Error::Decode(e) => Some(e),
            Error::Io(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<SyntaxError> for Error {
    fn from(e: SyntaxError) -> Self {
        Error::Syntax(e)
    }
}
impl From<DecodeError> for Error {
    fn from(e: DecodeError) -> Self {
        Error::Decode(e)
    }
}
