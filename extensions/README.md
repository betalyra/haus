# Official extensions

Ordinary haus schemas, maintained with haus (spec §13). Each one is a
language-neutral package:

| File | What it is |
|---|---|
| `haus.package.haus` | The manifest: name and version. They make the identity of its types, the same in every language: `@haus/money@1#Money`. |
| `*.schema.haus` | The schema. Shape only, like every haus schema. |
| `profiles/*.vectors.haus` | Profiles: rules beyond the shape that codecs can implement, with test vectors. |

The `package.json` only publishes the same files to npm; other languages
publish them to their own registries, from this one source.

There is no haus registry (spec §13.3, *Distribution*). Anyone can publish a
schema package as an ordinary dependency: to npm, crates.io, PyPI or a private
registry, as a git dependency, or as a copy in the project. Name it after
something you own (`@your-domain/…`, `@your-github-org/…`), give it no install
scripts, and publish every language from one source.

| Package | Types | Profiles |
|---|---|---|
| [`@haus/money`](money) | `Money`, `Currency` | `iso`: currency codes are three letters A–Z |
| [`@haus/geo`](geo) | `LatLng`, `BBox` | `wgs84`: latitude and longitude in range |
