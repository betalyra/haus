import Haus.Time.Correct

/-!
# std/time: what valid values guarantee

* **T3. Zone names can't leave the tz database.** An application that looks
  a zone up as a file, `base/Europe/Lisbon`, stays inside `base`: a valid
  name has no `.`, `..` or empty parts, isn't absolute, and has no
  character a file system treats specially (`\`, `:`, NUL).
* **T4. Durations fit their target types.** Years, months and weeks fit in
  32 bits. Days and time together are below 2⁵³ seconds: exact as a
  JavaScript number (an IEEE double holds every integer below 2⁵³), and so
  in a signed 64-bit count of seconds either way round. A fraction is below
  10⁹ nanoseconds. (Not 64-bit nanoseconds: those end after about 292 years.)
-/

namespace Haus.Time
open Haus

/-! ## T3 -/

/--
A path relative to the directory `dir` (a list of names), resolved the way
`os.path.join` and a file system do: `.` and empty parts stay where they
are, `..` goes up one level.
-/
def walk (dir : List Text) : List Text → List Text
  | [] => dir
  | [] :: ps => walk dir ps
  | ['.'] :: ps => walk dir ps
  | ['.', '.'] :: ps => walk dir.dropLast ps
  | p :: ps => walk (dir ++ [p]) ps

/-- Looking up `name` under `base`: an absolute name (`/…`) starts from the root instead. -/
def lookup (base : List Text) (name : Text) : List Text :=
  walk (if name.head? = some '/' then [] else base) (name.splitOn '/')

-- The model lets the attacks through, so the theorems below have something to say:
#guard lookup (["usr", "share", "zoneinfo"].map String.toList) "Europe/../../../etc/passwd".toList ==
  ["usr", "etc", "passwd"].map String.toList
#guard lookup (["usr", "share", "zoneinfo"].map String.toList) "/etc/passwd".toList == ["etc", "passwd"].map String.toList
-- and the profile rejects both.
#guard !check .timeZone "Europe/../../../etc/passwd".toList && !check .timeZone "/etc/passwd".toList

theorem walk_plain (dir : List Text) (ps : List Text) (h : ∀ p ∈ ps, ZonePart p) : walk dir ps = dir ++ ps := by
  induction ps generalizing dir with
  | nil => simp [walk]
  | cons p ps ih =>
    obtain ⟨h0, h1, h2, -⟩ := h p (by simp)
    rw [walk.eq_5 dir p ps h0 h1 h2, ih _ fun q hq => h q (by simp [hq])]
    simp

/-- **T3.** A zone name, looked up under `base`, is `base` followed by its parts. -/
theorem ZoneName.lookup_eq {z : Text} (h : ZoneName z) (base : List Text) :
    lookup base z = base ++ z.splitOn '/' := by
  obtain ⟨-, ⟨c, r, rfl, hc⟩, hp⟩ := h
  have : c ≠ '/' := by rintro rfl; simp [isLetter] at hc
  simp [lookup, this, walk_plain base _ hp]

/-- **T3.** So it never leaves `base`. -/
theorem ZoneName.lookup_inside {z : Text} (h : ZoneName z) (base : List Text) : base <+: lookup base z := by
  rw [h.lookup_eq]; exact List.prefix_append _ _

/-- **T3.** Its only characters are `A–Z a–z 0–9 . _ + -` and `/`: no `\`, `:` or NUL. -/
theorem ZoneName.chars {z : Text} (h : ZoneName z) : ∀ c ∈ z, c = '/' ∨ isZoneChar c = true := by
  intro c hc
  rw [← List.intercalate_splitOn (xs := z) '/'] at hc
  rcases mem_intercalate hc with h' | ⟨p, hp, hcp⟩
  · exact .inl h'
  · exact .inr ((h.2.2 p hp).2.2.2 c hcp)

/-- Every zone of a valid `TimeZone` or `ZonedDateTime` is an offset (nothing to look up) or such a name. -/
theorem Zone.lookup_inside {z : Text} (h : Zone z) (base : List Text) : NumOffset z ∨ base <+: lookup base z :=
  h.imp id fun h => h.lookup_inside base

/-! ## T4 -/

/-- The nanoseconds a fraction stands for: `.25` is 250,000,000. -/
def fractionNanos : Text → Nat
  | '.' :: ds => num ds * 10 ^ (9 - ds.length)
  | _ => 0

theorem hexValue_digit {c : Char} (h : isDigit c = true) : hexValue c ≤ 9 := by
  simp only [isDigit, Bool.and_eq_true, decide_eq_true_eq] at h
  have h1 : c.toNat ≤ '9'.toNat := h.2
  have e : '9'.toNat = 57 := rfl
  simp [hexValue, isDigit, h.1, h.2]
  omega

theorem foldl_digits_lt {ds : Text} (h : ∀ c ∈ ds, isDigit c = true) (acc : Nat) :
    ds.foldl (fun n c => n * 10 + hexValue c) acc < (acc + 1) * 10 ^ ds.length := by
  induction ds generalizing acc with
  | nil => simp
  | cons c cs ih =>
    have hc := hexValue_digit (h c (by simp))
    have := ih (fun x hx => h x (by simp [hx])) (acc * 10 + hexValue c)
    simp only [List.foldl_cons, List.length_cons, Nat.pow_succ]
    calc _ < (acc * 10 + hexValue c + 1) * 10 ^ cs.length := this
      _ ≤ (acc + 1) * (10 ^ cs.length * 10) := by
        rw [Nat.mul_comm (10 ^ cs.length) 10, ← Nat.mul_assoc]
        exact Nat.mul_le_mul_right _ (by omega)

/-- `n` digits are below 10ⁿ. -/
theorem num_lt {ds : Text} (h : ∀ c ∈ ds, isDigit c = true) : num ds < 10 ^ ds.length := by
  simpa [num, digitsValue] using foldl_digits_lt h 0

/-- **T4.** A fraction is below a second: under 10⁹ nanoseconds, so it fits in 32 bits. -/
theorem Fraction.nanos_lt {f : Text} (h : Fraction f) : fractionNanos f < 10 ^ 9 := by
  rcases h with rfl | ⟨ds, rfl, -, h9, hd⟩
  · simp [fractionNanos]
  · simp only [fractionNanos]
    calc num ds * 10 ^ (9 - ds.length) < 10 ^ ds.length * 10 ^ (9 - ds.length) :=
          Nat.mul_lt_mul_of_pos_right (num_lt hd) (Nat.pow_pos (by decide))
      _ = 10 ^ 9 := by rw [← Nat.pow_add]; congr 1; omega

/--
**T4.** The fields of a valid duration, as written, and what they fit in.
Days and time count as seconds; the fraction of the seconds is bounded by
`Fraction.nanos_lt`.
-/
theorem Duration.fits {s : Text} (h : Duration s) :
    ∃ y mo w d hh mi se : Option Nat,
      (∃ sg ty tm tw td tt, s = sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ tt ∧
        Component 'Y' ty y ∧ Component 'M' tm mo ∧ Component 'W' tw w ∧ Component 'D' td d ∧
        TimePart tt hh mi se) ∧
      y.getD 0 < 2 ^ 32 ∧ mo.getD 0 < 2 ^ 32 ∧ w.getD 0 < 2 ^ 32 ∧
      d.getD 0 * 86400 + hh.getD 0 * 3600 + mi.getD 0 * 60 + se.getD 0 < 2 ^ 53 ∧
      -- so the seconds fit a signed 64-bit integer, with either sign
      d.getD 0 * 86400 + hh.getD 0 * 3600 + mi.getD 0 * 60 + se.getD 0 < 2 ^ 63 := by
  obtain ⟨sg, ty, tm, tw, td, tt, y, mo, w, d, hh, mi, se, hs, -, hy, hm, hw, hd, ht, -, b1, b2, b3, b4⟩ := h
  exact ⟨y, mo, w, d, hh, mi, se, ⟨sg, ty, tm, tw, td, tt, hs, hy, hm, hw, hd, ht⟩, b1, b2, b3, b4,
    Nat.lt_of_lt_of_le b4 (Nat.pow_le_pow_right (by decide) (by decide))⟩

end Haus.Time
