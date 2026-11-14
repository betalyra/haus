"""The Python values a schema decodes to, where Python has no type of its own
(spec §15): `Maybe`, variants, unknown values and secrets. Frozen and
matchable:

    >>> from haus.schema import Nothing, Some, Tagged
    >>> def describe(x: object) -> str:
    ...     match x:
    ...         case Some(Nothing()):
    ...             return "Some(None)"
    ...         case Nothing():
    ...             return "None"
    ...         case Tagged("Circle", {"r": r}):
    ...             return f"a circle of radius {r}"
    ...         case _:
    ...             return "something else"
    >>> describe(Some(Nothing())), describe(Nothing()), describe(Tagged("Circle", {"r": 1.5}))
    ('Some(None)', 'None', 'a circle of radius 1.5')
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Generic, TypeAlias, TypeVar

from ._value import Variant

A = TypeVar("A")


@dataclass(frozen=True, slots=True)
class Some(Generic[A]):
    """`Some(x)` of a `Maybe a`."""

    value: A


@dataclass(frozen=True, slots=True)
class Nothing:
    """`None` of a `Maybe a`. Not Python's `None`, so `Some(Nothing())` and `Nothing()` stay apart."""


Maybe: TypeAlias = Some[A] | Nothing
"""`Maybe a`: `Some(value)` or `Nothing()`."""


@dataclass(frozen=True, slots=True)
class Tagged:
    """A case a variant type lists, decoded:

    | Case in the schema       | Data            | Python                              |
    |--------------------------|-----------------|-------------------------------------|
    | `Empty`                  | `Empty`         | `Tagged("Empty")`                   |
    | `Circle { r: Float64 }`  | `Circle { r: 1 }` | `Tagged("Circle", {"r": 1.0})`    |
    | `Point Float64 Float64`  | `Point(1, 2)`   | `Tagged("Point", (1.0, 2.0))`       |
    """

    tag: str
    payload: tuple[object, ...] | Mapping[str, object] = ()
    """`()` without payload, a dict of fields for `Tag { … }`, a tuple of arguments for `Tag A B`."""


@dataclass(frozen=True, slots=True)
class Unknown:
    """A tag an open variant doesn't list, kept exactly as parsed (spec §15). Untrusted data."""

    value: Variant

    @property
    def tag(self) -> str:
        return self.value.tag


_REDACTED = "<redacted>"


class Secret(Generic[A]):
    """A value that must not end up in logs (`Secret a`, spec §15): an API key, a password.

    `str`, `repr`, f-strings and logging show `<redacted>`; `expose()` gives the value out.
    Secrets are equal only to themselves, so comparing them reveals nothing either.

        >>> key = Secret("sk-123")
        >>> key, str(key), f"{key}"
        (Secret(<redacted>), '<redacted>', '<redacted>')
        >>> key.expose()
        'sk-123'
    """

    __slots__ = ("__value",)

    def __init__(self, value: A) -> None:
        self.__value = value

    def expose(self) -> A:
        """The hidden value. The only way to get it."""
        return self.__value

    def __repr__(self) -> str:
        return f"Secret({_REDACTED})"

    def __str__(self) -> str:
        return _REDACTED

    def __format__(self, spec: str) -> str:
        return _REDACTED
