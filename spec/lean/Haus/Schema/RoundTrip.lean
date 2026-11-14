import Haus.Schema.Correct

/-!
# Encoding fits decoding (spec §15, "Encoding") — I5

For every type of an environment and every value it accepts:

- `decode_encode`: decoding the encoding gives the same decoded value
  (decode, encode, decode is decode);
- `encode_agree`: the encoding is the value itself, except where §15 says
  decoding drops information: fields an open record ignores, the spelling of
  a float, `-0` decoded as an integer (`Agree`).

Both assume `FloatLaw`: the spelling of a decoded float rounds back to it.
It holds on every test (`Haus.Schema.Float`), but is not proven.

`secret_error`: an error inside a `Secret` is the same whatever the value,
so it can't show any part of it.
-/

namespace Haus.Schema
open Haus

/-! ## Encoding, piece by piece -/

theorem encode_hide (x : Typed) : ∀ s, encode (x.hide s) = encode x
  | 0 => rfl
  | s + 1 => by simp only [Typed.hide, encode]; exact encode_hide x s

/-- An integer's literal reads back as the integer. -/
theorem wholeLit_intLit (n : Int) : wholeLit (intLit n).toList = some n := by
  have hd := RoundTrip.toDigits_decimal (n := n.natAbs)
  have hw : wholeDigits (Nat.toDigits 10 n.natAbs) = true := by
    simp only [wholeDigits, Bool.and_eq_true, bne_iff_ne, ne_eq, List.all_eq_true]
    refine ⟨⟨Nat.toDigits_ne_nil, hd⟩, ?_⟩
    rcases Nat.eq_zero_or_pos n.natAbs with h0 | hpos
    · simp [h0]
    · obtain ⟨c, rest, he, hc⟩ := RoundTrip.toDigits_head hpos
      simp [he, hc]
  have hv : digitsValue 10 (Nat.toDigits 10 n.natAbs) = n.natAbs :=
    RoundTrip.digitsValue_toDigits (by decide) (by decide) _
  unfold intLit RoundTrip.intText
  rw [String.toList_ofList]
  by_cases hn : n < 0
  · have h0 : (n.natAbs != 0) = true := by simp; omega
    simp only [hn, decide_true, h0, Bool.and_self, ↓reduceIte, List.cons_append, List.nil_append]
    show (if wholeDigits _ then some _ else none) = _
    simp only [hw, hv, ↓reduceIte]
    congr 1; omega
  · have : (Nat.toDigits 10 n.natAbs).head? ≠ some '-' := RoundTrip.toDigits_not_minus 10 _ (by decide) (by decide)
    simp only [hn, decide_false, Bool.false_and, Bool.false_eq_true, ↓reduceIte, List.nil_append]
    unfold wholeLit
    split
    · rename_i ds he; rw [he] at this; simp at this
    · simp only [hw, hv, ↓reduceIte]
      congr 1; omega

/-- A whole number literal is the literal of its integer, except `-0`. -/
theorem wholeLit_spelling {a : String} {n : Int} (h : wholeLit a.toList = some n) :
    intLit n = a ∨ (a = "-0" ∧ n = 0) := by
  have key : ∀ ds : Text, wholeDigits ds = true → Nat.toDigits 10 (digitsValue 10 ds) = ds := by
    intro ds hw
    simp only [wholeDigits, Bool.and_eq_true, bne_iff_ne, ne_eq, List.all_eq_true, Bool.or_eq_true,
      beq_iff_eq] at hw
    obtain ⟨⟨hne, hd⟩, h0⟩ := hw
    exact RoundTrip.toDigits_digitsValue hne hd fun hh => h0.resolve_left (by simp [hh])
  unfold wholeLit at h
  split at h
  · rename_i ds he
    split at h
    · rename_i hw
      cases h
      have hk := key ds hw
      by_cases h0 : digitsValue 10 ds = 0
      · right
        rw [h0] at hk
        have : a.toList = ['-', '0'] := by rw [he, ← hk]; rfl
        exact ⟨String.toList_inj.mp (by rw [this]; rfl), by omega⟩
      · left
        apply String.toList_inj.mp
        unfold intLit RoundTrip.intText
        rw [String.toList_ofList, he]
        have hneg : (-(digitsValue 10 ds : Int) < 0) = True := by simp; omega
        have h0' : (digitsValue 10 ds != 0) = true := by simpa using h0
        simp only [hneg, decide_true, Int.natAbs_neg, Int.natAbs_natCast, h0', Bool.and_self, ↓reduceIte,
          List.cons_append, List.nil_append, hk]
    · simp at h
  · rename_i ds _
    split at h
    · rename_i hw
      cases h
      left
      apply String.toList_inj.mp
      unfold intLit RoundTrip.intText
      rw [String.toList_ofList]
      have : ¬ ((digitsValue 10 a.toList : Int) < 0) := by omega
      simp only [this, decide_false, Bool.false_and, Bool.false_eq_true, ↓reduceIte, List.nil_append,
        Int.natAbs_natCast, key _ hw]
    · simp at h

theorem missing?_eq_none {fields : List Field} {fs : List (String × Value)} :
    missing? fields fs = none ↔ ∀ f ∈ fields, f.optional = false → ∃ v, (f.key, v) ∈ fs := by
  simp only [missing?, Option.map_eq_none_iff, List.find?_eq_none]
  constructor
  · intro h f hf ho
    have := h f hf
    rw [ho] at this
    simp only [Bool.not_false, Bool.true_and, Bool.not_eq_true', Bool.not_eq_false] at this
    obtain ⟨⟨k, v⟩, hm, hk⟩ := List.any_eq_true.mp this
    simp only [beq_iff_eq] at hk
    subst hk; exact ⟨v, hm⟩
  · intro h f hf
    cases ho : f.optional
    · obtain ⟨v, hm⟩ := h f hf ho
      have : fs.any (·.1 == f.key) = true := List.any_eq_true.mpr ⟨_, hm, by simp⟩
      simp [this]
    · simp

theorem fieldOf?_some {fields : List Field} {f : Field} (hf : f ∈ fields) : ∃ g, fieldOf? fields f.key = some g := by
  unfold fieldOf?
  cases h : fields.find? (·.key == f.key) with
  | some g => exact ⟨g, rfl⟩
  | none => exact absurd hf (by simpa using List.find?_eq_none.mp h f)

/-- A field the type lists and the record has is kept. -/
theorem Fields.keeps {env : Env} {closed : Bool} {fields : List Field} {fs : List (String × Value)}
    {ys : List (String × Typed)} : Fields env closed fields fs ys →
    ∀ {k v g}, (k, v) ∈ fs → fieldOf? fields k = some g → ∃ y, (k, y) ∈ ys
  | .nil, _, _, _, h, _ => by simp at h
  | .keep (k := k') (y := y') _ _ hs, k, v, g, h, hg => by
    rcases List.mem_cons.mp h with h | h
    · cases h; exact ⟨y', by simp⟩
    · obtain ⟨y, hy⟩ := hs.keeps h hg; exact ⟨y, by simp [hy]⟩
  | .skip hf hs, k, v, g, h, hg => by
    rcases List.mem_cons.mp h with h | h
    · cases h; rw [hf] at hg; cases hg
    · exact hs.keeps h hg

theorem mem_encodeFields {k : String} {y : Typed} :
    ∀ {ys : List (String × Typed)}, (k, y) ∈ ys → (k, encode y) ∈ encodeFields ys
  | [], h => by simp at h
  | (k', y') :: ys, h => by
    rcases List.mem_cons.mp h with h | h
    · cases h; simp [encodeFields]
    · simp [encodeFields, mem_encodeFields h]

/-- Every required field is still there after encoding. -/
theorem Fields.missing {env : Env} {closed : Bool} {fields : List Field} {fs : List (String × Value)}
    {ys : List (String × Typed)} (hf : Fields env closed fields fs ys) (hm : missing? fields fs = none) :
    missing? fields (encodeFields ys) = none := by
  rw [missing?_eq_none] at hm ⊢
  intro f hmem ho
  obtain ⟨v, hv⟩ := hm f hmem ho
  obtain ⟨g, hg⟩ := fieldOf?_some hmem
  obtain ⟨y, hy⟩ := hf.keeps hv hg
  exact ⟨_, mem_encodeFields hy⟩

theorem floatTag?_encode {tag : String} {x : Flt} (k : FloatType) (h : floatTag? tag = some x) :
    encodeFloat k x = .variant tag [] := by
  unfold floatTag? at h
  split at h <;> cases h <;> rfl

/-! ## Decode, encode, decode is decode -/

mutual
/-- The encoding of a decoded value decodes to it by the same rules. -/
theorem Dec.encode (hF : FloatLaw) {env : Env} {t : Ty} {v : Value} {x : Typed} :
    Dec env t v x → Dec env t (encode x) x
  | .intro hw hc => by rw [encode_hide]; exact .intro hw (hc.encode hF)

theorem Core.encode (hF : FloatLaw) {env : Env} {c : Ty} {v : Value} {x : Typed} :
    Core env c v x → Core env c (Schema.encode x) x
  | .string s => .string s
  | .bytes bs => .bytes bs
  | .int (n := n) _ hr => .int (wholeLit_intLit n) hr
  | .float (k := k) (a := a) (x := x) hx => by
    obtain ⟨n, m, q, rfl⟩ := roundLit_fin hx
    exact .float (hF k a _ hx)
  | .floatTag (k := k) hx => by
    show Core env _ (encodeFloat k _) _
    rw [floatTag?_encode k hx]; exact .floatTag hx
  | .decimal a => .decimal a
  | .any v => .any v
  | .time hc => .time hc
  | .array hi => .array (hi.encode hF)
  | .map he => .map (he.encode hF)
  | .record hm hf => .record (hf.missing hm) (hf.encode hF)
  | .bare hc => .bare hc
  | .recordCase hc hd => .recordCase hc (hd.encode hF)
  | .positional hc ha => .positional hc (ha.encode hF)
  | .unknown hc => .unknown hc

theorem Items.encode (hF : FloatLaw) {env : Env} {t : Ty} {xs : List Value} {ys : List Typed} :
    Items env t xs ys → Items env t (encodeList ys) ys
  | .nil => .nil
  | .cons hx hs => .cons (hx.encode hF) (hs.encode hF)

theorem Entries.encode (hF : FloatLaw) {env : Env} {t : Ty} {fs : List (String × Value)}
    {ys : List (String × Typed)} : Entries env t fs ys → Entries env t (encodeFields ys) ys
  | .nil => .nil
  | .cons hx hs => .cons (hx.encode hF) (hs.encode hF)

theorem Fields.encode (hF : FloatLaw) {env : Env} {closed : Bool} {fields : List Field}
    {fs : List (String × Value)} {ys : List (String × Typed)} :
    Fields env closed fields fs ys → Fields env closed fields (encodeFields ys) ys
  | .nil => .nil
  | .keep hf hx hs => .keep hf (hx.encode hF) (hs.encode hF)
  | .skip _ hs => hs.encode hF

theorem Args.encode (hF : FloatLaw) {env : Env} {ts : List Ty} {xs : List Value} {ys : List Typed} :
    Args env ts xs ys → Args env ts (encodeList ys) ys
  | .nil => .nil
  | .cons hx hs => .cons (hx.encode hF) (hs.encode hF)
end

/--
**Decode, encode, decode is decode** (§15, I5): if `t` accepts `v` as `x`,
it accepts the encoding of `x`, again as `x`.
-/
theorem decode_encode (hF : FloatLaw) {env : Env} {t : Ty} {v : Value} {x : Typed}
    (h : decode env t v = .ok x) : decode env t (encode x) = .ok x :=
  ((decode_sound h).encode hF).decode

/-! ## Encode after decode is the input, except where §15 says -/

mutual
theorem Dec.agree (hF : FloatLaw) {env : Env} {t : Ty} {v : Value} {x : Typed} :
    Dec env t v x → Agree env t v (encode x)
  | .intro hw hc => by rw [encode_hide]; exact .intro hw (hc.agree hF)

theorem Core.agree (hF : FloatLaw) {env : Env} {c : Ty} {v : Value} {x : Typed} :
    Core env c v x → AgreeCore env c v (Schema.encode x)
  | .string s => .same _ _
  | .bytes bs => .same _ _
  | .int (k := k) hn _ => by
    rcases wholeLit_spelling hn with h | ⟨rfl, rfl⟩
    · show AgreeCore env _ _ (.num (intLit _)); rw [h]; exact .same _ _
    · exact .negZero k
  | .float (k := k) (a := a) (x := x) hx => by
    obtain ⟨n, m, q, rfl⟩ := roundLit_fin hx
    exact .float hx (hF k a _ hx)
  | .floatTag (k := k) hx => by
    show AgreeCore env _ _ (encodeFloat k _)
    rw [floatTag?_encode k hx]; exact .same _ _
  | .decimal a => .same _ _
  | .any v => .same _ _
  | .time _ => .same _ _
  | .array hi => .array (hi.agree hF)
  | .map he => .map (he.agree hF)
  | .record _ hf => .record (hf.agree hF)
  | .bare _ => .same _ _
  | .recordCase hc hd => .recordCase hc (hd.agree hF)
  | .positional hc ha => .positional hc (ha.agree hF)
  | .unknown _ => .same _ _

theorem Items.agree (hF : FloatLaw) {env : Env} {t : Ty} {xs : List Value} {ys : List Typed} :
    Items env t xs ys → AgreeItems env t xs (encodeList ys)
  | .nil => .nil
  | .cons hx hs => .cons (hx.agree hF) (hs.agree hF)

theorem Entries.agree (hF : FloatLaw) {env : Env} {t : Ty} {fs : List (String × Value)}
    {ys : List (String × Typed)} : Entries env t fs ys → AgreeEntries env t fs (encodeFields ys)
  | .nil => .nil
  | .cons hx hs => .cons (hx.agree hF) (hs.agree hF)

theorem Fields.agree (hF : FloatLaw) {env : Env} {closed : Bool} {fields : List Field}
    {fs : List (String × Value)} {ys : List (String × Typed)} :
    Fields env closed fields fs ys → AgreeFields env closed fields fs (encodeFields ys)
  | .nil => .nil
  | .keep hf hx hs => .keep hf (hx.agree hF) (hs.agree hF)
  | .skip hf hs => .drop hf (hs.agree hF)

theorem Args.agree (hF : FloatLaw) {env : Env} {ts : List Ty} {xs : List Value} {ys : List Typed} :
    Args env ts xs ys → AgreeArgs env ts xs (encodeList ys)
  | .nil => .nil
  | .cons hx hs => .cons (hx.agree hF) (hs.agree hF)
end

/--
**Encode after decode** (§15, I5): the encoding of a decoded value is the
value, except for the fields an open record ignores, the spelling of floats
and `-0` decoded as an integer.
-/
theorem encode_agree (hF : FloatLaw) {env : Env} {t : Ty} {v : Value} {x : Typed}
    (h : decode env t v = .ok x) : Agree env t v (encode x) :=
  (decode_sound h).agree hF

/-! ## Secrets -/

/--
An error inside a `Secret` is the same for every value (§15, "Secrets"):
its place and the type, nothing taken from the value.
-/
theorem hidden_error {s : Nat} {c : Ty} {r : Except Error Typed} {e : Error}
    (h : hidden (s + 1) c r = .error e) : e = secretError c := by
  cases r <;> simp [hidden] at h; exact h.symm

theorem secret_error {env : Env} {t c : Ty} {s : Nat} {v : Value} {e : Error}
    (hw : whnf env env.fuel t = .ok (s + 1, c)) (h : decode env t v = .error e) : e = secretError c := by
  rw [decode, hw] at h
  exact hidden_error h

end Haus.Schema
