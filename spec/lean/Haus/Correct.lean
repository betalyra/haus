import Haus.Sound.Values
import Haus.Complete.Values

/-!
# The reference parser computes the grammar

Soundness and completeness together: the parser accepts exactly the files
the grammar describes, with the same values.
-/

namespace Haus

theorem parse_correct (L : Limits) (input : Text) (vs : List Value) :
    Parser.parse L input = .ok vs ↔ Grammar.File L input vs :=
  ⟨Sound.parse_sound L input vs, Complete.parse_complete L input vs⟩

/--
**Unambiguity.** A text has at most one meaning: if the grammar derives two
lists of values from it, they are the same. (Whitespace may be split between
rules in more than one way; the values can't differ.)
-/
theorem File.unique {L : Limits} {input : Text} {vs vs' : List Value}
    (h : Grammar.File L input vs) (h' : Grammar.File L input vs') : vs = vs' := by
  have := (parse_correct L input vs).mpr h
  rw [(parse_correct L input vs').mpr h'] at this
  exact (Except.ok.inj this).symm

end Haus
