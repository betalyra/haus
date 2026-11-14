import Haus.Schema.Rules

/-!
# The decoder computes the rules

`decode_iff`: `decode env t v = .ok x` exactly when `Dec env t v x`. Soundness
follows the decoder's own recursion (its functional induction principle),
completeness the rules' derivation.
-/

namespace Haus.Schema
open Haus

/-! ## Results -/

theorem under_ok {α : Type} {s : Seg} {r : Except Error α} {x : α} : under s r = .ok x ↔ r = .ok x := by
  cases r <;> simp [under]

theorem map_ok {α β : Type} {f : α → β} {r : Except Error α} {x : β} :
    r.map f = .ok x ↔ ∃ y, r = .ok y ∧ f y = x := by
  cases r <;> simp [Except.map]

theorem bind_ok {α β : Type} {f : α → Except Error β} {r : Except Error α} {x : β} :
    r >>= f = .ok x ↔ ∃ y, r = .ok y ∧ f y = .ok x := by
  cases r <;> simp [bind, Except.bind]

theorem fail_ne_ok {α : Type} {reason : String} {x : α} : (fail reason : Except Error α) ≠ .ok x := by
  simp [fail]

theorem hidden_ok {s : Nat} {c : Ty} {r : Except Error Typed} {x : Typed} :
    hidden s c r = .ok x ↔ ∃ y, r = .ok y ∧ x = y.hide s := by
  cases s with
  | zero => simp [hidden, Typed.hide]
  | succ s => cases r <;> simp [hidden, eq_comm]

/-! ## Soundness -/

/-- What `decode` and its helpers return are decodings by the rules. -/
theorem decode_sound_all (env : Env) :
    (∀ t v x, decode env t v = .ok x → Dec env t v x) ∧
    (∀ tag i ts xs ys, decodeArgs env tag i ts xs = .ok ys → xs.length = ts.length → Args env ts xs ys) ∧
    (∀ closed fields fs ys, decodeFields env closed fields fs = .ok ys → Fields env closed fields fs ys) ∧
    (∀ t fs ys, decodeEntries env t fs = .ok ys → Entries env t fs ys) ∧
    (∀ t i xs ys, decodeItems env t i xs = .ok ys → Items env t xs ys) := by
  refine decode.mutual_induct env
    (fun t v => ∀ x, decode env t v = .ok x → Dec env t v x)
    (fun tag i ts xs => ∀ ys, decodeArgs env tag i ts xs = .ok ys → xs.length = ts.length → Args env ts xs ys)
    (fun closed fields fs => ∀ ys, decodeFields env closed fields fs = .ok ys → Fields env closed fields fs ys)
    (fun t fs => ∀ ys, decodeEntries env t fs = .ok ys → Entries env t fs ys)
    (fun t i xs => ∀ ys, decodeItems env t i xs = .ok ys → Items env t xs ys)
    ?whnfErr ?main ?argsCons ?argsEnd ?itemsNil ?itemsCons ?fieldsNil ?fieldsKeep ?fieldsClosed ?fieldsSkip
    ?entriesNil ?entriesCons
  case whnfErr =>
    intro v t r hw x h
    rw [decode, hw] at h
    exact absurd h fail_ne_ok
  case main =>
    intro v t s c hw ih x h
    rw [decode, hw] at h
    obtain ⟨y, hy, rfl⟩ := hidden_ok.mp h
    refine Dec.intro hw ?_
    clear h
    split at hy
    next => cases hy; exact .string _
    next => cases hy; exact .bytes _
    next =>
      split at hy
      next hn =>
        split at hy
        next hr => cases hy; exact .int hn hr
        next => exact absurd hy fail_ne_ok
      next => exact absurd hy fail_ne_ok
    next =>
      split at hy
      next hx => cases hy; exact .float hx
      next => exact absurd hy fail_ne_ok
    next =>
      split at hy
      next hx => cases hy; exact .floatTag hx
      next => exact absurd hy fail_ne_ok
    next => cases hy; exact .decimal _
    next => cases hy; exact .any _
    next =>
      split at hy
      next hc =>
        simp only [Bool.and_eq_true, beq_iff_eq] at hc
        obtain ⟨rfl, hc⟩ := hc
        cases hy; exact .time hc
      next => exact absurd hy fail_ne_ok
    next =>
      obtain ⟨ys, h1, rfl⟩ := map_ok.mp hy
      exact .array (ih ys h1)
    next =>
      obtain ⟨ys, h1, rfl⟩ := map_ok.mp hy
      exact .map (ih ys h1)
    next =>
      split at hy
      next => exact absurd hy fail_ne_ok
      next hm =>
        obtain ⟨ys, h1, rfl⟩ := map_ok.mp hy
        exact .record hm (ih ys h1)
    next =>
      split at hy
      next hc => cases hy; exact .bare hc
      next hc =>
        simp only [hc] at ih
        obtain ⟨y, h1, rfl⟩ := map_ok.mp (under_ok.mp hy)
        exact .recordCase hc (ih y h1)
      next hc =>
        simp only [hc] at ih
        split at hy
        next hl =>
          obtain ⟨ys, h1, rfl⟩ := map_ok.mp hy
          exact .positional hc (ih ys h1 hl)
        next => exact absurd hy fail_ne_ok
      next => exact absurd hy fail_ne_ok
      next => exact absurd hy fail_ne_ok
      next hc =>
        split at hy
        next => exact absurd hy fail_ne_ok
        next hcl =>
          simp only [Bool.not_eq_true] at hcl
          subst hcl
          cases hy; exact .unknown hc
    next => exact absurd hy fail_ne_ok
  case argsCons =>
    intro tag i t ts x xs ihx ihs ys h hl
    simp only [decodeArgs, bind_ok, under_ok] at h
    obtain ⟨y, hy, ys', hys, h⟩ := h
    cases h
    exact .cons (ihx _ hy) (ihs _ hys (by simpa using hl))
  case argsEnd =>
    intro xs tag i ts hne ys h hl
    cases xs <;> cases ts
    · simp [decodeArgs] at h; subst h; exact .nil
    · simp at hl
    · simp at hl
    · exact absurd rfl (hne _ _ _ _ rfl)
  case itemsNil =>
    intro t i ys h
    simp [decodeItems] at h; subst h; exact .nil
  case itemsCons =>
    intro t i x xs ihx ihs ys h
    simp only [decodeItems, bind_ok, under_ok] at h
    obtain ⟨y, hy, ys', hys, h⟩ := h
    cases h
    exact .cons (ihx _ hy) (ihs _ hys)
  case fieldsNil =>
    intro closed fields ys h
    simp [decodeFields] at h; subst h; exact .nil
  case fieldsKeep =>
    intro closed fields k x fs f hf ihx ihs ys h
    simp only [decodeFields, hf, bind_ok, under_ok] at h
    obtain ⟨y, hy, ys', hys, h⟩ := h
    cases h
    exact .keep hf (ihx _ hy) (ihs _ hys)
  case fieldsClosed =>
    intro fields k x fs hf ys h
    simp [decodeFields, hf] at h
  case fieldsSkip =>
    intro closed fields k x fs hf hc ihs ys h
    simp only [decodeFields, hf, hc, Bool.false_eq_true, ↓reduceIte] at h
    simp only [Bool.not_eq_true] at hc
    subst hc
    exact .skip hf (ihs _ h)
  case entriesNil =>
    intro t ys h
    simp [decodeEntries] at h; subst h; exact .nil
  case entriesCons =>
    intro t k x fs ihx ihs ys h
    simp only [decodeEntries, bind_ok, under_ok] at h
    obtain ⟨y, hy, ys', hys, h⟩ := h
    cases h
    exact .cons (ihx _ hy) (ihs _ hys)

theorem decode_sound {env : Env} {t : Ty} {v : Value} {x : Typed} (h : decode env t v = .ok x) :
    Dec env t v x :=
  (decode_sound_all env).1 t v x h

/-! ## Completeness -/

theorem Args.length_eq {env : Env} {ts : List Ty} {xs : List Value} {ys : List Typed} :
    Args env ts xs ys → xs.length = ts.length
  | .nil => rfl
  | .cons _ h => by simp [h.length_eq]

/-- The core result inside the secrets. -/
theorem hidden_of {s : Nat} {c : Ty} {r : Except Error Typed} {x : Typed} (h : r = .ok x) :
    hidden s c r = .ok (x.hide s) := hidden_ok.mpr ⟨x, h, rfl⟩

mutual
theorem Dec.decode {env : Env} {t : Ty} {v : Value} {x : Typed} : Dec env t v x → decode env t v = .ok x
  | .intro hw hc => hc.decode hw

theorem Core.decode {env : Env} {c t : Ty} {s : Nat} {v : Value} {x : Typed} :
    Core env c v x → whnf env env.fuel t = .ok (s, c) → decode env t v = .ok (x.hide s)
  | .string _, hw => by rw [decode, hw]; exact hidden_of rfl
  | .bytes _, hw => by rw [decode, hw]; exact hidden_of rfl
  | .int hn hr, hw => by rw [decode, hw]; exact hidden_of (by simp [hn, hr])
  | .float hx, hw => by rw [decode, hw]; exact hidden_of (by simp [hx])
  | .floatTag hx, hw => by rw [decode, hw]; exact hidden_of (by simp [hx])
  | .decimal _, hw => by rw [decode, hw]; exact hidden_of rfl
  | .any v, hw => by rw [decode, hw]; cases v <;> exact hidden_of rfl
  | .time hc, hw => by rw [decode, hw]; exact hidden_of (by simp [hc])
  | .array hi, hw => by rw [decode, hw]; exact hidden_of (by simp [hi.decode 0, Except.map])
  | .map he, hw => by rw [decode, hw]; exact hidden_of (by simp [he.decode, Except.map])
  | .record hm hf, hw => by rw [decode, hw]; exact hidden_of (by simp [hm, hf.decode, Except.map])
  | .bare hc, hw => by rw [decode, hw]; exact hidden_of (by simp [hc])
  | .recordCase hc hd, hw => by
    rw [decode, hw]; exact hidden_of (by simp [hc, hd.decode, Except.map, under])
  | .positional hc ha, hw => by
    rw [decode, hw]; exact hidden_of (by simp [hc, ha.length_eq, ha.decode 0, Except.map])
  | .unknown hc, hw => by rw [decode, hw]; exact hidden_of (by simp [hc])

theorem Items.decode {env : Env} {t : Ty} {xs : List Value} {ys : List Typed} :
    Items env t xs ys → ∀ i, decodeItems env t i xs = .ok ys
  | .nil, _ => rfl
  | .cons hx hs, i => by simp [decodeItems, hx.decode, hs.decode (i + 1), under, bind, Except.bind, pure, Except.pure]

theorem Entries.decode {env : Env} {t : Ty} {fs : List (String × Value)} {ys : List (String × Typed)} :
    Entries env t fs ys → decodeEntries env t fs = .ok ys
  | .nil => rfl
  | .cons hx hs => by simp [decodeEntries, hx.decode, hs.decode, under, bind, Except.bind, pure, Except.pure]

theorem Fields.decode {env : Env} {closed : Bool} {fields : List Field} {fs : List (String × Value)}
    {ys : List (String × Typed)} : Fields env closed fields fs ys → decodeFields env closed fields fs = .ok ys
  | .nil => rfl
  | .keep hf hx hs => by
    simp [decodeFields, hf, hx.decode, hs.decode, under, bind, Except.bind, pure, Except.pure]
  | .skip hf hs => by simp [decodeFields, hf, hs.decode]

theorem Args.decode {env : Env} {ts : List Ty} {xs : List Value} {ys : List Typed} :
    Args env ts xs ys → ∀ {tag : String} (i : Nat), decodeArgs env tag i ts xs = .ok ys
  | .nil, _, _ => rfl
  | .cons hx hs, _, i => by
    simp [decodeArgs, hx.decode, hs.decode (i + 1), under, bind, Except.bind, pure, Except.pure]
end

/-- **The decoder computes the rules** of §15: it accepts `v` with `x` exactly when they say so. -/
theorem decode_iff {env : Env} {t : Ty} {v : Value} {x : Typed} : decode env t v = .ok x ↔ Dec env t v x :=
  ⟨decode_sound, Dec.decode⟩

end Haus.Schema
