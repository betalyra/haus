//! Schema files (`.schema.haus`): syntax tree and parser, following
//! spec/grammar.ebnf. Parsing builds the tree; [`check`] then reports what
//! the grammar allows but the spec doesn't (duplicates, `closed < >`,
//! attributes with the wrong arguments), and [`expand`] copies spread types
//! in (`< ...UserEvent | Ping >`), so the generators only ever see plain
//! records and variants.

use haus::Value;
use std::collections::{HashMap, HashSet};
use std::fmt;
use winnow::ascii::{multispace1, till_line_ending};
use winnow::combinator::{alt, cut_err, delimited, eof, fail, not, opt, peek, preceded, repeat, separated, terminated};
use winnow::error::{ContextError, ErrMode, ModalResult, StrContext, StrContextValue};
use winnow::prelude::*;
use winnow::stream::{LocatingSlice, Location};
use winnow::token::{any, literal, none_of, one_of, take_while};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub reason: String,
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.column, self.reason)
    }
}

impl std::error::Error for Error {}

/// An error at byte offset `pos` of `text`.
pub fn error(text: &str, pos: usize, reason: impl Into<String>) -> Error {
    let before = &text[..pos.min(text.len())];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    Error { reason: reason.into(), line, column }
}

// ── syntax tree ──────────────────────────────────────────────

/// The prelude (spec §14): built-in types and their number of parameters.
/// A schema can't redefine them.
pub const PRELUDE: &[(&str, usize)] = &[
    ("Bool", 0),
    ("Maybe", 1),
    ("Result", 2),
    ("String", 0),
    ("Bytes", 0),
    ("Array", 1),
    ("Map", 1),
    ("Int", 0),
    ("Int8", 0),
    ("Int16", 0),
    ("Int32", 0),
    ("Int64", 0),
    ("UInt8", 0),
    ("UInt16", 0),
    ("UInt32", 0),
    ("UInt64", 0),
    ("Float32", 0),
    ("Float64", 0),
    ("Decimal", 0),
    ("Any", 0),
    ("Secret", 1),
    ("Stream", 1),
];

#[derive(Debug, Clone)]
pub struct File {
    pub imports: Vec<Import>,
    pub types: Vec<TypeDef>,
    /// What is allowed but probably not meant: unknown attributes, uses of deprecated types.
    pub warnings: Vec<Error>,
}

#[derive(Debug, Clone)]
pub struct Import {
    pub module: String,
    pub names: Vec<(String, usize)>,
    pub pos: usize,
}

#[derive(Debug, Clone)]
pub struct TypeDef {
    pub name: String,
    pub params: Vec<String>,
    pub ty: Ty,
    pub pos: usize,
    /// The `//` lines directly above.
    pub doc: String,
    pub attrs: Vec<Attribute>,
}

/// `@deprecated("use email")`: information for tools, never for decoding (spec §14).
#[derive(Debug, Clone)]
pub struct Attribute {
    pub name: String,
    /// The arguments (none without parentheses), or what is wrong with them.
    pub args: Result<Vec<Value>, Fail>,
    pub pos: usize,
}

/// The attributes this version of haus defines (spec §14).
const DEFINED_ATTRIBUTES: &[&str] = &["deprecated"];

/// Whether `attrs` mark something deprecated, and the message if there is one.
pub fn deprecation(attrs: &[Attribute]) -> Option<Option<&str>> {
    attrs.iter().find(|a| a.name == "deprecated").map(|a| match a.args.as_deref() {
        Ok([Value::String(why)]) => Some(why.as_str()),
        _ => None,
    })
}

#[derive(Debug, Clone)]
pub enum Ty {
    /// A named type, applied to arguments: `Array Point`, `Int`.
    Name { name: String, args: Vec<Ty>, pos: usize },
    /// A type parameter: `a`.
    Param { name: String, pos: usize },
    Record {
        closed: bool,
        fields: Vec<Field>,
        /// `...Name`; empty once the file is expanded.
        spreads: Vec<Spread>,
        pos: usize,
    },
    Variant {
        closed: bool,
        cases: Vec<Case>,
        /// `...Name`; empty once the file is expanded.
        spreads: Vec<Spread>,
        pos: usize,
    },
}

/// `...Name`: the fields or tags of the named type, copied in where it is
/// written. `at` is how many own fields or cases come before it.
#[derive(Debug, Clone)]
pub struct Spread {
    pub name: String,
    pub at: usize,
    pub pos: usize,
    /// Attributes written before it, which [`check`] rejects.
    pub attrs: Vec<Attribute>,
}

impl Ty {
    pub fn pos(&self) -> usize {
        match self {
            Ty::Name { pos, .. } | Ty::Param { pos, .. } | Ty::Record { pos, .. } | Ty::Variant { pos, .. } => *pos,
        }
    }
}

/// As written in a schema, for messages: `Array (Maybe Int)`, `{ … }`.
impl fmt::Display for Ty {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Ty::Name { name, args, .. } => {
                f.write_str(name)?;
                args.iter().try_for_each(|a| match a {
                    Ty::Name { args, .. } if !args.is_empty() => write!(f, " ({a})"),
                    _ => write!(f, " {a}"),
                })
            }
            Ty::Param { name, .. } => f.write_str(name),
            Ty::Record { closed, .. } => f.write_str(if *closed { "closed { … }" } else { "{ … }" }),
            Ty::Variant { closed, .. } => f.write_str(if *closed { "closed < … >" } else { "< … >" }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Field {
    pub key: String,
    pub optional: bool,
    pub ty: Ty,
    pub pos: usize,
    pub attrs: Vec<Attribute>,
}

#[derive(Debug, Clone)]
pub struct Case {
    pub tag: String,
    /// `Tag A B`: positional; `Tag { … }`: one record.
    pub payload: Vec<Ty>,
    pub pos: usize,
    pub attrs: Vec<Attribute>,
}

/// Parse and check a schema file.
pub fn parse(text: &str) -> Result<File, Error> {
    let file = file.parse(LocatingSlice::new(text)).map_err(|e| {
        let expected = e.inner().context().find_map(|c| match c {
            StrContext::Expected(StrContextValue::Description(d)) => Some(d.to_string()),
            StrContext::Expected(StrContextValue::StringLiteral(s)) => Some(format!("'{s}'")),
            _ => None,
        });
        let found = found(&text[e.offset()..]);
        error(
            text,
            e.offset(),
            expected.map_or_else(|| format!("unexpected {found}"), |what| format!("expected {what}, found {found}")),
        )
    })?;
    let at = |(pos, reason): Fail| error(text, pos, reason);
    let mut warnings = check(&file).map_err(at)?;
    // Before spreads are copied in, so each use is reported once, where it is written.
    warnings.extend(deprecated_uses(&file));
    let file = expand(file).map_err(at)?;
    guarded(&file).map_err(at)?;
    warnings.sort_by_key(|(pos, _)| *pos);
    let types = file
        .types
        .into_iter()
        .map(|d| TypeDef { doc: doc_comment(text, d.attrs.first().map_or(d.pos, |a| a.pos)), ..d })
        .collect();
    Ok(File { types, warnings: warnings.into_iter().map(at).collect(), ..file })
}

/// The same file without its attributes: they never change decoding (spec §15).
pub fn without_attributes(file: File) -> File {
    fn ty(t: &mut Ty) {
        match t {
            Ty::Name { args, .. } => args.iter_mut().for_each(ty),
            Ty::Param { .. } => {}
            Ty::Record { fields, .. } => fields.iter_mut().for_each(|f| {
                f.attrs.clear();
                ty(&mut f.ty);
            }),
            Ty::Variant { cases, .. } => cases.iter_mut().for_each(|c| {
                c.attrs.clear();
                c.payload.iter_mut().for_each(ty);
            }),
        }
    }
    let types = file
        .types
        .into_iter()
        .map(|mut d| {
            d.attrs.clear();
            ty(&mut d.ty);
            d
        })
        .collect();
    File { types, warnings: vec![], ..file }
}

/// What the parser stopped at, for messages.
fn found(rest: &str) -> String {
    let word = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
    match rest.chars().next() {
        None => "end of file".into(),
        Some(_) if word > 0 => format!("'{}'", &rest[..word]),
        Some(c) => format!("{c:?}"),
    }
}

// ── grammar ──────────────────────────────────────────────────

type Input<'a> = LocatingSlice<&'a str>;
type E = ErrMode<ContextError>;

const KEYWORDS: [&str; 3] = ["type", "import", "closed"];

fn expected(what: &'static str) -> StrContext {
    StrContext::Expected(StrContextValue::Description(what))
}

/// Whitespace and comments (`//`, nested `/* */`).
fn ws(i: &mut Input) -> ModalResult<()> {
    repeat(0.., alt((multispace1.void(), ("//", till_line_ending).void(), block_comment))).parse_next(i)
}

fn block_comment(i: &mut Input) -> ModalResult<()> {
    let inner = alt((block_comment, (not(alt(("/*", "*/"))), any).void()));
    ("/*", cut_err((repeat(0.., inner).map(|()| ()), "*/").context(expected("*/ closing the comment"))))
        .void()
        .parse_next(i)
}

/// `p`, then whitespace.
fn token<'a, O>(p: impl Parser<Input<'a>, O, E>) -> impl Parser<Input<'a>, O, E> {
    terminated(p, ws)
}

fn sym<'a>(s: &'static str) -> impl Parser<Input<'a>, &'a str, E> {
    token(literal(s)).context(StrContext::Expected(StrContextValue::StringLiteral(s)))
}

fn keyword<'a>(w: &'static str) -> impl Parser<Input<'a>, (), E> {
    token(terminated(literal(w), not(one_of(|c: char| c.is_ascii_alphanumeric() || c == '_')))).void()
}

fn pos(i: &mut Input) -> ModalResult<usize> {
    Ok(i.current_token_start())
}

fn word<'a>(first: fn(char) -> bool) -> impl Parser<Input<'a>, String, E> {
    token((one_of(first), take_while(0.., |c: char| c.is_ascii_alphanumeric() || c == '_')).take().map(str::to_owned))
}

/// A type name or tag: `Money`.
fn upper(i: &mut Input) -> ModalResult<String> {
    word(|c| c.is_ascii_uppercase()).context(expected("a type name")).parse_next(i)
}

/// A lower-case word, keywords included (record keys may be `type`).
fn lower(i: &mut Input) -> ModalResult<String> {
    word(|c| c.is_ascii_lowercase() || c == '_').parse_next(i)
}

/// A type parameter: a lower-case word that isn't a keyword.
fn param(i: &mut Input) -> ModalResult<String> {
    lower.verify(|w: &String| !KEYWORDS.contains(&w.as_str())).context(expected("a type parameter")).parse_next(i)
}

fn string(i: &mut Input) -> ModalResult<String> {
    let escape = preceded('\\', alt(('"'.value('"'), '\\'.value('\\'), 'n'.value('\n'), 't'.value('\t'))));
    token(delimited(
        '"',
        repeat(0.., alt((none_of(['"', '\\', '\n']), escape))),
        cut_err('"').context(StrContext::Expected(StrContextValue::CharLiteral('"'))),
    ))
    .parse_next(i)
}

fn file(i: &mut Input) -> ModalResult<File> {
    enum Item {
        Import(Import),
        Type(TypeDef),
    }
    let item = alt((import.map(Item::Import), typedef.map(Item::Type))).context(expected("'type' or 'import'"));
    let items: Vec<Item> =
        delimited(ws, repeat(0.., item), eof.context(expected("'type' or 'import'"))).parse_next(i)?;
    let (imports, types) = items.into_iter().fold((vec![], vec![]), |(mut imports, mut types), item| {
        match item {
            Item::Import(imp) => imports.push(imp),
            Item::Type(def) => types.push(def),
        }
        (imports, types)
    });
    Ok(File { imports, types, warnings: vec![] })
}

fn import(i: &mut Input) -> ModalResult<Import> {
    let module = alt((
        preceded("std/", lower).map(|m| format!("std/{m}")),
        token(
            (one_of(['@', '.']), take_while(1.., |c: char| c.is_ascii_alphanumeric() || "_.-/@".contains(c)))
                .take()
                .map(str::to_owned),
        ),
    ))
    .context(expected("a module (std/time, @org/name, ./file)"));
    let names = separated(1.., (pos, upper).map(|(p, n)| (n, p)), sym(","));
    let (pos, (module, names)) =
        (pos, preceded(keyword("import"), cut_err((module, delimited(sym("("), names, (opt(sym(",")), sym(")")))))))
            .parse_next(i)?;
    Ok(Import { module, names, pos })
}

fn typedef(i: &mut Input) -> ModalResult<TypeDef> {
    let (attrs, (pos, name, params, ty)) = attributed(
        "'type' after the attributes",
        preceded(keyword("type"), cut_err((pos, upper, repeat(0.., param), preceded(sym("="), ty)))),
    )
    .parse_next(i)?;
    // The doc comment is filled in by `parse`, which has the whole text.
    Ok(TypeDef { name, params, ty, pos, doc: String::new(), attrs })
}

/// `@name` or `@name(value, …)`, then whitespace. The arguments are haus
/// values, read by the data parser; what is wrong with them is reported by
/// [`check`].
fn attribute(i: &mut Input) -> ModalResult<Attribute> {
    let pos = i.current_token_start();
    let name = (
        one_of(|c: char| c.is_ascii_lowercase() || c == '_'),
        take_while(0.., |c: char| c.is_ascii_alphanumeric() || c == '_'),
    )
        .take()
        .map(str::to_owned)
        .context(expected("an attribute name after '@': @deprecated"));
    let name = preceded('@', cut_err(name)).parse_next(i)?;
    let rest: &str = i;
    let args = if rest.starts_with('(') {
        let Some(close) = closing_paren(rest) else {
            return cut_err(fail.context(expected("')' closing the attribute's arguments"))).parse_next(i);
        };
        let start = i.current_token_start() + 1;
        let inner = &rest[1..close];
        let _ = i.next_slice(close + 1);
        match haus::parse(inner) {
            Ok(args) if args.is_empty() => Err((start - 1, format!("empty parentheses: write @{name} without them"))),
            Ok(args) => Ok(args),
            Err(e) => Err((start + e.offset, format!("in the arguments of @{name}: {}", e.reason))),
        }
    } else {
        // `@deprecated ("x")` would be an attribute without arguments, then `("x")`.
        let before = i.checkpoint();
        ws.parse_next(i)?;
        if i.starts_with('(') {
            i.reset(&before);
            return cut_err(fail.context(expected("'(' right after the attribute's name, without a space")))
                .parse_next(i);
        }
        Ok(vec![])
    };
    ws.parse_next(i)?;
    Ok(Attribute { name, args, pos })
}

/// The attributes before `p`, and `p`, which must follow if there are any
/// (`what`, for the message if it doesn't).
fn attributed<'a, O>(
    what: &'static str,
    mut p: impl Parser<Input<'a>, O, E>,
) -> impl Parser<Input<'a>, (Vec<Attribute>, O), E> {
    move |i: &mut Input<'a>| {
        let attrs: Vec<Attribute> = repeat(0.., attribute).parse_next(i)?;
        if attrs.is_empty() {
            return Ok((attrs, p.parse_next(i)?));
        }
        let start = i.checkpoint();
        match p.parse_next(i) {
            Ok(x) => Ok((attrs, x)),
            // Nothing of `p` was read: say what should have come.
            Err(ErrMode::Backtrack(_)) => {
                i.reset(&start);
                cut_err(fail.context(expected(what))).parse_next(i)
            }
            Err(e) => Err(e.cut()),
        }
    }
}

/// Where the `)` matching the `(` that `s` starts with is, skipping strings,
/// comments and nested brackets.
///
/// Everything it looks for is ASCII, and in UTF-8 an ASCII byte is never part
/// of another character, so it scans bytes and never slices the text.
fn closing_paren(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while let Some(&c) = b.get(i) {
        i = match c {
            b'(' | b'[' | b'{' => {
                depth += 1;
                i + 1
            }
            b')' | b']' | b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return (c == b')').then_some(i);
                }
                i + 1
            }
            b'"' if b[i..].starts_with(b"\"\"\"") => after_block_string(b, i + 3)?,
            b'"' => after_string(b, i + 1),
            b'/' if b[i..].starts_with(b"//") => i + b[i..].iter().position(|&c| c == b'\n')?,
            b'/' if b[i..].starts_with(b"/*") => after_block_comment(b, i)?,
            _ => i + 1,
        };
    }
    None
}

/// After the `"` that ends the string whose text starts at `i` (or the line
/// break or end where it stops, unterminated: the data parser reports that).
fn after_string(b: &[u8], mut i: usize) -> usize {
    while let Some(&c) = b.get(i) {
        match c {
            b'\\' => i += 2,
            b'"' | b'\n' => return i + 1,
            _ => i += 1,
        }
    }
    i
}

/// After the `"""` that ends the block string whose text starts at `i`.
fn after_block_string(b: &[u8], mut i: usize) -> Option<usize> {
    loop {
        match b.get(i)? {
            b'\\' => i += 2,
            b'"' if b[i..].starts_with(b"\"\"\"") => return Some(i + 3),
            _ => i += 1,
        }
    }
}

/// After the `*/` that ends the (nested) block comment starting at `i`.
fn after_block_comment(b: &[u8], mut i: usize) -> Option<usize> {
    let mut nested = 0usize;
    loop {
        let rest = b.get(i..)?;
        if rest.starts_with(b"/*") {
            nested += 1;
            i += 2;
        } else if rest.starts_with(b"*/") {
            nested -= 1;
            i += 2;
            if nested == 0 {
                return Some(i);
            }
        } else if rest.is_empty() {
            return None;
        } else {
            i += 1;
        }
    }
}

/// `Name atom+ | atom`.
fn ty(i: &mut Input) -> ModalResult<Ty> {
    alt(((pos, upper, repeat(0.., atom)).map(|(pos, name, args)| Ty::Name { name, args, pos }), atom)).parse_next(i)
}

fn atom(i: &mut Input) -> ModalResult<Ty> {
    alt((
        (pos, upper).map(|(pos, name)| Ty::Name { name, args: vec![], pos }),
        preceded(
            keyword("closed"),
            cut_err(preceded(
                peek(one_of(['{', '<'])).context(expected("'{' or '<' after closed")),
                alt((record(true), variant(true))),
            )),
        ),
        (pos, param).map(|(pos, name)| Ty::Param { name, pos }),
        delimited(sym("("), cut_err(ty), cut_err(sym(")"))),
        record(false),
        variant(false),
    ))
    .context(expected("a type"))
    .parse_next(i)
}

/// One entry of a record or variant: its own field or case, or a spread.
enum Member<T> {
    Own(T),
    Spread(String, usize),
}

/// `...Name`, after which [`check`] rejects a lower-case `...r`.
fn spread<T>(i: &mut Input) -> ModalResult<Member<T>> {
    let name = word(|c| c.is_ascii_alphabetic() || c == '_').context(expected("a type name after '...': ...UserEvent"));
    preceded(sym("..."), cut_err((pos, name))).map(|(pos, name)| Member::Spread(name, pos)).parse_next(i)
}

/// Own entries and spreads, each spread remembering how many entries came before it.
/// `with` gives an own entry its attributes.
fn split<T>(members: Vec<(Vec<Attribute>, Member<T>)>, with: impl Fn(T, Vec<Attribute>) -> T) -> (Vec<T>, Vec<Spread>) {
    members.into_iter().fold((vec![], vec![]), |(mut own, mut spreads), (attrs, m)| {
        match m {
            Member::Own(x) => own.push(with(x, attrs)),
            Member::Spread(name, pos) => spreads.push(Spread { name, at: own.len(), pos, attrs }),
        }
        (own, spreads)
    })
}

fn record<'a>(closed: bool) -> impl Parser<Input<'a>, Ty, E> {
    let key = alt((lower, string)).context(expected("a field name"));
    let field = (pos, key, cut_err((opt(sym("?")), preceded(sym(":"), ty)))).map(|(pos, key, (optional, ty))| {
        Member::Own(Field { key, optional: optional.is_some(), ty, pos, attrs: vec![] })
    });
    let body = terminated(
        separated(0.., attributed("a field after the attributes", alt((spread, field))), sym(",")),
        opt(sym(",")),
    );
    (pos, preceded(sym("{"), cut_err(terminated(body, sym("}"))))).map(move |(pos, members)| {
        let (fields, spreads) = split(members, |f, attrs| Field { attrs, ..f });
        Ty::Record { closed, fields, spreads, pos }
    })
}

fn variant<'a>(closed: bool) -> impl Parser<Input<'a>, Ty, E> {
    let case = (pos, upper, repeat(0.., atom))
        .map(|(pos, tag, payload)| Member::Own(Case { tag, payload, pos, attrs: vec![] }));
    let body = preceded(
        opt(sym("|")),
        separated(0.., attributed("a tag after the attributes", alt((spread, case))), sym("|")),
    );
    (pos, preceded(sym("<"), cut_err(terminated(body, sym(">"))))).map(move |(pos, members)| {
        let (cases, spreads) = split(members, |c, attrs| Case { attrs, ..c });
        Ty::Variant { closed, cases, spreads, pos }
    })
}

/// The `//` lines directly above the line of `pos` (no blank line in between).
fn doc_comment(text: &str, pos: usize) -> String {
    let before = &text[..pos];
    let lines: Vec<&str> = before
        .lines()
        .rev()
        .skip(usize::from(!before.ends_with('\n')))
        .map_while(|l| l.trim().strip_prefix("//").map(|l| l.strip_prefix(' ').unwrap_or(l)))
        .collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

// ── checks ───────────────────────────────────────────────────

/// What the grammar allows but the spec doesn't (§14): types defined twice
/// or named like a prelude type, duplicate fields and tags, `closed < >`,
/// row parameters (`...r`), and attributes with arguments they don't take,
/// twice on one thing, or on a spread. Returns the warnings: unknown attributes.
fn check(file: &File) -> Result<Vec<Fail>, Fail> {
    fn first_duplicate<'a>(mut names: impl Iterator<Item = (&'a str, usize)>) -> Option<(&'a str, usize)> {
        let mut seen = HashSet::new();
        names.find(|(n, _)| !seen.insert(*n))
    }
    if let Some((name, pos)) = first_duplicate(file.types.iter().map(|d| (d.name.as_str(), d.pos))) {
        return Err((pos, format!("{name} is defined twice")));
    }
    if let Some(d) = file.types.iter().find(|d| PRELUDE.iter().any(|(n, _)| *n == d.name)) {
        return Err((d.pos, format!("{} is a prelude type and can't be redefined", d.name)));
    }
    fn ty(t: &Ty) -> Result<(), (usize, String)> {
        let rows = match t {
            Ty::Record { spreads, .. } | Ty::Variant { spreads, .. } => spreads.as_slice(),
            _ => &[],
        };
        if let Some(s) = rows.iter().find(|s| !s.name.starts_with(|c: char| c.is_ascii_uppercase())) {
            return Err((
                s.pos,
                format!("row parameters (...{}) aren't supported; spread a named type instead: ...UserEvent", s.name),
            ));
        }
        if let Some((s, a)) = rows.iter().find_map(|s| s.attrs.first().map(|a| (s, a))) {
            return Err((
                a.pos,
                format!("a spread can't have attributes; the fields or tags of {} keep their own", s.name),
            ));
        }
        match t {
            Ty::Name { args, .. } => args.iter().try_for_each(ty),
            Ty::Param { .. } => Ok(()),
            Ty::Record { fields, .. } => match first_duplicate(fields.iter().map(|f| (f.key.as_str(), f.pos))) {
                Some((key, pos)) => Err((pos, format!("duplicate field {key}"))),
                None => fields.iter().try_for_each(|f| ty(&f.ty)),
            },
            Ty::Variant { closed: true, cases, spreads, pos } if cases.is_empty() && spreads.is_empty() => {
                Err((*pos, "a closed variant needs at least one tag".into()))
            }
            Ty::Variant { cases, .. } => match first_duplicate(cases.iter().map(|c| (c.tag.as_str(), c.pos))) {
                Some((tag, pos)) => Err((pos, format!("duplicate tag {tag}"))),
                None => cases.iter().flat_map(|c| &c.payload).try_for_each(ty),
            },
        }
    }
    file.types.iter().try_for_each(|d| ty(&d.ty))?;
    let warnings = attribute_lists(file).into_iter().map(attributes).collect::<Result<Vec<_>, _>>()?;
    Ok(warnings.concat())
}

/// Every list of attributes in a file: of its types, fields and tags.
fn attribute_lists(file: &File) -> Vec<&[Attribute]> {
    fn ty<'a>(t: &'a Ty, out: &mut Vec<&'a [Attribute]>) {
        match t {
            Ty::Name { args, .. } => args.iter().for_each(|a| ty(a, out)),
            Ty::Param { .. } => {}
            Ty::Record { fields, .. } => fields.iter().for_each(|f| {
                out.push(&f.attrs);
                ty(&f.ty, out);
            }),
            Ty::Variant { cases, .. } => cases.iter().for_each(|c| {
                out.push(&c.attrs);
                c.payload.iter().for_each(|p| ty(p, out));
            }),
        }
    }
    let mut out = vec![];
    for d in &file.types {
        out.push(d.attrs.as_slice());
        ty(&d.ty, &mut out);
    }
    out
}

/// The attributes of one type, field or tag: defined ones with the right
/// arguments, once each. Unknown ones are accepted with a warning, which this
/// returns: they may come from a later version of haus (spec §14).
fn attributes(attrs: &[Attribute]) -> Result<Vec<Fail>, Fail> {
    let mut warnings = vec![];
    for (i, a) in attrs.iter().enumerate() {
        let args = a.args.as_ref().map_err(Clone::clone)?;
        if !DEFINED_ATTRIBUTES.contains(&a.name.as_str()) {
            warnings.push((a.pos, format!("unknown attribute @{}: this version of haus ignores it", a.name)));
            continue;
        }
        if attrs[..i].iter().any(|b| b.name == a.name) {
            return Err((a.pos, format!("@{} is written twice here", a.name)));
        }
        if a.name == "deprecated" && !matches!(args.as_slice(), [] | [Value::String(_)]) {
            return Err((a.pos, "@deprecated takes at most one argument, a string: @deprecated(\"use email\")".into()));
        }
    }
    Ok(warnings)
}

/// Every cycle of definitions consumes input (spec §9.9): `type A = B`,
/// `type B = A` would apply a type to the same value again and again. A
/// definition reaches another without consuming input if its whole type is
/// that one, or a `Secret` of it, or an argument a generic type passes through
/// (`type Id a = a`).
fn guarded(file: &File) -> Result<(), Fail> {
    let defs: HashMap<&str, &TypeDef> = file.types.iter().map(|d| (d.name.as_str(), d)).collect();
    // The parameters a definition's whole type may be (`type Id a = a`, `type S a = Secret a`).
    fn passes<'a>(def: &'a TypeDef, defs: &HashMap<&str, &'a TypeDef>, busy: &mut Vec<&'a str>) -> Vec<usize> {
        if busy.contains(&def.name.as_str()) {
            return vec![];
        }
        busy.push(&def.name);
        let mut out = vec![];
        let mut names = vec![];
        reaches(&def.ty, defs, busy, &mut names, &mut out, &def.params);
        busy.pop();
        out
    }
    /// The definitions `t` reaches without consuming input, and the parameters (by index) it may be.
    fn reaches<'a>(
        t: &'a Ty,
        defs: &HashMap<&str, &'a TypeDef>,
        busy: &mut Vec<&'a str>,
        names: &mut Vec<&'a str>,
        params: &mut Vec<usize>,
        own: &[String],
    ) {
        match t {
            Ty::Name { name, args, .. } if name == "Secret" => {
                args.iter().for_each(|a| reaches(a, defs, busy, names, params, own));
            }
            Ty::Name { name, args, .. } => {
                if let Some(def) = defs.get(name.as_str()) {
                    names.push(&def.name);
                    for i in passes(def, defs, busy) {
                        if let Some(a) = args.get(i) {
                            reaches(a, defs, busy, names, params, own);
                        }
                    }
                }
            }
            Ty::Param { name, .. } => params.extend(own.iter().position(|p| p == name)),
            Ty::Record { .. } | Ty::Variant { .. } => {}
        }
    }
    let edges: HashMap<&str, Vec<&str>> = file
        .types
        .iter()
        .map(|d| {
            let mut names = vec![];
            reaches(&d.ty, &defs, &mut vec![], &mut names, &mut vec![], &d.params);
            (d.name.as_str(), names)
        })
        .collect();
    for d in &file.types {
        let (mut seen, mut todo) = (HashSet::new(), edges[d.name.as_str()].clone());
        while let Some(n) = todo.pop() {
            if n == d.name {
                return Err((
                    d.pos,
                    format!(
                        "{} refers to itself without a record field, array element or variant payload in between, \
                         so decoding it would never end",
                        d.name
                    ),
                ));
            }
            if seen.insert(n) {
                todo.extend(edges.get(n).into_iter().flatten());
            }
        }
    }
    Ok(())
}

/// Warnings for uses of deprecated types, outside deprecated types (spec §14),
/// in the file as written: a spread of a deprecated type (`...OldEvent`) is a
/// use, and a field or tag that is spread elsewhere is still one use.
fn deprecated_uses(file: &File) -> Vec<Fail> {
    fn walk(t: &Ty, f: &mut impl FnMut(&str, usize)) {
        match t {
            Ty::Name { name, args, pos } => {
                f(name, *pos);
                args.iter().for_each(|a| walk(a, f));
            }
            Ty::Param { .. } => {}
            Ty::Record { fields, spreads, .. } => {
                spreads.iter().for_each(|s| f(&s.name, s.pos));
                fields.iter().for_each(|x| walk(&x.ty, f));
            }
            Ty::Variant { cases, spreads, .. } => {
                spreads.iter().for_each(|s| f(&s.name, s.pos));
                cases.iter().flat_map(|c| &c.payload).for_each(|p| walk(p, f));
            }
        }
    }
    let deprecated: HashMap<&str, Option<&str>> =
        file.types.iter().filter_map(|d| deprecation(&d.attrs).map(|why| (d.name.as_str(), why))).collect();
    let mut out = vec![];
    for d in file.types.iter().filter(|d| !deprecated.contains_key(d.name.as_str())) {
        walk(&d.ty, &mut |name, pos| {
            if let Some(why) = deprecated.get(name) {
                out.push((
                    pos,
                    why.map_or(format!("{name} is deprecated"), |why| format!("{name} is deprecated: {why}")),
                ));
            }
        });
    }
    out
}

// ── spreads ──────────────────────────────────────────────────

/// What is wrong, at a byte offset.
pub type Fail = (usize, String);

/// Copies every `...Name` in: a variant gets the named variant's tags, a
/// record the named record's fields, in the place they are written. Whether
/// the result is open or closed stays its own (spec §14).
fn expand(file: File) -> Result<File, Fail> {
    let mut x = Expander {
        defs: file.types.iter().map(|d| (d.name.clone(), d.clone())).collect(),
        imported: file.imports.iter().flat_map(|i| i.names.iter().map(|(n, _)| n.clone())).collect(),
        done: HashMap::new(),
        busy: vec![],
    };
    let types =
        file.types.iter().map(|d| Ok(TypeDef { ty: x.ty(&d.ty)?, ..d.clone() })).collect::<Result<Vec<_>, Fail>>()?;
    Ok(File { types, ..file })
}

struct Expander {
    defs: HashMap<String, TypeDef>,
    imported: HashSet<String>,
    /// Bodies of definitions already expanded.
    done: HashMap<String, Ty>,
    /// Definitions being expanded, to catch a type that spreads itself.
    busy: Vec<String>,
}

impl Expander {
    fn ty(&mut self, t: &Ty) -> Result<Ty, Fail> {
        Ok(match t {
            Ty::Name { name, args, pos } => Ty::Name {
                name: name.clone(),
                args: args.iter().map(|a| self.ty(a)).collect::<Result<_, _>>()?,
                pos: *pos,
            },
            Ty::Param { .. } => t.clone(),
            Ty::Record { closed, fields, spreads, pos } => {
                let own = fields
                    .iter()
                    .map(|f| Ok((Field { ty: self.ty(&f.ty)?, ..f.clone() }, None)))
                    .collect::<Result<Vec<_>, Fail>>()?;
                let fields = self.merge(own, spreads, |x, s| match x.body(s)? {
                    Ty::Record { fields, .. } => Ok(fields),
                    _ => Err((s.pos, format!("{} is not a record, so it can't be spread here", s.name))),
                })?;
                if let Some((key, pos)) = duplicate(fields.iter().map(|(f, from)| (f.key.as_str(), f.pos, *from))) {
                    return Err((pos, format!("duplicate field {key}")));
                }
                Ty::Record {
                    closed: *closed,
                    fields: fields.into_iter().map(|(f, _)| f).collect(),
                    spreads: vec![],
                    pos: *pos,
                }
            }
            Ty::Variant { closed, cases, spreads, pos } => {
                let own = cases
                    .iter()
                    .map(|c| {
                        let payload = c.payload.iter().map(|p| self.ty(p)).collect::<Result<_, _>>()?;
                        Ok((Case { payload, ..c.clone() }, None))
                    })
                    .collect::<Result<Vec<_>, Fail>>()?;
                let cases = self.merge(own, spreads, |x, s| match x.body(s)? {
                    Ty::Variant { cases, .. } => Ok(cases),
                    _ => Err((s.pos, format!("{} is not a variant, so it can't be spread here", s.name))),
                })?;
                if let Some((tag, pos)) = duplicate(cases.iter().map(|(c, from)| (c.tag.as_str(), c.pos, *from))) {
                    return Err((pos, format!("duplicate tag {tag}")));
                }
                Ty::Variant {
                    closed: *closed,
                    cases: cases.into_iter().map(|(c, _)| c).collect(),
                    spreads: vec![],
                    pos: *pos,
                }
            }
        })
    }

    /// Own entries with each spread's entries inserted where it was written.
    /// Copied entries carry the spread's position, for error messages.
    fn merge<T: Clone>(
        &mut self,
        own: Vec<(T, Option<usize>)>,
        spreads: &[Spread],
        copied: impl Fn(&mut Self, &Spread) -> Result<Vec<T>, Fail>,
    ) -> Result<Vec<(T, Option<usize>)>, Fail> {
        let mut out = vec![];
        let n = own.len();
        for (i, entry) in own.into_iter().map(Some).chain([None]).enumerate() {
            for s in spreads.iter().filter(|s| s.at == i) {
                out.extend(copied(self, s)?.into_iter().map(|x| (x, Some(s.pos))));
            }
            if i < n {
                out.extend(entry);
            }
        }
        Ok(out)
    }

    /// The expanded body of the type a spread names, following aliases.
    fn body(&mut self, s: &Spread) -> Result<Ty, Fail> {
        let mut name = s.name.clone();
        loop {
            let Some(def) = self.defs.get(&name).cloned() else {
                let reason = if self.imported.contains(&name) {
                    format!("{name} is imported; haus-build can spread only types defined in this file so far")
                } else {
                    format!("unknown type {name}")
                };
                return Err((s.pos, reason));
            };
            if !def.params.is_empty() {
                let params = def.params.join(" ");
                return Err((
                    s.pos,
                    format!("{name} has parameters ({name} {params}); only a type without parameters can be spread"),
                ));
            }
            let body = match self.done.get(&name) {
                Some(t) => t.clone(),
                None => {
                    if self.busy.contains(&name) {
                        return Err((
                            def.pos,
                            format!("type {name} spreads itself (directly or through another type)"),
                        ));
                    }
                    self.busy.push(name.clone());
                    let t = self.ty(&def.ty)?;
                    self.busy.pop();
                    self.done.insert(name.clone(), t.clone());
                    t
                }
            };
            match body {
                Ty::Name { name: next, args, .. } if args.is_empty() && next != name => name = next,
                Ty::Name { name: stream, .. } if stream == "Stream" => {
                    return Err((s.pos, format!("{} is a Stream and can't be spread", s.name)));
                }
                other => return Ok(other),
            }
        }
    }
}

/// The first name that appears twice, at the later entry (or the spread that brought it).
fn duplicate<'a>(mut names: impl Iterator<Item = (&'a str, usize, Option<usize>)>) -> Option<(&'a str, usize)> {
    let mut seen = HashSet::new();
    names.find(|(n, _, _)| !seen.insert(*n)).map(|(n, pos, from)| (n, from.unwrap_or(pos)))
}
