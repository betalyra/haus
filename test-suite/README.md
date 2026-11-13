# haus conformance suite

Language-independent tests that every haus parser must pass.

- `valid/NAME.haus` must parse. `valid/NAME.json` is the expected result.
- `valid/NAME.canonical` is the canonical form (spec §12) of each of its
  top-level values, one per line. Bindings that provide `canonical` must
  produce it byte for byte.
- `invalid/NAME.haus` must be rejected: a syntax error, or invalid UTF-8.

Files are raw bytes. Some use CRLF line endings, a BOM or literal tab
characters, so keep them byte-exact. Don't let editors or git rewrite them.

## Expected output encoding

`NAME.json` is a JSON array holding the file's top-level values in order (an
empty file is `[]`). Each value is encoded as:

| haus value             | JSON                                   |
|------------------------|----------------------------------------|
| string                 | JSON string                            |
| array                  | JSON array                             |
| record                 | `{"rec": { "key": value, ... }}`       |
| number                 | `{"num": "literal"}`                   |
| bytes                  | `{"bytes": "hex"}`, lowercase, no spaces |
| variant without payload| `{"tag": "Name"}`                      |
| variant with payload   | `{"tag": "Name", "args": [value, ...]}`|

Number literals are written as exact text, normalised (spec §2): digit
separators removed, the exponent written `e` and its value (`1E+05` → `1e5`),
hex/binary converted to decimal integers (`0xFF` → `255`). Otherwise kept as written (`19.90`
stays `19.90`, `-0` stays `-0`).

`Tag { ... }` and `Tag({ ... })` both encode as a variant with one record arg.

## Limits

Conformance is tested with the default limits from the spec:

| Limit | Default |
|---|---|
| nesting depth | 256 |
| characters in a number literal | 1000 |
| absolute exponent | 6144 |
| characters in a string | 16 Mi |

`valid/limits-boundary.haus` sits exactly at the number limits, and
`invalid/*-too-*.haus` goes one past them.
