import Haus.Time.Check
import Haus.Lists

/-!
# std/time: the checker computes the rules

`check_iff : check ty s = true ↔ Valid ty s`, for every type.

Each piece of the checker gets two lemmas, as for the parser: what it read
is described by the rules (soundness), and what the rules describe it reads
(completeness). Fixed-width pieces (digits, separators, offsets) need
nothing more and are stated as one `↔`. Greedy pieces need to know what
follows: a fraction must not be followed by a digit or `.` (`FracFollow`),
and an absent duration component must be followed by the end, the `T`, or a
component with a different letter (`Later`).
-/

namespace Haus.Time
open Haus

/-! ## Pieces -/

theorem digitsN_eq_some : ∀ (n : Nat) (t ds r : Text), digitsN n t = some (ds, r) ↔ t = ds ++ r ∧ DigitsN n ds
  | 0, t, ds, r => by
    simp only [digitsN, Option.some.injEq, Prod.mk.injEq, DigitsN]
    constructor
    · rintro ⟨rfl, rfl⟩; simp
    · rintro ⟨rfl, h, -⟩; simp at h; subst h; simp
  | n + 1, [], ds, r => by
    simp only [digitsN, reduceCtorEq, false_iff, not_and, DigitsN]
    intro h hl; cases ds <;> simp_all
  | n + 1, c :: t, ds, r => by
    have ih := digitsN_eq_some n t
    by_cases hc : isDigit c = true
    · simp only [digitsN, hc, ↓reduceIte, Option.map_eq_some_iff, Prod.exists]
      constructor
      · rintro ⟨ds', r', h, h'⟩
        simp only [Prod.mk.injEq] at h'; obtain ⟨rfl, rfl⟩ := h'
        obtain ⟨rfl, hl, hd⟩ := (ih ds' r').mp h
        refine ⟨rfl, by simp [hl], ?_⟩
        intro x hx; rcases List.mem_cons.mp hx with rfl | hx; exact hc; exact hd x hx
      · rintro ⟨h, hl, hd⟩
        cases ds with
        | nil => simp at hl
        | cons d ds' =>
          simp at h; obtain ⟨rfl, rfl⟩ := h
          exact ⟨ds', r, (ih ds' r).mpr ⟨rfl, by simpa using hl, fun x hx => hd x (by simp [hx])⟩, rfl⟩
    · simp only [digitsN, hc, Bool.false_eq_true, ↓reduceIte, reduceCtorEq, false_iff, not_and, DigitsN]
      intro h hl hd
      cases ds with
      | nil => simp at hl
      | cons d ds' => simp at h; exact hc (h.1 ▸ hd d (by simp))

theorem lit_eq_some (c : Char) (t r : Text) : lit c t = some r ↔ t = c :: r := by
  cases t with
  | nil => simp [lit]
  | cons d t =>
    by_cases h : d = c
    · subst h; simp [lit, eq_comm]
    · simp [lit, h]

/-- A fraction can only be followed by something that doesn't continue it. -/
def FracFollow (r : Text) : Prop := ∀ c, r.head? = some c → isDigit c = false ∧ c ≠ '.'

theorem fraction_sound {t f r : Text} (h : fraction t = some (f, r)) : t = f ++ r ∧ Fraction f := by
  unfold fraction at h
  split at h
  · rename_i t'
    dsimp only at h
    split at h
    · rename_i hl
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      simp only [Bool.and_eq_true, decide_eq_true_eq] at hl
      refine ⟨by simp [List.takeWhile_append_dropWhile], .inr ⟨_, rfl, hl.1, hl.2, ?_⟩⟩
      intro c hc; exact mem_takeWhile hc
    · simp at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨rfl, .inl rfl⟩

theorem fraction_complete {f r : Text} (hf : Fraction f) (hr : FracFollow r) : fraction (f ++ r) = some (f, r) := by
  rcases hf with rfl | ⟨ds, rfl, h1, h9, hd⟩
  · cases r with
    | nil => rfl
    | cons c r' =>
      have := (hr c rfl).2
      simp only [List.nil_append]
      unfold fraction
      split
      · rename_i heq; exact absurd (List.cons.inj heq).1 this
      · rfl
  · obtain ⟨ht, hdw⟩ := takeWhile_append hd (x := r) fun c hc => (hr c hc).1
    have : (1 ≤ ds.length && ds.length ≤ 9) = true := by simp [h1, h9]
    simp [fraction, ht, hdw, this]

/-! ## Dates -/

theorem date?_eq_some (s r y m d : Text) :
    date? s = some ((y, m, d), r) ↔
      s = y ++ '-' :: m ++ '-' :: d ++ r ∧ DigitsN 4 y ∧ DigitsN 2 m ∧ DigitsN 2 d := by
  simp only [date?, Option.bind_eq_bind, Option.bind_eq_some_iff, Prod.exists, Option.pure_def,
    Option.some.injEq, Prod.mk.injEq, digitsN_eq_some, lit_eq_some]
  constructor
  · rintro ⟨y', s1, ⟨rfl, hy⟩, s2, rfl, m', s3, ⟨rfl, hm⟩, s4, rfl, d', s5, ⟨rfl, hd⟩, ⟨rfl, rfl, rfl⟩, rfl⟩
    exact ⟨by simp, hy, hm, hd⟩
  · rintro ⟨rfl, hy, hm, hd⟩
    exact ⟨y, _, ⟨by simp, hy⟩, _, rfl, m, _, ⟨rfl, hm⟩, _, rfl, d, r, ⟨rfl, hd⟩, ⟨rfl, rfl, rfl⟩, rfl⟩

theorem checkDate_iff (s : Text) : checkDate s = true ↔ Date s := by
  unfold checkDate
  constructor
  · intro h
    split at h
    · rename_i y m d heq
      obtain ⟨rfl, hy, hm, hd⟩ := (date?_eq_some _ _ _ _ _).mp heq
      simp only [dateOk, Bool.and_eq_true, decide_eq_true_eq] at h
      exact ⟨y, m, d, by simp, hy, hm, hd, h.1.1.1, h.1.1.2, h.1.2, h.2⟩
    · simp at h
  · rintro ⟨y, m, d, rfl, hy, hm, hd, h1, h2, h3, h4⟩
    rw [show y ++ '-' :: m ++ '-' :: d = y ++ '-' :: m ++ '-' :: d ++ [] by simp,
      (date?_eq_some _ _ _ _ _).mpr ⟨rfl, hy, hm, hd⟩]
    simp [dateOk, h1, h2, h3, h4]

theorem checkYearMonth_iff (s : Text) : checkYearMonth s = true ↔ YearMonth s := by
  unfold checkYearMonth
  constructor
  · intro h
    split at h
    · rename_i y r heq
      obtain ⟨rfl, hy⟩ := (digitsN_eq_some _ _ _ _).mp heq
      split at h
      · rename_i m heq2
        obtain ⟨rfl, hm⟩ := (digitsN_eq_some _ _ _ _).mp heq2
        simp only [Bool.and_eq_true, decide_eq_true_eq] at h
        exact ⟨y, m, by simp, hy, hm, h.1, h.2⟩
      · simp at h
    · simp at h
  · rintro ⟨y, m, rfl, hy, hm, h1, h2⟩
    rw [(digitsN_eq_some _ _ y ('-' :: m)).mpr ⟨rfl, hy⟩]
    simp only
    rw [show m = m ++ [] by simp, (digitsN_eq_some _ _ m []).mpr ⟨rfl, hm⟩]
    simp [h1, h2]

/-! ## Times -/

theorem time?_sound {s r h m sec : Text} (hs : time? s = some ((h, m, sec), r)) :
    ∃ f, s = h ++ ':' :: m ++ ':' :: sec ++ f ++ r ∧ DigitsN 2 h ∧ DigitsN 2 m ∧ DigitsN 2 sec ∧ Fraction f := by
  simp only [time?, Option.bind_eq_bind, Option.bind_eq_some_iff, Prod.exists, Option.pure_def,
    Option.some.injEq, Prod.mk.injEq, digitsN_eq_some, lit_eq_some] at hs
  obtain ⟨h', s1, ⟨rfl, hh⟩, s2, rfl, m', s3, ⟨rfl, hm⟩, s4, rfl, sec', s5, ⟨rfl, hsec⟩, f, s6, hf,
    ⟨rfl, rfl, rfl⟩, rfl⟩ := hs
  obtain ⟨rfl, hfr⟩ := fraction_sound hf
  exact ⟨f, by simp, hh, hm, hsec, hfr⟩

theorem time?_complete {h m sec f r : Text} (hh : DigitsN 2 h) (hm : DigitsN 2 m) (hsec : DigitsN 2 sec)
    (hf : Fraction f) (hr : FracFollow r) :
    time? (h ++ ':' :: m ++ ':' :: sec ++ f ++ r) = some ((h, m, sec), r) := by
  have e : h ++ ':' :: m ++ ':' :: sec ++ f ++ r = h ++ (':' :: (m ++ (':' :: (sec ++ (f ++ r))))) := by simp
  rw [e]
  simp only [time?, Option.bind_eq_bind]
  rw [(digitsN_eq_some _ _ h _).mpr ⟨rfl, hh⟩]
  simp only [Option.bind_some]
  simp only [lit, beq_self_eq_true, ↓reduceIte, Option.bind_some]
  rw [(digitsN_eq_some _ _ m _).mpr ⟨rfl, hm⟩]
  simp only [Option.bind_some, beq_self_eq_true, ↓reduceIte]
  rw [(digitsN_eq_some _ _ sec _).mpr ⟨rfl, hsec⟩]
  simp [fraction_complete hf hr]

theorem fracFollow_nil : FracFollow [] := by intro c hc; simp at hc

theorem checkTime_iff (s : Text) : checkTime s = true ↔ Time s := by
  unfold checkTime
  constructor
  · intro hs
    split at hs
    · rename_i h m sec heq
      obtain ⟨f, rfl, hh, hm, hsec, hf⟩ := time?_sound heq
      simp only [timeOk, Bool.and_eq_true, decide_eq_true_eq] at hs
      exact ⟨h, m, sec, f, by simp, hh, hm, hsec, hf, hs.1.1, hs.1.2, hs.2⟩
    · simp at hs
  · rintro ⟨h, m, sec, f, rfl, hh, hm, hsec, hf, h1, h2, h3⟩
    have := time?_complete hh hm hsec hf fracFollow_nil
    simp only [List.append_nil, List.append_assoc, List.cons_append] at this ⊢
    simp [this, timeOk, h1, h2, h3]

theorem dateTime?_sound {s r : Text} (hs : dateTime? s = some (true, r)) : ∃ dt, s = dt ++ r ∧ DateTime dt := by
  simp only [dateTime?, Option.bind_eq_bind, Option.bind_eq_some_iff, Prod.exists, Option.pure_def,
    Option.some.injEq, Prod.mk.injEq, lit_eq_some] at hs
  obtain ⟨y, m, d, s1, hd, s2, rfl, h, mi, sec, s3, ht, hok, rfl⟩ := hs
  obtain ⟨rfl, hy, hm, hdd⟩ := (date?_eq_some _ _ _ _ _).mp hd
  obtain ⟨f, rfl, hh, hmi, hsec, hf⟩ := time?_sound ht
  simp only [dateOk, timeOk, Bool.and_eq_true, decide_eq_true_eq] at hok
  refine ⟨y ++ '-' :: m ++ '-' :: d ++ 'T' :: (h ++ ':' :: mi ++ ':' :: sec ++ f), by simp, _, _, rfl,
    ⟨y, m, d, rfl, hy, hm, hdd, ?_⟩, ⟨h, mi, sec, f, rfl, hh, hmi, hsec, hf, ?_⟩⟩
  · exact ⟨hok.1.1.1.1, hok.1.1.1.2, hok.1.1.2, hok.1.2⟩
  · exact ⟨hok.2.1.1, hok.2.1.2, hok.2.2⟩

theorem dateTime?_complete {dt r : Text} (h : DateTime dt) (hr : FracFollow r) : dateTime? (dt ++ r) = some (true, r) := by
  obtain ⟨d, t, rfl, ⟨y, m, dd, rfl, hy, hm, hdd, h1, h2, h3, h4⟩, ⟨hh, mi, sec, f, rfl, hhh, hmi, hsec, hf, h5, h6, h7⟩⟩ := h
  have hd := (date?_eq_some (y ++ '-' :: m ++ '-' :: dd ++ 'T' :: (hh ++ ':' :: mi ++ ':' :: sec ++ f ++ r))
    ('T' :: (hh ++ ':' :: mi ++ ':' :: sec ++ f ++ r)) y m dd).mpr ⟨rfl, hy, hm, hdd⟩
  have ht := time?_complete hhh hmi hsec hf hr
  simp only [List.append_assoc, List.cons_append] at hd ht ⊢
  simp [dateTime?, hd, lit, ht, dateOk, timeOk, h1, h2, h3, h4, h5, h6, h7]

theorem checkDateTime_iff (s : Text) : checkDateTime s = true ↔ DateTime s := by
  unfold checkDateTime
  constructor
  · intro hs
    split at hs
    · rename_i ok heq
      subst hs
      obtain ⟨dt, rfl, h⟩ := dateTime?_sound heq
      simpa using h
    · simp at hs
  · intro h
    have := dateTime?_complete h fracFollow_nil
    simp only [List.append_nil] at this
    simp [this]

/-! ## Offsets and instants -/

theorem digits2 {t : Text} (h : DigitsN 2 t) : ∃ a b, t = [a, b] ∧ isDigit a = true ∧ isDigit b = true := by
  obtain ⟨hl, hd⟩ := h
  match t, hl with
  | [a, b], _ => exact ⟨a, b, rfl, hd a (by simp), hd b (by simp)⟩

theorem numOffsetOk_iff (o : Text) : numOffsetOk o = true ↔ NumOffset o := by
  constructor
  · intro h
    unfold numOffsetOk at h
    split at h
    · rename_i sg h1 h2 m1 m2
      simp only [Bool.and_eq_true, Bool.or_eq_true, beq_iff_eq, decide_eq_true_eq, Bool.not_eq_true',
        Bool.and_eq_false_iff] at h
      obtain ⟨⟨⟨⟨⟨⟨⟨hs, d1⟩, d2⟩, d3⟩, d4⟩, hh⟩, hm⟩, hz⟩ := h
      refine ⟨sg, [h1, h2], [m1, m2], rfl, hs, ⟨rfl, ?_⟩, ⟨rfl, ?_⟩, hh, hm, ?_⟩
      · intro c hc; simp at hc; rcases hc with rfl | rfl <;> assumption
      · intro c hc; simp at hc; rcases hc with rfl | rfl <;> assumption
      · rintro ⟨h1', h2', h3'⟩
        rcases hz with (hz | hz) | hz <;> simp_all
    · simp at h
  · rintro ⟨sg, h, m, rfl, hs, hh, hm, h1, h2, hz⟩
    obtain ⟨a, b, rfl, ha, hb⟩ := digits2 hh
    obtain ⟨c, d, rfl, hc, hd⟩ := digits2 hm
    have hs' : (sg == '+' || sg == '-') = true := by rcases hs with rfl | rfl <;> decide
    simp only [List.cons_append, List.nil_append, numOffsetOk, hs', ha, hb, hc, hd, Bool.true_and,
      h1, h2, Bool.and_true]
    simp only [decide_true, Bool.true_and, Bool.not_eq_true', Bool.and_eq_false_iff, beq_eq_false_iff_ne, ne_eq]
    by_cases e : sg = '-'
    · subst e
      by_cases e2 : num [a, b] = 0
      · exact .inr fun e3 => hz ⟨rfl, e2, e3⟩
      · exact .inl (.inr e2)
    · exact .inl (.inl e)

theorem numOffset_length {o : Text} (h : NumOffset o) : o.length = 6 := by
  obtain ⟨sg, hh, m, rfl, -, ⟨h1, -⟩, ⟨h2, -⟩, -⟩ := h
  simp [h1, h2]

theorem numOffset_head {o : Text} (h : NumOffset o) : ∃ sg r, o = sg :: r ∧ (sg = '+' ∨ sg = '-') := by
  obtain ⟨sg, hh, m, rfl, hs, -⟩ := h
  exact ⟨sg, _, rfl, hs⟩

theorem offset?_sound {t o r : Text} (h : offset? t = some (o, r)) : t = o ++ r ∧ Offset o := by
  unfold offset? at h
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨rfl, .inl rfl⟩
  · split at h
    · rename_i hok
      simp at h; obtain ⟨rfl, rfl⟩ := h
      exact ⟨by simp, .inr ((numOffsetOk_iff _).mp hok)⟩
    · simp at h

theorem offset?_complete {o : Text} (h : Offset o) (r : Text) : offset? (o ++ r) = some (o, r) := by
  rcases h with rfl | h
  · rfl
  · obtain ⟨sg, o', rfl, hs⟩ := numOffset_head h
    have hl := numOffset_length h
    have ht : (sg :: o' ++ r).take 6 = sg :: o' := by
      rw [List.take_append_of_le_length (by omega)]; exact List.take_of_length_le (by omega)
    have hd : (sg :: o' ++ r).drop 6 = r := by
      rw [List.drop_append_of_le_length (by omega)]; simp [List.drop_of_length_le (by omega : (sg :: o').length ≤ 6)]
    have hz : sg ≠ 'Z' := by rcases hs with rfl | rfl <;> decide
    unfold offset?
    split
    · rename_i heq; exact absurd (List.cons.inj heq).1 hz
    · rw [ht, hd, (numOffsetOk_iff _).mpr h]; rfl

theorem instant?_sound {s r : Text} (hs : instant? s = some (true, r)) : ∃ i, s = i ++ r ∧ Instant i := by
  simp only [instant?, Option.bind_eq_bind, Option.bind_eq_some_iff, Prod.exists, Option.pure_def,
    Option.some.injEq, Prod.mk.injEq, Bool.and_eq_true] at hs
  obtain ⟨ok, s1, hdt, o, s2, ho, ⟨rfl, -⟩, rfl⟩ := hs
  obtain ⟨dt, rfl, hd⟩ := dateTime?_sound hdt
  obtain ⟨rfl, hoff⟩ := offset?_sound ho
  exact ⟨dt ++ o, by simp, dt, o, rfl, hd, hoff⟩

theorem offset_fracFollow {o : Text} (h : Offset o) (r : Text) : FracFollow (o ++ r) := by
  intro c hc
  rcases h with rfl | h
  · simp at hc; subst hc; decide
  · obtain ⟨sg, o', rfl, hs⟩ := numOffset_head h
    simp at hc; subst hc; rcases hs with rfl | rfl <;> decide

theorem offset_ok {o : Text} (h : Offset o) : (o == ['Z'] || numOffsetOk o) = true := by
  rcases h with rfl | h
  · rfl
  · simp [(numOffsetOk_iff o).mpr h]

theorem instant?_complete {i : Text} (h : Instant i) (r : Text) : instant? (i ++ r) = some (true, r) := by
  obtain ⟨dt, o, rfl, hd, ho⟩ := h
  have h1 := dateTime?_complete hd (offset_fracFollow ho r)
  rw [List.append_assoc]
  simp [instant?, h1, offset?_complete ho, offset_ok ho]

theorem checkInstant_iff (s : Text) : checkInstant s = true ↔ Instant s := by
  unfold checkInstant
  constructor
  · intro hs
    split at hs
    · rename_i ok heq
      subst hs
      obtain ⟨i, rfl, h⟩ := instant?_sound heq
      simpa using h
    · simp at hs
  · intro h
    have := instant?_complete h []
    simp only [List.append_nil] at this
    simp [this]

/-! ## Zones -/

theorem zoneNameOk_iff (z : Text) : zoneNameOk z = true ↔ ZoneName z := by
  have hfirst : (match z with | c :: _ => isLetter c | [] => false) = true ↔ ∃ c r, z = c :: r ∧ isLetter c = true := by
    cases z <;> simp
  simp only [zoneNameOk, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true, bne_iff_ne, ne_eq,
    ZoneName, ZonePart]
  constructor
  · rintro ⟨⟨hl, hf⟩, hp⟩; exact ⟨hl, hfirst.mp hf, fun p hp' => by have := hp p hp'; simp_all⟩
  · rintro ⟨hl, hf, hp⟩; exact ⟨⟨hl, hfirst.mpr hf⟩, fun p hp' => by have := hp p hp'; simp_all⟩

theorem zoneOk_iff (z : Text) : zoneOk z = true ↔ Zone z := by
  simp [zoneOk, Zone, numOffsetOk_iff, zoneNameOk_iff]

theorem mem_intercalate {x c : Char} {ls : List Text} (h : c ∈ [x].intercalate ls) : c = x ∨ ∃ l ∈ ls, c ∈ l := by
  induction ls with
  | nil => simp at h
  | cons l ls ih =>
    cases ls with
    | nil => simp at h; exact .inr ⟨l, by simp, h⟩
    | cons l' ls' =>
      rw [List.intercalate_cons_cons] at h
      simp only [List.mem_append, List.mem_singleton] at h
      rcases h with (h | h) | h
      · exact .inr ⟨l, by simp, h⟩
      · exact .inl h
      · rcases ih h with h | ⟨l'', hl, hc⟩
        · exact .inl h
        · exact .inr ⟨l'', List.mem_cons_of_mem _ hl, hc⟩

/-- A zone has no `]`, so the closing bracket of a `ZonedDateTime` is the first one. -/
theorem zone_no_bracket {z : Text} (h : Zone z) : ']' ∉ z := by
  intro hm
  rcases h with h | ⟨-, -, hp⟩
  · obtain ⟨sg, a, b, rfl, hs, ha, hb, -⟩ := h
    simp only [List.cons_append, List.mem_cons, List.mem_append] at hm
    rcases hm with h | h | h | h
    · rcases hs with rfl | rfl <;> simp at h
    · have := ha.2 _ h; simp [isDigit] at this
    · simp at h
    · have := hb.2 _ h; simp [isDigit] at this
  · rw [← List.intercalate_splitOn (xs := z) '/'] at hm
    rcases mem_intercalate hm with h | ⟨p, hp', hc⟩
    · simp at h
    · have := (hp p hp').2.2.2 _ hc
      simp [isZoneChar, isLetter, isDigit] at this

theorem checkZoned_iff (s : Text) : checkZoned s = true ↔ ZonedDateTime s := by
  unfold checkZoned
  constructor
  · intro hs
    split at hs
    · rename_i ok r heq
      split at hs
      · rename_i hd
        simp only [Bool.and_eq_true] at hs
        obtain ⟨rfl, hz⟩ := hs
        obtain ⟨i, rfl, hi⟩ := instant?_sound heq
        have hr : r = r.takeWhile (· != ']') ++ [']'] := by
          conv => lhs; rw [← List.takeWhile_append_dropWhile (p := (· != ']')) (l := r)]
          rw [hd]
        generalize r.takeWhile (· != ']') = z at hr hz
        subst hr
        exact ⟨i, z, by simp, hi, (zoneOk_iff _).mp hz⟩
      · simp at hs
    · simp at hs
  · rintro ⟨i, z, rfl, hi, hz⟩
    have hb := zone_no_bracket hz
    obtain ⟨ht, hd⟩ := takeWhile_append (p := (· != ']')) (ds := z) (x := [']'])
      (fun c hc => by simp; rintro rfl; exact hb hc) (by simp)
    have := instant?_complete hi ('[' :: (z ++ [']']))
    simp only [List.append_assoc, List.cons_append] at this ⊢
    simp [this, ht, hd, (zoneOk_iff z).mpr hz]

/-! ## Durations -/

theorem component_sound {u : Char} {t r : Text} {v : Option Nat} (h : component u t = (v, r)) :
    ∃ ct, t = ct ++ r ∧ Component u ct v := by
  unfold component at h
  dsimp only at h
  split at h
  · rename_i c r' hd
    split at h
    · rename_i hc
      simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h
      simp only [Bool.and_eq_true, bne_iff_ne, ne_eq, beq_iff_eq] at hc
      obtain ⟨hne, rfl⟩ := hc
      refine ⟨t.takeWhile isDigit ++ [c], ?_, .some _ ⟨hne, fun x hx => mem_takeWhile hx⟩⟩
      conv => lhs; rw [← List.takeWhile_append_dropWhile (p := isDigit) (l := t), hd]
      simp
    · simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨[], rfl, .none⟩
  · simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨[], rfl, .none⟩

theorem seconds_sound {t r : Text} {v : Option Nat} (h : seconds t = (v, r)) : ∃ ct, t = ct ++ r ∧ Seconds ct v := by
  unfold seconds at h
  dsimp only at h
  split at h
  · rename_i f r' hf
    split at h
    · rename_i hne
      simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h
      obtain ⟨he, hfr⟩ := fraction_sound hf
      refine ⟨t.takeWhile isDigit ++ f ++ ['S'], ?_,
        .some _ _ ⟨by simpa using hne, fun x hx => mem_takeWhile hx⟩ hfr⟩
      conv => lhs; rw [← List.takeWhile_append_dropWhile (p := isDigit) (l := t), he]
      simp
    · simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨[], rfl, .none⟩
  · simp only [Prod.mk.injEq] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨[], rfl, .none⟩

/-- What follows a component that is absent: the end, the `T`, or a later component (`us`: the letters that can end its digits). -/
def Later (us : List Char) (t : Text) : Prop :=
  t = [] ∨ (∃ r, t = 'T' :: r) ∨ ∃ ds c r, t = ds ++ c :: r ∧ Digits1 ds ∧ c ∈ us

theorem component_skip {u : Char} {us : List Char} {t : Text} (h : Later us t) (hu : u ∉ us)
    (hd : ∀ c ∈ us, isDigit c = false) : component u t = (none, t) := by
  rcases h with rfl | ⟨r, rfl⟩ | ⟨ds, c, r, rfl, ⟨hne, hds⟩, hc⟩
  · rfl
  · simp [component, isDigit]
  · obtain ⟨ht, hdw⟩ := takeWhile_append hds (x := c :: r) (by intro x hx; simp at hx; subst hx; exact hd _ hc)
    have : c ≠ u := by rintro rfl; exact hu hc
    simp [component, ht, hdw, this]

theorem component_some {u : Char} {ds : Text} (h : Digits1 ds) (hu : isDigit u = false) (r : Text) :
    component u (ds ++ u :: r) = (some (num ds), r) := by
  obtain ⟨ht, hdw⟩ := takeWhile_append h.2 (x := u :: r) (by intro x hx; simp at hx; subst hx; exact hu)
  simp [component, ht, hdw, h.1]

theorem component_complete {u : Char} {us : List Char} {ct t : Text} {v : Option Nat} (hc : Component u ct v)
    (h : Later us t) (hu : u ∉ us) (hd : ∀ c ∈ us, isDigit c = false) (hud : isDigit u = false) :
    component u (ct ++ t) = (v, t) := by
  cases hc with
  | none => exact component_skip h hu hd
  | some ds hds => rw [List.append_assoc]; exact component_some hds hud t

theorem later_component {u : Char} {us : List Char} {ct t : Text} {v : Option Nat} (hc : Component u ct v)
    (h : Later us t) (hu : u ∈ us) : Later us (ct ++ t) := by
  cases hc with
  | none => exact h
  | some ds hds => exact .inr (.inr ⟨ds, u, t, by simp, hds, hu⟩)

theorem later_mono {us us' : List Char} {t : Text} (h : Later us t) (hs : ∀ c ∈ us, c ∈ us') : Later us' t := by
  rcases h with h | h | ⟨ds, c, r, e, hds, hc⟩
  · exact .inl h
  · exact .inr (.inl h)
  · exact .inr (.inr ⟨ds, c, r, e, hds, hs c hc⟩)

theorem later_seconds {ts : Text} {v : Option Nat} (h : Seconds ts v) : Later ['.', 'S'] ts := by
  cases h with
  | none => exact .inl rfl
  | some ds f hds hf =>
    rcases hf with rfl | ⟨fs, rfl, -⟩
    · exact .inr (.inr ⟨ds, 'S', [], by simp, hds, by simp⟩)
    · exact .inr (.inr ⟨ds, '.', fs ++ ['S'], by simp, hds, by simp⟩)

theorem later_timePart {tt : Text} {h m s : Option Nat} (hp : TimePart tt h m s) : Later [] tt := by
  cases hp with
  | none => exact .inl rfl
  | some => exact .inr (.inl ⟨_, rfl⟩)

theorem seconds_complete {ts : Text} {v : Option Nat} (h : Seconds ts v) : seconds ts = (v, []) := by
  cases h with
  | none => rfl
  | some ds f hds hf =>
    obtain ⟨ht, hdw⟩ := takeWhile_append hds.2 (x := f ++ ['S'])
      (by rcases hf with rfl | ⟨fs, rfl, -⟩ <;> intro x hx <;> simp at hx <;> subst hx <;> decide)
    have hfr := fraction_complete hf (r := ['S']) (by intro c hc; simp at hc; subst hc; decide)
    have hne : (ds != []) = true := by simpa using hds.1
    simp only [List.append_assoc] at ht hdw ⊢
    simp [seconds, ht, hdw, hfr, hne]

theorem durationTime_iff (y mo w d : Option Nat) (t : Text) :
    durationTime y mo w d t = true ↔ ∃ h mi se, TimePart t h mi se ∧
      (y.isSome ∨ mo.isSome ∨ w.isSome ∨ d.isSome ∨ h.isSome ∨ mi.isSome ∨ se.isSome) ∧
      durationBounds y mo w d h mi se = true := by
  constructor
  · intro hd
    unfold durationTime at hd
    split at hd
    · simp only [Bool.and_eq_true, Bool.or_eq_true] at hd
      refine ⟨none, none, none, .none, ?_, hd.2⟩
      rcases hd.1 with ((h | h) | h) | h <;> simp [h]
    · rename_i t'
      dsimp only at hd
      simp only [Bool.and_eq_true, Bool.or_eq_true, List.isEmpty_iff] at hd
      obtain ⟨⟨he, hsome⟩, hb⟩ := hd
      generalize hh : component 'H' t' = ph at he hsome hb
      obtain ⟨h, t1⟩ := ph
      generalize hm : component 'M' t1 = pm at he hsome hb
      obtain ⟨mi, t2⟩ := pm
      generalize hs : seconds t2 = ps at he hsome hb
      obtain ⟨se, t3⟩ := ps
      simp only at he hsome hb
      subst he
      obtain ⟨ch, rfl, hch⟩ := component_sound hh
      obtain ⟨cm, rfl, hcm⟩ := component_sound hm
      obtain ⟨cs, rfl, hcs⟩ := seconds_sound hs
      refine ⟨h, mi, se, ?_, ?_, hb⟩
      · have := TimePart.some ch cm cs h mi se hch hcm hcs (by rcases hsome with (h | h) | h <;> simp [h])
        simpa using this
      · rcases hsome with (h | h) | h <;> simp [h]
    · simp at hd
  · rintro ⟨h, mi, se, hp, hsome, hb⟩
    cases hp with
    | none =>
      simp only [Option.isSome_none, Bool.false_eq_true, or_false] at hsome
      simp only [durationTime, Bool.and_eq_true, Bool.or_eq_true, hb, and_true]
      rcases hsome with h | h | h | h <;> simp [h]
    | some th tm ts h mi se hch hcm hcs hs =>
      have hl := later_seconds hcs
      have e1 := component_complete hch (later_component hcm (later_mono hl (us' := ['M', '.', 'S'])
        (by simp)) (by simp)) (by simp) (by decide) (by decide)
      have e2 := component_complete hcm hl (by simp) (by decide) (by decide)
      have e3 := seconds_complete hcs
      simp only [List.append_assoc] at e1 e2 ⊢
      simp only [List.cons_append, durationTime]
      rw [e1]; dsimp only; rw [e2]; dsimp only; rw [e3]
      simp only [List.isEmpty_nil, Bool.true_and, hb, Bool.and_true, Bool.or_eq_true]
      rcases hs with h | h | h <;> simp [h]

theorem checkDurationBody_iff (t : Text) : checkDurationBody t = true ↔
    ∃ ty tm tw td tt y mo w d h mi se, t = 'P' :: ty ++ tm ++ tw ++ td ++ tt ∧
      Component 'Y' ty y ∧ Component 'M' tm mo ∧ Component 'W' tw w ∧ Component 'D' td d ∧
      TimePart tt h mi se ∧
      (y.isSome ∨ mo.isSome ∨ w.isSome ∨ d.isSome ∨ h.isSome ∨ mi.isSome ∨ se.isSome) ∧
      durationBounds y mo w d h mi se = true := by
  constructor
  · intro hc
    unfold checkDurationBody at hc
    split at hc
    · rename_i t0
      dsimp only at hc
      generalize hy : component 'Y' t0 = py at hc
      obtain ⟨y, t1⟩ := py
      generalize hm : component 'M' t1 = pm at hc
      obtain ⟨mo, t2⟩ := pm
      generalize hw : component 'W' t2 = pw at hc
      obtain ⟨w, t3⟩ := pw
      generalize hd : component 'D' t3 = pd at hc
      obtain ⟨d, t4⟩ := pd
      simp only at hc
      obtain ⟨h, mi, se, htp, hsome, hb⟩ := (durationTime_iff _ _ _ _ _).mp hc
      obtain ⟨cy, rfl, hcy⟩ := component_sound hy
      obtain ⟨cm, rfl, hcm⟩ := component_sound hm
      obtain ⟨cw, rfl, hcw⟩ := component_sound hw
      obtain ⟨cd, rfl, hcd⟩ := component_sound hd
      exact ⟨cy, cm, cw, cd, t4, y, mo, w, d, h, mi, se, by simp, hcy, hcm, hcw, hcd, htp, hsome, hb⟩
    · simp at hc
  · rintro ⟨ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hcy, hcm, hcw, hcd, htp, hsome, hb⟩
    have l0 := later_timePart htp
    have ed := component_complete hcd (later_mono l0 (us' := [])  (by simp)) (by simp) (by simp) (by decide)
    have l1 := later_component hcd (later_mono l0 (us' := ['D']) (by simp)) (by simp)
    have ew := component_complete hcw l1 (by simp) (by decide) (by decide)
    have l2 := later_component hcw (later_mono l1 (us' := ['W', 'D']) (by simp)) (by simp)
    have em := component_complete hcm l2 (by simp) (by decide) (by decide)
    have l3 := later_component hcm (later_mono l2 (us' := ['M', 'W', 'D']) (by simp)) (by simp)
    have ey := component_complete hcy l3 (by simp) (by decide) (by decide)
    simp only [List.append_assoc] at ey em ew ed ⊢
    simp only [List.cons_append, checkDurationBody, ey, em, ew, ed]
    exact (durationTime_iff _ _ _ _ _).mpr ⟨h, mi, se, htp, hsome, hb⟩

theorem checkDuration_iff (s : Text) : checkDuration s = true ↔ Duration s := by
  have hb : ∀ y mo w d h mi se, durationBounds y mo w d h mi se = true ↔
      (y.getD 0 < 2 ^ 32 ∧ mo.getD 0 < 2 ^ 32 ∧ w.getD 0 < 2 ^ 32 ∧
        d.getD 0 * 86400 + h.getD 0 * 3600 + mi.getD 0 * 60 + se.getD 0 < 2 ^ 53) := by
    intros; simp [durationBounds, and_assoc]
  constructor
  · intro hc
    have body : ∀ sg t, s = sg ++ t → (sg = [] ∨ sg = ['-']) → checkDurationBody t = true → Duration s := by
      intro sg t e hsg ht
      obtain ⟨ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hcy, hcm, hcw, hcd, htp, hsome, hbd⟩ :=
        (checkDurationBody_iff t).mp ht
      exact ⟨sg, ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, by simp [e], hsg, hcy, hcm, hcw, hcd, htp, hsome,
        (hb _ _ _ _ _ _ _).mp hbd⟩
    unfold checkDuration at hc
    split at hc
    · exact body ['-'] _ rfl (.inr rfl) hc
    · exact body [] _ rfl (.inl rfl) hc
  · rintro ⟨sg, ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hsg, hcy, hcm, hcw, hcd, htp, hsome, hbd⟩
    have ht := (checkDurationBody_iff ('P' :: ty ++ tm ++ tw ++ td ++ tt)).mpr
      ⟨ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hcy, hcm, hcw, hcd, htp, hsome, (hb _ _ _ _ _ _ _).mpr hbd⟩
    rcases hsg with rfl | rfl
    · simpa [checkDuration] using ht
    · simpa [checkDuration] using ht

/-! ## All types -/

/-- **The checker computes the rules**, for every std/time type. -/
theorem check_iff (ty : TimeType) (s : Text) : check ty s = true ↔ Valid ty s := by
  cases ty
  · exact checkDate_iff s
  · exact checkTime_iff s
  · exact checkDateTime_iff s
  · exact checkInstant_iff s
  · exact checkZoned_iff s
  · exact checkDuration_iff s
  · exact checkYearMonth_iff s
  · exact zoneOk_iff s

instance (ty : TimeType) (s : Text) : Decidable (Valid ty s) :=
  decidable_of_iff _ (check_iff ty s)

end Haus.Time
