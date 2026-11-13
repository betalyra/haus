import Haus.Time.Spec

/-!
# std/time: the checker

`check ty s` computes `Valid ty s` (proven in `Haus.Time.Correct`). Each
piece reads from the front of the string and returns what is left.
-/

namespace Haus.Time
open Haus

/-- Exactly `n` digits: them and the rest. -/
def digitsN : Nat → Text → Option (Text × Text)
  | 0, t => some ([], t)
  | n + 1, c :: t => if isDigit c then (digitsN n t).map fun (ds, r) => (c :: ds, r) else none
  | _ + 1, [] => none

/-- The character `c`, then the rest. -/
def lit (c : Char) : Text → Option Text
  | d :: t => if d == c then some t else none
  | [] => none

/-- An optional fraction: `.` and 1–9 digits. -/
def fraction : Text → Option (Text × Text)
  | '.' :: t =>
    let ds := t.takeWhile isDigit
    if 1 ≤ ds.length && ds.length ≤ 9 then some ('.' :: ds, t.dropWhile isDigit) else none
  | t => some ([], t)

/-- `YYYY-MM-DD`, its shape only: year, month and day. -/
def date? (s : Text) : Option ((Text × Text × Text) × Text) := do
  let (y, s) ← digitsN 4 s
  let s ← lit '-' s
  let (m, s) ← digitsN 2 s
  let s ← lit '-' s
  let (d, s) ← digitsN 2 s
  return ((y, m, d), s)

def dateOk (y m d : Text) : Bool :=
  1 ≤ num m && num m ≤ 12 && 1 ≤ num d && num d ≤ daysIn (num y) (num m)

/-- `hh:mm:ss[.f]`, its shape only. -/
def time? (s : Text) : Option ((Text × Text × Text) × Text) := do
  let (h, s) ← digitsN 2 s
  let s ← lit ':' s
  let (m, s) ← digitsN 2 s
  let s ← lit ':' s
  let (sec, s) ← digitsN 2 s
  let (_, s) ← fraction s
  return ((h, m, sec), s)

def timeOk (h m sec : Text) : Bool := num h ≤ 23 && num m ≤ 59 && num sec ≤ 59

/-- `±hh:mm`, the whole text. -/
def numOffsetOk : Text → Bool
  | [sg, h1, h2, ':', m1, m2] =>
    (sg == '+' || sg == '-') && isDigit h1 && isDigit h2 && isDigit m1 && isDigit m2 &&
      num [h1, h2] ≤ 23 && num [m1, m2] ≤ 59 && !(sg == '-' && num [h1, h2] == 0 && num [m1, m2] == 0)
  | _ => false

/-- An offset at the front: `Z` or six characters `±hh:mm`. -/
def offset? : Text → Option (Text × Text)
  | 'Z' :: r => some (['Z'], r)
  | t => if numOffsetOk (t.take 6) then some (t.take 6, t.drop 6) else none

def zoneNameOk (z : Text) : Bool :=
  z.length ≤ 255 && (match z with | c :: _ => isLetter c | [] => false) &&
    (z.splitOn '/').all fun p => p != [] && p != ['.'] && p != ['.', '.'] && p.all isZoneChar

def zoneOk (z : Text) : Bool := numOffsetOk z || zoneNameOk z

def checkDate (s : Text) : Bool :=
  match date? s with
  | some ((y, m, d), []) => dateOk y m d
  | _ => false

def checkYearMonth (s : Text) : Bool :=
  match digitsN 4 s with
  | some (_, '-' :: r) =>
    match digitsN 2 r with
    | some (m, []) => 1 ≤ num m && num m ≤ 12
    | _ => false
  | _ => false

def checkTime (s : Text) : Bool :=
  match time? s with
  | some ((h, m, sec), []) => timeOk h m sec
  | _ => false

/-- A date, `T` and a time: whether they are valid, and the rest. -/
def dateTime? (s : Text) : Option (Bool × Text) := do
  let ((y, m, d), s) ← date? s
  let s ← lit 'T' s
  let ((h, mi, sec), s) ← time? s
  return (dateOk y m d && timeOk h mi sec, s)

def checkDateTime (s : Text) : Bool :=
  match dateTime? s with
  | some (ok, []) => ok
  | _ => false

/-- A date-time and an offset: whether they are valid, and the rest. -/
def instant? (s : Text) : Option (Bool × Text) := do
  let (ok, s) ← dateTime? s
  let (o, s) ← offset? s
  return (ok && (o == ['Z'] || numOffsetOk o), s)

def checkInstant (s : Text) : Bool :=
  match instant? s with
  | some (ok, []) => ok
  | _ => false

def checkZoned (s : Text) : Bool :=
  match instant? s with
  | some (ok, '[' :: r) =>
    match r.dropWhile (· != ']') with
    | [']'] => ok && zoneOk (r.takeWhile (· != ']'))
    | _ => false
  | _ => false

/-! ## Durations -/

/-- An optional component `n U`: its value if it is there, and the rest. -/
def component (u : Char) (t : Text) : Option Nat × Text :=
  let ds := t.takeWhile isDigit
  match t.dropWhile isDigit with
  | c :: r => if ds != [] && c == u then (some (num ds), r) else (none, t)
  | [] => (none, t)

/-- The seconds `n[.f]S`, if they are there, and the rest. -/
def seconds (t : Text) : Option Nat × Text :=
  let ds := t.takeWhile isDigit
  match fraction (t.dropWhile isDigit) with
  | some (_, 'S' :: r) => if ds != [] then (some (num ds), r) else (none, t)
  | _ => (none, t)

def durationBounds (y mo w d h mi se : Option Nat) : Bool :=
  y.getD 0 < 2 ^ 32 && mo.getD 0 < 2 ^ 32 && w.getD 0 < 2 ^ 32 &&
    d.getD 0 * 86400 + h.getD 0 * 3600 + mi.getD 0 * 60 + se.getD 0 < 2 ^ 53

/-- After the date components: the time part, and the checks. -/
def durationTime (y mo w d : Option Nat) : Text → Bool
  | [] => (y.isSome || mo.isSome || w.isSome || d.isSome) && durationBounds y mo w d none none none
  | 'T' :: t =>
    let (h, t) := component 'H' t
    let (mi, t) := component 'M' t
    let (se, t) := seconds t
    t.isEmpty && (h.isSome || mi.isSome || se.isSome) && durationBounds y mo w d h mi se
  | _ => false

/-- After the sign. -/
def checkDurationBody : Text → Bool
  | 'P' :: t =>
    let (y, t) := component 'Y' t
    let (mo, t) := component 'M' t
    let (w, t) := component 'W' t
    let (d, t) := component 'D' t
    durationTime y mo w d t
  | _ => false

def checkDuration : Text → Bool
  | '-' :: t => checkDurationBody t
  | t => checkDurationBody t

/-! ## All types -/

/-- Whether `s` is a valid value of the std/time type `ty`. -/
def check : TimeType → Text → Bool
  | .date => checkDate
  | .time => checkTime
  | .dateTime => checkDateTime
  | .instant => checkInstant
  | .zonedDateTime => checkZoned
  | .duration => checkDuration
  | .yearMonth => checkYearMonth
  | .timeZone => zoneOk

/-! ## The rules of spec/std/time.md, row by row -/

private def ok (ty : TimeType) (s : String) : Bool := check ty s.toList
private def no (ty : TimeType) (s : String) : Bool := !check ty s.toList

-- Types
#guard ok .date "2026-11-09"
#guard ok .time "14:30:00.250"
#guard ok .dateTime "2026-11-09T14:30:00"
#guard ok .instant "2026-11-09T14:30:00Z"
#guard ok .zonedDateTime "2027-03-29T10:00:00+01:00[Europe/Lisbon]"
#guard ok .duration "PT1H30M"
#guard ok .yearMonth "2026-11"
#guard ok .timeZone "Europe/Lisbon" && ok .timeZone "+01:00"
-- Year
#guard ok .date "0000-01-01" && ok .date "9999-12-31"
#guard no .date "+12026-11-09" && no .date "-0001-01-01"
-- Day
#guard no .date "2026-02-29" && no .date "1900-02-29" && no .date "2026-04-31"
#guard ok .date "2024-02-29" && ok .date "2000-02-29" && ok .date "0000-02-29"
#guard no .date "2026-01-00"
-- Month
#guard no .date "2026-13-01" && no .date "2026-00-10" && no .yearMonth "2026-13" && no .yearMonth "2026-00"
-- Hour, minute, second
#guard no .time "14:30" && no .time "24:00:00" && no .time "12:60:00" && ok .time "23:59:59"
-- Leap seconds
#guard no .time "23:59:60"
-- Fraction
#guard ok .time "12:00:00.123456789" && no .time "12:00:00.1234567890" && no .time "12:00:00."
#guard no .duration "PT1.5H" && ok .duration "PT1.5S"
-- Separators
#guard no .dateTime "2026-11-09t14:30:00" && no .dateTime "2026-11-09 14:30:00"
#guard no .instant "2026-11-09T14:30:00z"
-- Offset
#guard no .instant "2026-11-09T14:30:00-00:00" && ok .instant "2026-11-09T14:30:00+00:00"
#guard no .instant "2026-11-09T14:30:00+24:00" && no .instant "2026-11-09T14:30:00+0100"
#guard ok .instant "2026-11-09T14:30:00-23:59"
-- Zone
#guard no .zonedDateTime "2026-11-09T14:30:00Z[!Europe/Lisbon]"
#guard no .zonedDateTime "2026-11-09T14:30:00Z[Europe/../etc]"
#guard no .timeZone "Europe/../etc" && no .timeZone "./x" && no .timeZone "Europe//Lisbon"
#guard no .timeZone "Europe/" && no .timeZone "1Europe" && no .timeZone ""
#guard ok .timeZone "America/Argentina/Buenos_Aires" && ok .timeZone "Etc/GMT+5" && ok .timeZone "Z"
#guard no .timeZone "-00:00" && no .timeZone "+24:00"
#guard ok .timeZone (String.ofList (List.replicate 255 'a')) && no .timeZone (String.ofList (List.replicate 256 'a'))
-- RFC 9557 tags
#guard no .zonedDateTime "2026-11-09T14:30:00Z[Europe/Lisbon][u-ca=iso8601]"
#guard no .zonedDateTime "2026-11-09T14:30:00Z" && no .zonedDateTime "2026-11-09T14:30:00[Europe/Lisbon]"
-- Duration
#guard no .duration "P" && no .duration "PT" && no .duration "P1DT" && no .duration "+PT1H" && no .duration "p1d"
#guard ok .duration "-P1Y2M3W4DT5H6M7.5S" && ok .duration "P1M" && ok .duration "PT1M" && ok .duration "PT0S"
#guard no .duration "PT1M1H" && no .duration "P1D1Y" && no .duration "P1.5D"
#guard ok .duration "P4294967295Y" && no .duration "P4294967296Y" && no .duration "P4294967296W"
#guard ok .duration "PT9007199254740991S" && no .duration "PT9007199254740992S"
#guard ok .duration "PT9007199254740991.999999999S"
#guard ok .duration "P104249991374D" && no .duration "P104249991375D"
-- Other ISO 8601 forms
#guard no .date "2026-W45-1" && no .date "2026-313" && no .date "20261109"
#guard no .duration "R5/PT1H" && no .instant "2026-11-09T14:30:00Z/2026-11-10T14:30:00Z"

end Haus.Time
