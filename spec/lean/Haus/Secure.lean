import Haus.Sound.Values
import Haus.Props.Chars
import Haus.Props.Values

/-!
# What the reference parser guarantees

Soundness (`parse_sound`) carries the properties proven for the grammar over
to everything the reference parser accepts.
-/

namespace Haus
open Grammar Parser Sound

variable {L : Limits} {input : Text} {vs : List Value}

/-- A1: an accepted input contains no raw bidi control character. -/
theorem parse_noBidi (h : parse L input = .ok vs) : ∀ c ∈ input, isBidi c = false :=
  (parse_sound L input vs h).noBidi

/-- A2: the only control characters in an accepted input are tab, LF and CR. -/
theorem parse_controls (h : parse L input = .ok vs) :
    ∀ c ∈ input, isRawControl c = true → c = '\t' ∨ c = '\n' ∨ c = '\r' :=
  (parse_sound L input vs h).controls

/-- A3: every record the parser returns, at any depth, has unique keys. -/
theorem parse_uniqueKeys (h : parse L input = .ok vs) : ∀ v ∈ vs, UniqueKeys v :=
  (parse_sound L input vs h).uniqueKeys

/-- A4: every value the parser returns is within the limits. -/
theorem parse_bounded (h : parse L input = .ok vs) : ∀ v ∈ vs, Bounded L L.maxDepth v :=
  (parse_sound L input vs h).bounded

end Haus
