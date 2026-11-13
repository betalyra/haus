import Haus.Lexical

/-!
# std/time: the rules

Which strings each `std/time` type accepts ([`spec/std/time.md`](../../../std/time.md)),
as definitions. This is the specification; `Haus.Time.check` computes it.

Strings are lists of characters. Every rule is a strict format with fixed
separators, so each definition says how the string splits into parts and
what each part must be.
-/

namespace Haus.Time
open Haus

/-- Exactly `n` ASCII digits. -/
def DigitsN (n : Nat) (t : Text) : Prop := t.length = n ∧ ∀ c ∈ t, isDigit c = true

/-- One or more ASCII digits. -/
def Digits1 (t : Text) : Prop := t ≠ [] ∧ ∀ c ∈ t, isDigit c = true

/-- A whole number without a leading zero: `0`, `7`, `42`, not `07`. -/
def Natural (t : Text) : Prop := Digits1 t ∧ (t.head? = some '0' → t = ['0'])

/-- The value of decimal digits. -/
def num (t : Text) : Nat := digitsValue 10 t

def isLeap (y : Nat) : Bool := y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)

/-- Days in a month of the proleptic Gregorian calendar. -/
def daysIn (y m : Nat) : Nat :=
  if m == 2 then (if isLeap y then 29 else 28)
  else if m == 4 || m == 6 || m == 9 || m == 11 then 30
  else 31

/-! ## Dates and times -/

/-- `YYYY-MM-DD`: a day that exists, in the years 0000–9999. -/
def Date (s : Text) : Prop :=
  ∃ y m d, s = y ++ '-' :: m ++ '-' :: d ∧ DigitsN 4 y ∧ DigitsN 2 m ∧ DigitsN 2 d ∧
    1 ≤ num m ∧ num m ≤ 12 ∧ 1 ≤ num d ∧ num d ≤ daysIn (num y) (num m)

/-- `YYYY-MM` -/
def YearMonth (s : Text) : Prop :=
  ∃ y m, s = y ++ '-' :: m ∧ DigitsN 4 y ∧ DigitsN 2 m ∧ 1 ≤ num m ∧ num m ≤ 12

/-- An optional fraction of a second: `.` and 1–9 digits (nanoseconds). -/
def Fraction (f : Text) : Prop :=
  f = [] ∨ ∃ ds, f = '.' :: ds ∧ 1 ≤ ds.length ∧ ds.length ≤ 9 ∧ ∀ c ∈ ds, isDigit c = true

/-- `hh:mm:ss` and an optional fraction: no `24:00:00`, no leap seconds. -/
def Time (s : Text) : Prop :=
  ∃ h m sec f, s = h ++ ':' :: m ++ ':' :: sec ++ f ∧ DigitsN 2 h ∧ DigitsN 2 m ∧ DigitsN 2 sec ∧
    Fraction f ∧ num h ≤ 23 ∧ num m ≤ 59 ∧ num sec ≤ 59

/-- `Date` `T` `Time`, with an upper-case `T`. -/
def DateTime (s : Text) : Prop := ∃ d t, s = d ++ 'T' :: t ∧ Date d ∧ Time t

/-- `±hh:mm`, up to ±23:59, never `-00:00` (that is `Z`). -/
def NumOffset (o : Text) : Prop :=
  ∃ sg h m, o = sg :: h ++ ':' :: m ∧ (sg = '+' ∨ sg = '-') ∧ DigitsN 2 h ∧ DigitsN 2 m ∧
    num h ≤ 23 ∧ num m ≤ 59 ∧ ¬ (sg = '-' ∧ num h = 0 ∧ num m = 0)

/-- `Z` or `±hh:mm` -/
def Offset (o : Text) : Prop := o = ['Z'] ∨ NumOffset o

/-- A `DateTime` and an offset. -/
def Instant (s : Text) : Prop := ∃ dt o, s = dt ++ o ∧ DateTime dt ∧ Offset o

/-! ## Zones -/

def isLetter (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || ('A' ≤ c && c ≤ 'Z')

/-- `A–Z a–z 0–9 . _ + -` -/
def isZoneChar (c : Char) : Bool := isLetter c || isDigit c || c == '.' || c == '_' || c == '+' || c == '-'

/-- A part of a zone name: not empty, not `.` or `..`, which would let a lookup leave the tz database. -/
def ZonePart (p : Text) : Prop := p ≠ [] ∧ p ≠ ['.'] ∧ p ≠ ['.', '.'] ∧ ∀ c ∈ p, isZoneChar c = true

/-- An IANA zone name by its syntax, at most 255 characters: parts separated by `/`, the first starting with a letter. -/
def ZoneName (z : Text) : Prop :=
  z.length ≤ 255 ∧ (∃ c r, z = c :: r ∧ isLetter c = true) ∧ ∀ p ∈ z.splitOn '/', ZonePart p

/-- A zone name or an offset `±hh:mm`. -/
def Zone (z : Text) : Prop := NumOffset z ∨ ZoneName z

/-- An `Instant` and exactly one zone in brackets. -/
def ZonedDateTime (s : Text) : Prop := ∃ i z, s = i ++ '[' :: z ++ [']'] ∧ Instant i ∧ Zone z

/-! ## Durations -/

/-- An optional component `n U`: its text, and its value if present. -/
inductive Component (u : Char) : Text → Option Nat → Prop
  | none : Component u [] none
  | some (ds : Text) : Natural ds → Component u (ds ++ [u]) (some (num ds))

/-- The seconds `n[.f]S`, the only component with a fraction. -/
inductive Seconds : Text → Option Nat → Prop
  | none : Seconds [] none
  | some (ds f : Text) : Natural ds → Fraction f → Seconds (ds ++ f ++ ['S']) (some (num ds))

/-- Text with digits, none of them other than `0`: a component (or time part) that is zero. -/
def ZeroText (t : Text) : Prop := t ≠ [] ∧ ∀ c ∈ t, isDigit c = true → c = '0'

/-- `T` followed by at least one of hours, minutes and seconds; or nothing. Zero seconds come alone. -/
inductive TimePart : Text → Option Nat → Option Nat → Option Nat → Prop
  | none : TimePart [] none none none
  | some (th tm ts : Text) (h m s : Option Nat) :
      Component 'H' th h → Component 'M' tm m → Seconds ts s → (h.isSome ∨ m.isSome ∨ s.isSome) →
      (ZeroText ts → th = [] ∧ tm = []) →
      TimePart ('T' :: th ++ tm ++ ts) h m s

/--
`-?P[nY][nM][nW][nD][T[nH][nM][n[.f]S]]`, with at least one component,
numbers without leading zeros, no component that is zero (the zero
duration is written `PT0S`: zero seconds, alone), and `-` only before a
duration that isn't zero (one of its digits isn't `0`). Years, months and weeks stay below 2³²;
days and time together below 2⁵³ seconds (the fraction doesn't count: it
can't reach the next second).
-/
def Duration (s : Text) : Prop :=
  ∃ sg ty tm tw td tt y mo w d h mi se,
    s = sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ tt ∧ (sg = [] ∨ sg = ['-']) ∧
    Component 'Y' ty y ∧ Component 'M' tm mo ∧ Component 'W' tw w ∧ Component 'D' td d ∧
    TimePart tt h mi se ∧
    (y.isSome ∨ mo.isSome ∨ w.isSome ∨ d.isSome ∨ h.isSome ∨ mi.isSome ∨ se.isSome) ∧
    (y ≠ some 0 ∧ mo ≠ some 0 ∧ w ≠ some 0 ∧ d ≠ some 0 ∧ h ≠ some 0 ∧ mi ≠ some 0) ∧
    (ZeroText tt → ty ++ tm ++ tw ++ td = []) ∧
    (sg = ['-'] → ∃ c ∈ ty ++ tm ++ tw ++ td ++ tt, isDigit c = true ∧ c ≠ '0') ∧
    y.getD 0 < 2 ^ 32 ∧ mo.getD 0 < 2 ^ 32 ∧ w.getD 0 < 2 ^ 32 ∧
    d.getD 0 * 86400 + h.getD 0 * 3600 + mi.getD 0 * 60 + se.getD 0 < 2 ^ 53

/-! ## The types -/

inductive TimeType
  | date | time | dateTime | instant | zonedDateTime | duration | yearMonth | timeZone
  deriving Repr, DecidableEq

def TimeType.name : TimeType → String
  | .date => "Date" | .time => "Time" | .dateTime => "DateTime" | .instant => "Instant"
  | .zonedDateTime => "ZonedDateTime" | .duration => "Duration" | .yearMonth => "YearMonth"
  | .timeZone => "TimeZone"

def TimeType.all : List TimeType :=
  [.date, .time, .dateTime, .instant, .zonedDateTime, .duration, .yearMonth, .timeZone]

/-- The strings a std/time type accepts. -/
def Valid : TimeType → Text → Prop
  | .date => Date
  | .time => Time
  | .dateTime => DateTime
  | .instant => Instant
  | .zonedDateTime => ZonedDateTime
  | .duration => Duration
  | .yearMonth => YearMonth
  | .timeZone => Zone

end Haus.Time
