//! Recursive-descent parser over one complete piece of text: a port of the
//! TypeScript reference parser (typescript/packages/haus/src/parser.ts).

use crate::{SyntaxError as Error, Value};
use std::collections::HashSet;
use std::fmt::Write as _;

/// Resource limits, enforced while parsing (spec §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Nesting depth of records, arrays and payloads.
    pub max_depth: usize,
    /// Characters in one number literal, including sign, separators and exponent.
    pub max_number_length: usize,
    /// Largest absolute exponent: 6144 allows `1e6144` but not `1e6145`.
    pub max_exponent: u64,
    /// Characters (code points) in one decoded string, or between the quotes of a byte string.
    pub max_string_length: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_depth: 256, max_number_length: 1000, max_exponent: 6144, max_string_length: 16 * 1024 * 1024 }
    }
}

/// Parse a file with the given limits.
pub fn parse_with(src: &str, limits: &Limits) -> Result<Vec<Value>, Error> {
    Parser { src, b: src.as_bytes(), pos: 0, depth: 0, limits }.sequence()
}

/// Exactly one value, with comments and whitespace around it: one item of a stream.
pub(crate) fn parse_single(src: &str, limits: &Limits) -> Result<Value, Error> {
    Parser { src, b: src.as_bytes(), pos: 0, depth: 0, limits }.single()
}

type R<T> = Result<T, Error>;

struct Parser<'a> {
    src: &'a str,
    b: &'a [u8],
    pos: usize,
    depth: usize,
    limits: &'a Limits,
}

/// Raw bidirectional controls (U+202A–U+202E, U+2066–U+2069) are not allowed outside escapes.
fn is_bidi(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}
fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
fn is_lower_start(c: u8) -> bool {
    c.is_ascii_lowercase() || c == b'_'
}
fn is_blank(s: &str) -> bool {
    s.bytes().all(|c| c == b' ' || c == b'\t')
}
fn hex_value(c: u8) -> Option<u8> {
    (c as char).to_digit(16).and_then(|d| u8::try_from(d).ok())
}
fn describe(c: Option<char>) -> String {
    match c {
        None => "end of input".into(),
        Some('\n') => "line break".into(),
        Some(c) => format!("'{c}'"),
    }
}

impl<'a> Parser<'a> {
    // ── values ─────────────────────────────────────────────────

    fn sequence(&mut self) -> R<Vec<Value>> {
        let mut out = Vec::new();
        if self.src.starts_with('\u{FEFF}') {
            self.pos = 3;
        }
        self.trivia()?;
        while !self.eof() {
            out.push(self.value()?);
            self.trivia()?;
            if self.eof() {
                break;
            }
            self.expect(b',', "expected ',' between top-level values")?;
            self.trivia()?;
        }
        Ok(out)
    }

    fn single(&mut self) -> R<Value> {
        self.trivia()?;
        if self.eof() || self.peek() == Some(b',') {
            return Err(self.fail(format!("expected a value, found {}", describe(self.peek_char()))));
        }
        let value = self.value()?;
        self.trivia()?;
        match self.peek_char() {
            None => Ok(value),
            found => Err(self.fail(format!("expected ',' between top-level values, found {}", describe(found)))),
        }
    }

    fn value(&mut self) -> R<Value> {
        match self.peek() {
            Some(b'{') => self.record(),
            Some(b'[') => Ok(Value::Array(self.list(b'[', b']')?)),
            Some(b'"') if self.b[self.pos..].starts_with(b"\"\"\"") => self.block_string().map(Value::String),
            Some(b'"') => self.basic_string().map(Value::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b'x') if self.at(1) == Some(b'"') => self.bytes(),
            Some(c) if c.is_ascii_uppercase() => self.variant(),
            Some(c) if is_lower_start(c) => {
                let start = self.pos;
                let word = self.ident();
                let hint = match word {
                    "true" | "false" => " (booleans are the variants True / False)",
                    "null" => " (use the variant None)",
                    _ => "",
                };
                Err(self.fail_at(
                    start,
                    format!("unexpected identifier '{word}': lowercase identifiers can only be record keys{hint}"),
                ))
            }
            _ => Err(self.fail(format!("expected a value, found {}", describe(self.peek_char())))),
        }
    }

    fn enter(&mut self) -> R<()> {
        self.depth += 1;
        if self.depth > self.limits.max_depth {
            return Err(self.fail(format!("nesting deeper than {} levels", self.limits.max_depth)));
        }
        Ok(())
    }

    fn record(&mut self) -> R<Value> {
        let open = self.pos;
        self.enter()?;
        self.pos += 1; // {
        let mut fields = Vec::new();
        let mut seen = HashSet::new();
        self.trivia()?;
        while self.peek() != Some(b'}') {
            if self.eof() {
                return Err(self.fail_at(open, "unclosed '{'"));
            }
            let key_pos = self.pos;
            let key = self.key()?;
            self.trivia()?;
            self.expect(b':', &format!("expected ':' after key '{key}'"))?;
            self.trivia()?;
            let value = self.value()?;
            if !seen.insert(key.clone()) {
                return Err(self.fail_at(key_pos, format!("duplicate key '{key}'")));
            }
            fields.push((key, value));
            self.trivia()?;
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.trivia()?;
                }
                Some(b'}') => {}
                None => return Err(self.fail_at(open, "unclosed '{'")),
                _ => return Err(self.fail(format!("expected ',' or '}}', found {}", describe(self.peek_char())))),
            }
        }
        self.pos += 1; // }
        self.depth -= 1;
        Ok(Value::Record(fields))
    }

    fn key(&mut self) -> R<String> {
        match self.peek() {
            Some(b'"') if self.b[self.pos..].starts_with(b"\"\"\"") => {
                Err(self.fail("block strings can't be record keys"))
            }
            Some(b'"') => self.basic_string(),
            Some(c) if is_lower_start(c) => Ok(self.ident().to_owned()),
            Some(c) if c.is_ascii_uppercase() => {
                let start = self.pos;
                let word = self.ident();
                Err(self.fail_at(
                    start,
                    format!("record keys must start with a lowercase letter or '_'; quote it: \"{word}\""),
                ))
            }
            _ => Err(self.fail(format!("expected a record key, found {}", describe(self.peek_char())))),
        }
    }

    /// `open value, value, … close`, with an optional trailing comma.
    fn list(&mut self, open: u8, close: u8) -> R<Vec<Value>> {
        let start = self.pos;
        self.enter()?;
        self.pos += 1;
        let mut items = Vec::new();
        self.trivia()?;
        while self.peek() != Some(close) {
            if self.eof() {
                return Err(self.fail_at(start, format!("unclosed '{}'", open as char)));
            }
            items.push(self.value()?);
            self.trivia()?;
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.trivia()?;
                }
                Some(c) if c == close => {}
                None => return Err(self.fail_at(start, format!("unclosed '{}'", open as char))),
                _ => {
                    return Err(self.fail(format!(
                        "expected ',' or '{}', found {}",
                        close as char,
                        describe(self.peek_char())
                    )));
                }
            }
        }
        self.pos += 1;
        self.depth -= 1;
        Ok(items)
    }

    fn variant(&mut self) -> R<Value> {
        let tag = self.ident().to_owned();
        let after_tag = self.pos;
        // The payload must follow on the same line: only spaces and tabs in
        // between. Otherwise `Heartbeat⏎{ a: 1 }` with a forgotten comma would
        // silently become one variant with a payload.
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'(') => {
                let paren = self.pos;
                let args = self.list(b'(', b')')?;
                if args.is_empty() {
                    return Err(self.fail_at(paren, format!("empty payload: write '{tag}' without parentheses")));
                }
                Ok(Value::Variant { tag, args })
            }
            Some(b'{') => Ok(Value::Variant { tag, args: vec![self.record()?] }),
            _ => {
                self.pos = after_tag;
                Ok(Value::Variant { tag, args: vec![] })
            }
        }
    }

    // ── numbers ────────────────────────────────────────────────

    fn number(&mut self) -> R<Value> {
        let start = self.pos;
        self.check_number_limits(start)?;
        let neg = self.peek() == Some(b'-');
        let body = start + usize::from(neg);
        let text = if let Some((radix, end)) = self.radix_literal(body) {
            self.pos = end;
            let digits: Vec<u8> = self.b[body + 2..end].iter().copied().filter(|&c| c != b'_').collect();
            let n = to_decimal(&digits, radix);
            if neg && n != "0" { format!("-{n}") } else { n }
        } else {
            match self.decimal_literal(start) {
                Some(end) => {
                    self.pos = end;
                    self.src[start..end].replace('_', "").replace('E', "e")
                }
                None => return Err(self.fail_at(start, "invalid number")),
            }
        };
        if matches!(self.peek(), Some(c) if is_ident(c) || c == b'.') {
            let mut end = self.pos;
            while matches!(self.b.get(end), Some(&c) if is_ident(c) || c == b'.') {
                end += 1;
            }
            return Err(self.fail_at(start, format!("invalid number '{}'", &self.src[start..end])));
        }
        Ok(Value::Number(text))
    }

    /// `0x…` or `0b…` at `i`: the radix and where the literal ends.
    fn radix_literal(&self, i: usize) -> Option<(u32, usize)> {
        let radix = match (self.b.get(i), self.b.get(i + 1)) {
            (Some(b'0'), Some(b'x')) => 16,
            (Some(b'0'), Some(b'b')) => 2,
            _ => return None,
        };
        let end = self.digits(i + 2, |c| (c as char).is_digit(radix))?;
        Some((radix, end))
    }

    /// `d ('_'? d)*` at `i`: where it ends, or None without a first digit.
    fn digits(&self, i: usize, is: impl Fn(u8) -> bool) -> Option<usize> {
        if !matches!(self.b.get(i), Some(&c) if is(c)) {
            return None;
        }
        let mut j = i + 1;
        loop {
            match self.b.get(j) {
                Some(&c) if is(c) => j += 1,
                Some(b'_') if matches!(self.b.get(j + 1), Some(&c) if is(c)) => j += 2,
                _ => return Some(j),
            }
        }
    }

    /// `-?(0|[1-9]('_'?d)*)(.d('_'?d)*)?([eE][+-]?d('_'?d)*)?` at `i`: where it ends.
    fn decimal_literal(&self, mut i: usize) -> Option<usize> {
        let digit = |c: u8| c.is_ascii_digit();
        if self.b.get(i) == Some(&b'-') {
            i += 1;
        }
        i = match self.b.get(i) {
            Some(b'0') => i + 1,
            Some(b'1'..=b'9') => self.digits(i, digit)?,
            _ => return None,
        };
        if self.b.get(i) == Some(&b'.')
            && let Some(end) = self.digits(i + 1, digit)
        {
            i = end;
        }
        if matches!(self.b.get(i), Some(b'e' | b'E')) {
            let sign = usize::from(matches!(self.b.get(i + 1), Some(b'+' | b'-')));
            if let Some(end) = self.digits(i + 1 + sign, digit) {
                i = end;
            }
        }
        Some(i)
    }

    /// Checked before converting, so huge literals are rejected cheaply.
    fn check_number_limits(&self, start: usize) -> R<()> {
        let mut end = start;
        while matches!(self.b.get(end), Some(&c) if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'+' | b'_' | b'.'))
        {
            end += 1;
        }
        if end - start > self.limits.max_number_length {
            return Err(
                self.fail_at(start, format!("number literal longer than {} characters", self.limits.max_number_length))
            );
        }
        if let Some(exp) = decimal_exponent(&self.src[start..end]) {
            let digits: String = exp.chars().filter(|&c| c != '_').collect();
            let digits = digits.trim_start_matches('0');
            if digits.len() > 19 || digits.parse::<u64>().unwrap_or(0) > self.limits.max_exponent {
                return Err(self.fail_at(start, format!("exponent larger than {}", self.limits.max_exponent)));
            }
        }
        Ok(())
    }

    // ── bytes ──────────────────────────────────────────────────

    /// `x"0b34 ff"`: two hex digits per byte; spaces and tabs between bytes.
    fn bytes(&mut self) -> R<Value> {
        let open = self.pos;
        self.pos += 2; // x"
        let mut out = Vec::new();
        loop {
            let Some(c) = self.peek() else { return Err(self.fail_at(open, "unterminated byte string")) };
            match c {
                b'"' => break,
                b' ' | b'\t' => {
                    self.pos += 1;
                    continue;
                }
                _ => {}
            }
            let Some(hi) = hex_value(c) else {
                return Err(self.fail(if c == b'\n' || c == b'\r' {
                    "line break in byte string (keep x\"…\" on one line)".to_owned()
                } else {
                    format!("invalid character {} in byte string (expected hex digits)", describe(self.peek_char()))
                }));
            };
            let Some(lo) = self.at(1).and_then(hex_value) else {
                return Err(
                    self.fail("a byte needs two hex digits (an odd number of digits, or a space inside a byte)")
                );
            };
            out.push(hi * 16 + lo);
            self.pos += 2;
            if self.pos - open - 2 > self.limits.max_string_length {
                return Err(
                    self.fail_at(open, format!("byte string longer than {} characters", self.limits.max_string_length))
                );
            }
        }
        self.pos += 1; // "
        Ok(Value::Bytes(out))
    }

    // ── strings ────────────────────────────────────────────────

    fn basic_string(&mut self) -> R<String> {
        let open = self.pos;
        self.pos += 1; // "
        let mut out = String::new();
        let mut chunk = self.pos;
        loop {
            let Some(c) = self.peek() else { return Err(self.fail_at(open, "unterminated string")) };
            match c {
                b'"' => break,
                b'\\' => {
                    out.push_str(&self.src[chunk..self.pos]);
                    out.push(self.escape()?);
                    chunk = self.pos;
                }
                b'\n' => return Err(self.fail("line break in string (use \\n or a \"\"\" block string)")),
                b'\t' => return Err(self.fail("raw tab in string (use \\t)")),
                0..0x20 => return Err(self.fail("control character in string")),
                0x80.. => {
                    let ch = self.peek_char().unwrap_or_default();
                    if is_bidi(ch) {
                        return Err(self.fail(bidi_message(ch)));
                    }
                    self.pos += ch.len_utf8();
                }
                _ => self.pos += 1,
            }
        }
        out.push_str(&self.src[chunk..self.pos]);
        self.pos += 1; // "
        self.check_string_length(out, open)
    }

    /// At a backslash: consumes the escape and returns its character.
    fn escape(&mut self) -> R<char> {
        let start = self.pos;
        let e = self.at(1);
        self.pos += 2;
        Ok(match e {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                let bad = || Error::at(self.src, start, "invalid unicode escape: expected \\u{1-6 hex digits}");
                if self.peek() != Some(b'{') {
                    return Err(bad());
                }
                let digits = self.b[self.pos + 1..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
                if !(1..=6).contains(&digits) || self.b.get(self.pos + 1 + digits) != Some(&b'}') {
                    return Err(bad());
                }
                let hex = &self.src[self.pos + 1..self.pos + 1 + digits];
                let Some(c) = char::from_u32(u32::from_str_radix(hex, 16).unwrap_or(u32::MAX)) else {
                    return Err(self.fail_at(start, format!("\\u{{{hex}}} is not a Unicode scalar value")));
                };
                self.pos += digits + 2;
                c
            }
            _ => {
                let e = self.src[start + 1..].chars().next().map(String::from).unwrap_or_default();
                return Err(self.fail_at(start, format!("invalid escape '\\{e}'")));
            }
        })
    }

    fn block_string(&mut self) -> R<String> {
        let open = self.pos;
        self.pos += 3;
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        if self.b[self.pos..].starts_with(b"\r\n") {
            self.pos += 2;
        } else if self.peek() == Some(b'\n') {
            self.pos += 1;
        } else {
            let at = if self.eof() { open } else { self.pos };
            return Err(self.fail_at(at, "opening \"\"\" must be followed by a line break"));
        }

        // Find the closing """, skipping escaped characters.
        let content = self.pos;
        let mut close = None;
        let mut i = content;
        while i < self.b.len() {
            match self.b[i] {
                b'\\' => i += 1,
                b'"' if self.b[i..].starts_with(b"\"\"\"") => {
                    close = Some(i);
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        let Some(close) = close else { return Err(self.fail_at(open, "unterminated block string")) };

        // Lines, with where each starts.
        let mut lines: Vec<(usize, &str)> = Vec::new();
        let mut at = content;
        loop {
            match self.src[at..close].find('\n') {
                None => {
                    lines.push((at, &self.src[at..close]));
                    break;
                }
                Some(n) => {
                    let nl = at + n;
                    let end = if nl > at && self.b[nl - 1] == b'\r' { nl - 1 } else { nl };
                    lines.push((at, &self.src[at..end]));
                    at = nl + 1;
                }
            }
        }
        let (_, indent) = lines.pop().unwrap_or_default();
        if !is_blank(indent) {
            return Err(self.fail_at(close, "closing \"\"\" must be on its own line"));
        }

        let mut out = Vec::with_capacity(lines.len());
        for (at, text) in lines {
            if let Some(rest) = text.strip_prefix(indent) {
                out.push(self.block_line(rest, at + indent.len())?);
            } else if is_blank(text) {
                out.push(String::new());
            } else {
                return Err(self.fail_at(at, "line is indented less than the closing \"\"\""));
            }
        }
        self.pos = close + 3;
        self.check_string_length(out.join("\n"), open)
    }

    /// Escapes in one block-string line, which starts at `at` in the source.
    fn block_line(&mut self, text: &str, at: usize) -> R<String> {
        let mut out = String::new();
        let saved = self.pos;
        let (mut i, mut chunk) = (0, 0);
        while i < text.len() {
            let c = text.as_bytes()[i];
            if c == b'\\' {
                out.push_str(&text[chunk..i]);
                self.pos = at + i;
                out.push(self.escape()?);
                i = self.pos - at;
                chunk = i;
            } else if c < 0x20 && c != b'\t' {
                return Err(self.fail_at(at + i, "control character in block string"));
            } else if c >= 0x80 {
                let ch = text[i..].chars().next().unwrap_or_default();
                if is_bidi(ch) {
                    return Err(self.fail_at(at + i, bidi_message(ch)));
                }
                i += ch.len_utf8();
            } else {
                i += 1;
            }
        }
        self.pos = saved;
        out.push_str(&text[chunk..]);
        Ok(out)
    }

    fn check_string_length(&self, s: String, open: usize) -> R<String> {
        // Bytes bound code points from above: count only when it could matter.
        if s.len() > self.limits.max_string_length && s.chars().count() > self.limits.max_string_length {
            return Err(self.fail_at(open, format!("string longer than {} characters", self.limits.max_string_length)));
        }
        Ok(s)
    }

    // ── trivia & helpers ───────────────────────────────────────

    fn trivia(&mut self) -> R<()> {
        loop {
            match (self.peek(), self.at(1)) {
                (Some(b' ' | b'\t' | b'\n'), _) => self.pos += 1,
                (Some(b'\r'), Some(b'\n')) => self.pos += 2,
                (Some(b'\r'), _) => return Err(self.fail("carriage return without a line feed (line breaks are LF or CRLF)")),
                (Some(b'/'), Some(b'/')) => {
                    let end = self.src[self.pos..].find('\n').map_or(self.b.len(), |n| self.pos + n);
                    self.check_comment(self.pos, end)?;
                    self.pos = end;
                }
                (Some(b'/'), Some(b'*')) => self.block_comment()?,
                (Some(b'/'), _) => return Err(self.fail("unexpected '/' (comments are // or /* */)")),
                _ => return Ok(()),
            }
        }
    }

    fn block_comment(&mut self) -> R<()> {
        let open = self.pos;
        let mut depth = 0;
        while self.pos < self.b.len() {
            let rest = &self.b[self.pos..];
            if rest.starts_with(b"/*") {
                depth += 1;
                self.pos += 2;
            } else if rest.starts_with(b"*/") {
                self.pos += 2;
                depth -= 1;
                if depth == 0 {
                    return self.check_comment(open, self.pos);
                }
            } else {
                self.pos += 1;
            }
        }
        Err(self.fail_at(open, "unterminated block comment"))
    }

    /// Comments are where "Trojan Source" attacks hide reordered text.
    fn check_comment(&self, start: usize, end: usize) -> R<()> {
        match self.src[start..end].char_indices().find(|&(_, c)| is_bidi(c)) {
            Some((i, c)) => {
                Err(self
                    .fail_at(start + i, format!("raw bidirectional control character U+{:04X} in comment", c as u32)))
            }
            None => Ok(()),
        }
    }

    fn ident(&mut self) -> &'a str {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if is_ident(c)) {
            self.pos += 1;
        }
        &self.src[start..self.pos]
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }
    fn at(&self, n: usize) -> Option<u8> {
        self.b.get(self.pos + n).copied()
    }
    fn peek_char(&self) -> Option<char> {
        self.src.get(self.pos..).and_then(|s| s.chars().next())
    }
    fn eof(&self) -> bool {
        self.pos >= self.b.len()
    }

    fn expect(&mut self, c: u8, message: &str) -> R<()> {
        if self.peek() != Some(c) {
            return Err(self.fail(format!("{message}, found {}", describe(self.peek_char()))));
        }
        self.pos += 1;
        Ok(())
    }

    fn fail(&self, reason: impl Into<String>) -> Error {
        Error::at(self.src, self.pos, reason)
    }
    fn fail_at(&self, at: usize, reason: impl Into<String>) -> Error {
        Error::at(self.src, at, reason)
    }
}

fn bidi_message(c: char) -> String {
    let code = c as u32;
    format!("raw bidirectional control character U+{code:04X} (write it as \\u{{{code:04X}}})")
}

/// The exponent digits of a decimal literal with an exponent
/// (`-?(0|[1-9][0-9_]*)(\.[0-9_]+)?[eE][+-]?[0-9_]+`), or None.
fn decimal_exponent(s: &str) -> Option<&str> {
    let s = s.strip_prefix('-').unwrap_or(s);
    let e = s.find(['e', 'E'])?;
    let (mantissa, exp) = (&s[..e], &s[e + 1..]);
    let (int, frac) = match mantissa.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (mantissa, None),
    };
    let digits_ = |t: &str| !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit() || c == b'_');
    let int_ok = int == "0" || (int.starts_with(|c: char| ('1'..='9').contains(&c)) && digits_(int));
    let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
    (int_ok && frac.is_none_or(digits_) && digits_(exp)).then_some(exp)
}

/// Digits in base 2 or 16 as a decimal integer string.
fn to_decimal(digits: &[u8], radix: u32) -> String {
    // Little-endian limbs of base 10^9.
    let mut limbs: Vec<u64> = vec![0];
    for &d in digits {
        let mut carry = u64::from((d as char).to_digit(radix).unwrap_or(0));
        for limb in &mut limbs {
            let v = *limb * u64::from(radix) + carry;
            *limb = v % 1_000_000_000;
            carry = v / 1_000_000_000;
        }
        if carry > 0 {
            limbs.push(carry);
        }
    }
    // The most significant limb as is, the others padded to 9 digits.
    let first = limbs.last().copied().unwrap_or(0).to_string();
    limbs.iter().rev().skip(1).fold(first, |mut out, limb| {
        let _ = write!(out, "{limb:09}");
        out
    })
}
