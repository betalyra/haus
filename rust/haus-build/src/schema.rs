//! Schema files (`.schema.haus`): syntax tree and parser, following
//! spec/grammar.ebnf. Parsing builds the tree; [`check`] then reports what
//! the grammar allows but the spec doesn't (duplicates, `closed < >`), and
//! [`expand`] copies spread types in (`< ...UserEvent | Ping >`), so the
//! generators only ever see plain records and variants.

use std::collections::{HashMap, HashSet};
use std::fmt;
use winnow::ascii::{multispace1, till_line_ending};
use winnow::combinator::{alt, cut_err, delimited, eof, not, opt, peek, preceded, repeat, separated, terminated};
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

#[derive(Debug, Clone)]
pub struct File {
    pub imports: Vec<Import>,
    pub types: Vec<TypeDef>,
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
}

#[derive(Debug, Clone)]
pub enum Ty {
    /// A named type, applied to arguments: `Array Point`, `Int`.
    Name {
        name: String,
        args: Vec<Ty>,
        pos: usize,
    },
    /// A type parameter: `a`.
    Param {
        name: String,
        pos: usize,
    },
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
}

impl Ty {
    pub fn pos(&self) -> usize {
        match self {
            Ty::Name { pos, .. } | Ty::Param { pos, .. } | Ty::Record { pos, .. } | Ty::Variant { pos, .. } => *pos,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Field {
    pub key: String,
    pub optional: bool,
    pub ty: Ty,
    pub pos: usize,
}

#[derive(Debug, Clone)]
pub struct Case {
    pub tag: String,
    /// `Tag A B`: positional; `Tag { … }`: one record.
    pub payload: Vec<Ty>,
    pub pos: usize,
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
    check(&file).map_err(|(pos, reason)| error(text, pos, reason))?;
    let file = expand(file).map_err(|(pos, reason)| error(text, pos, reason))?;
    let types = file.types.into_iter().map(|d| TypeDef { doc: doc_comment(text, d.pos), ..d }).collect();
    Ok(File { types, ..file })
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
    Ok(File { imports, types })
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
    let (pos, name, params, ty) =
        preceded(keyword("type"), cut_err((pos, upper, repeat(0.., param), preceded(sym("="), ty)))).parse_next(i)?;
    // The doc comment is filled in by `parse`, which has the whole text.
    Ok(TypeDef { name, params, ty, pos, doc: String::new() })
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
fn split<T>(members: Vec<Member<T>>) -> (Vec<T>, Vec<Spread>) {
    members.into_iter().fold((vec![], vec![]), |(mut own, mut spreads), m| {
        match m {
            Member::Own(x) => own.push(x),
            Member::Spread(name, pos) => spreads.push(Spread { name, at: own.len(), pos }),
        }
        (own, spreads)
    })
}

fn record<'a>(closed: bool) -> impl Parser<Input<'a>, Ty, E> {
    let key = alt((lower, string)).context(expected("a field name"));
    let field = (pos, key, cut_err((opt(sym("?")), preceded(sym(":"), ty)))).map(|(pos, key, (optional, ty))| {
        Member::Own(Field { key, optional: optional.is_some(), ty, pos })
    });
    let body = terminated(separated(0.., alt((spread, field)), sym(",")), opt(sym(",")));
    (pos, preceded(sym("{"), cut_err(terminated(body, sym("}"))))).map(move |(pos, members)| {
        let (fields, spreads) = split(members);
        Ty::Record { closed, fields, spreads, pos }
    })
}

fn variant<'a>(closed: bool) -> impl Parser<Input<'a>, Ty, E> {
    let case = (pos, upper, repeat(0.., atom)).map(|(pos, tag, payload)| Member::Own(Case { tag, payload, pos }));
    let body = preceded(opt(sym("|")), separated(0.., alt((spread, case)), sym("|")));
    (pos, preceded(sym("<"), cut_err(terminated(body, sym(">"))))).map(move |(pos, members)| {
        let (cases, spreads) = split(members);
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

/// What the grammar allows but the spec doesn't (§14): duplicate fields and
/// tags, `closed < >`, and row parameters (`...r`).
fn check(file: &File) -> Result<(), (usize, String)> {
    fn first_duplicate<'a>(names: impl Iterator<Item = (&'a str, usize)>) -> Option<(&'a str, usize)> {
        let mut seen = std::collections::HashSet::new();
        names.into_iter().find(|(n, _)| !seen.insert(*n))
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
    file.types.iter().try_for_each(|d| ty(&d.ty))
}

// ── spreads ──────────────────────────────────────────────────

type Fail = (usize, String);

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
    let types = file
        .types
        .iter()
        .map(|d| Ok(TypeDef { ty: x.ty(&d.ty)?, ..d.clone() }))
        .collect::<Result<Vec<_>, Fail>>()?;
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
                Ty::Record { closed: *closed, fields: fields.into_iter().map(|(f, _)| f).collect(), spreads: vec![], pos: *pos }
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
                Ty::Variant { closed: *closed, cases: cases.into_iter().map(|(c, _)| c).collect(), spreads: vec![], pos: *pos }
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
                return Err((s.pos, format!("{name} has parameters ({name} {params}); only a type without parameters can be spread")));
            }
            let body = match self.done.get(&name) {
                Some(t) => t.clone(),
                None => {
                    if self.busy.contains(&name) {
                        return Err((def.pos, format!("type {name} spreads itself (directly or through another type)")));
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
fn duplicate<'a>(names: impl Iterator<Item = (&'a str, usize, Option<usize>)>) -> Option<(&'a str, usize)> {
    let mut seen = HashSet::new();
    names.into_iter().find(|(n, _, _)| !seen.insert(*n)).map(|(n, pos, from)| (n, from.unwrap_or(pos)))
}
