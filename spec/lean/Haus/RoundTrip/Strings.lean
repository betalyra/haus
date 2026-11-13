import Haus.Grammar
import Haus.Canonical
import Haus.RoundTrip.Digits

/-!
# Strings, keys and byte strings in canonical form

Each character is written as itself when a string may contain it raw, and
as an escape for exactly that character otherwise; each byte as two hex
digits for exactly that byte.
-/

namespace Haus.RoundTrip
open Haus Grammar Canonical

variable {L : Limits}

theorem hexDigit_lt : ∀ d < 16, hexValue (hexDigit d) = d ∧ isHexDigit (hexDigit d) = true := by decide

/-- A character is a Unicode scalar value: below U+110000 and not a surrogate. -/
theorem char_valid (c : Char) : c.toNat < 0xd800 ∨ (0xdfff < c.toNat ∧ c.toNat < 0x110000) := by
  have := c.valid
  simpa [UInt32.isValidChar, Nat.isValidChar] using this

/-- A `\u{…}` escape for `c`: its hex digits read back as `c`. -/
theorem unicodeEscape (c : Char) :
    Escape (['\\', 'u', '{'] ++ (Nat.toDigits 16 c.toNat).map Char.toUpper ++ ['}']) c := by
  have hv := digitsValue_map_toDigits (b := 16) (by decide) (by decide) Char.toUpper hexValue_toUpper_digitChar c.toNat
  have hlen : (Nat.toDigits 16 c.toNat).length ≤ 6 :=
    (Nat.length_toDigits_le_iff (by decide) (by decide)).mpr (by have := char_valid c; omega)
  have hne : Nat.toDigits 16 c.toNat ≠ [] := Nat.toDigits_ne_nil
  have := Escape.unicode ((Nat.toDigits 16 c.toNat).map Char.toUpper)
    (by simp; exact List.length_pos_iff.mpr hne) (by simpa using hlen)
    (by
      intro d hd
      obtain ⟨d', hd', rfl⟩ := List.mem_map.mp hd
      obtain ⟨n, hn, rfl⟩ := mem_toDigits (by decide) hd'
      exact isHexDigit_toUpper_digitChar n hn)
    (by
      rw [hv]
      simp only [isScalar, Bool.and_eq_true, decide_eq_true_eq, Bool.not_eq_true', Bool.and_eq_false_iff,
        decide_eq_false_iff_not]
      have := char_valid c; omega)
  rwa [hv, Char.ofNat_toNat] at this

/-- Every character is written as itself (allowed raw in a string) or as an escape for it. -/
theorem escape_ok (c : Char) : (escape c = [c] ∧ BasicChar c) ∨ Escape (escape c) c := by
  by_cases h1 : c = '"'
  · subst h1; exact .inr .quote
  by_cases h2 : c = '\\'
  · subst h2; exact .inr .backslash
  by_cases h3 : c = '\n'
  · subst h3; exact .inr .newline
  by_cases h4 : c = '\r'
  · subst h4; exact .inr .cr
  by_cases h5 : c = '\t'
  · subst h5; exact .inr .tab
  have e : escape c = if isRawControl c || isBidi c then
      ['\\', 'u', '{'] ++ (Nat.toDigits 16 c.toNat).map Char.toUpper ++ ['}'] else [c] := by
    unfold escape; split <;> simp_all
  rw [e]
  split
  · exact .inr (unicodeEscape c)
  · rename_i h
    simp only [Bool.or_eq_true, not_or, Bool.not_eq_true] at h
    exact .inl ⟨rfl, h1, h2, h.1, h.2⟩

theorem chars_escape : ∀ cs : Text, Chars BasicChar (cs.flatMap escape) cs
  | [] => .nil
  | c :: cs => by
    rw [List.flatMap_cons]
    rcases escape_ok c with ⟨he, hb⟩ | he
    · rw [he]; exact .char c _ cs hb (chars_escape cs)
    · exact .escape _ c _ cs he (chars_escape cs)

theorem basicString_canonical (s : String) (h : s.length ≤ L.maxStringLength) :
    BasicString L (Canonical.string s) s := by
  have := BasicString.mk (L := L) _ s.toList (chars_escape s.toList) (by rw [String.length_toList]; exact h)
  simpa [Canonical.string] using this

theorem string_canonical (s : String) (h : s.length ≤ L.maxStringLength) (n : Nat) :
    Val L n (Canonical.string s) (.str s) :=
  .string n _ s (basicString_canonical s h)

/-- A key, written canonically, is still a key: bare if it can be, quoted otherwise. -/
theorem key_canonical {k : Text} {s : String} (h : Key L k s) : Key L (Canonical.key s) s := by
  by_cases hi : isIdent s = true
  · have hid : Ident s.toList := by
      unfold isIdent at hi
      split at hi
      · rename_i c cs heq
        simp only [Bool.and_eq_true, List.all_eq_true] at hi
        exact ⟨c, cs, heq, hi.1, hi.2⟩
      · simp at hi
    simpa [Canonical.key, hi] using Key.ident (L := L) s.toList hid
  · cases h with
    | ident ht =>
      exfalso; apply hi
      obtain ⟨c, cs, rfl, hc, hcs⟩ := ht
      simp [isIdent, hc, List.all_eq_true.mpr hcs]
    | quoted _ hs =>
      have hl : s.length ≤ L.maxStringLength := by
        cases hs with
        | mk raw s' _ hl => simpa using hl
      simpa [Canonical.key, hi] using Key.quoted (L := L) _ s (basicString_canonical s hl)

/-! ## Byte strings -/

theorem byteChars_length {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) : 2 * bs.length ≤ raw.length := by
  induction h with
  | nil => simp
  | blank _ _ _ _ _ ih => simp; omega
  | byte _ _ _ _ _ _ _ ih => simp; omega

/-- The bytes written as hex pairs read back as the same bytes. -/
theorem byteChars_canonical : ∀ bs : List UInt8,
    ByteChars (bs.flatMap fun b => [hexDigit (b.toNat / 16), hexDigit (b.toNat % 16)]) bs
  | [] => .nil
  | b :: bs => by
    have hb := b.toNat_lt
    obtain ⟨h1, h2⟩ := hexDigit_lt (b.toNat / 16) (by omega)
    obtain ⟨h3, h4⟩ := hexDigit_lt (b.toNat % 16) (by omega)
    have := ByteChars.byte _ _ _ bs h2 h4 (byteChars_canonical bs)
    rw [h1, h3, show b.toNat / 16 * 16 + b.toNat % 16 = b.toNat by omega, UInt8.ofNat_toNat] at this
    simpa using this

theorem hexPairs_length : ∀ bs : List UInt8,
    (bs.flatMap fun b => [hexDigit (b.toNat / 16), hexDigit (b.toNat % 16)]).length = 2 * bs.length
  | [] => rfl
  | b :: bs => by rw [List.flatMap_cons, List.length_append, hexPairs_length bs]; simp; omega

theorem bytes_canonical {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) (hl : raw.length ≤ L.maxStringLength)
    (n : Nat) : Val L n (Canonical.bytes bs) (.bytes bs) := by
  have hlen := byteChars_length h
  have := Val.bytes (L := L) n _ bs (byteChars_canonical bs) (by rw [hexPairs_length]; omega)
  simpa [Canonical.bytes] using this

end Haus.RoundTrip
