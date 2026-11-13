import Haus.Parser
import Haus.Lists

/-!
# Reasoning about parsers

A parser `P α` is a function from the remaining input to `Except Error (α × Text)`.
These lemmas say what its primitives do to the input; each holds by definition.
They let `simp` turn a statement about a parser into one about lists.
-/

namespace Haus.Sound
open Haus Parser

@[simp] theorem run_bind {α β : Type} (x : P α) (f : α → P β) (t : Text) :
    (x >>= f).run t = match x.run t with
      | .error e => .error e
      | .ok v => (f v.1).run v.2 := by
  simp only [StateT.run, bind, StateT.bind]
  cases x t <;> rfl

@[simp] theorem except_error_bind {α β : Type} (e : Error) (f : α → Except Error β) :
    (Except.error e >>= f) = .error e := rfl
@[simp] theorem except_ok_bind {α β : Type} (a : α) (f : α → Except Error β) :
    (Except.ok a >>= f : Except Error β) = f a := rfl

@[simp] theorem except_map_error {α β : Type} (e : Error) (f : α → β) :
    (f <$> (Except.error e : Except Error α)) = .error e := rfl
@[simp] theorem except_map_ok {α β : Type} (a : α) (f : α → β) :
    (f <$> (Except.ok a : Except Error α)) = .ok (f a) := rfl

@[simp] theorem except_pure {α : Type} (a : α) : (pure a : Except Error α) = .ok a := rfl

@[simp] theorem run_ite {α : Type} (c : Prop) [Decidable c] (x y : P α) (t : Text) :
    (if c then x else y).run t = if c then x.run t else y.run t := by
  split <;> rfl

@[simp] theorem run_get (t : Text) : (get : P Text).run t = .ok (t, t) := rfl
@[simp] theorem run_set (s t : Text) : (set s : P Unit).run t = .ok ((), s) := rfl
@[simp] theorem run_pure {α : Type} (a : α) (t : Text) : (pure a : P α).run t = .ok (a, t) := rfl
@[simp] theorem run_map {α β : Type} (f : α → β) (x : P α) (t : Text) :
    (f <$> x).run t = (x.run t).map fun (a, t') => (f a, t') := by
  simp only [StateT.run, Functor.map, StateT.map, Except.map]
  cases x t <;> rfl
@[simp] theorem run_fail {α : Type} (r : String) (t : Text) : (fail r : P α).run t = .error (.at r t) := rfl
@[simp] theorem run_failAt {α : Type} (r : String) (u t : Text) : (failAt r u : P α).run t = .error (.at r u) := rfl

@[simp] theorem run_skip (n : Nat) (t : Text) : (skip n).run t = .ok ((), t.drop n) := rfl

@[simp] theorem run_takeWhile (p : Char → Bool) (t : Text) :
    (takeWhile p).run t = .ok (t.takeWhile p, t.dropWhile p) := rfl

@[simp] theorem run_liftM {α : Type} (e : Except Error α) (t : Text) :
    (liftM e : P α).run t = match e with
      | .ok a => .ok (a, t)
      | .error err => .error err := by
  cases e <;> rfl

@[simp] theorem run_throw {α : Type} (e : Error) (t : Text) : (throw e : P α).run t = .error e := rfl

/-- Running a parser for its result only. -/
theorem run'_eq {α : Type} (x : P α) (t : Text) : x.run' t = (x.run t).map Prod.fst := by
  simp only [StateT.run', StateT.run, Functor.map]

end Haus.Sound
