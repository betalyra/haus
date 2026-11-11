# TypeScript examples

The same examples as in [Rust](../../rust/examples), on the same files in [`../../examples`](../../examples):

| Example | Shows |
|---|---|
| [`quickstart`](quickstart) | `thread.haus`: data imported as a typed module, decoding and encoding with its schema, errors |
| [`order`](order) | `order.haus`: schema packages (`@haus/money`, `@haus/geo`) and codecs |
| [`logs`](logs) | `logs.haus`: a stream, read and written entry by entry with Effect `Stream` |

## Running them

```sh
cd typescript && pnpm install      # once, for the whole workspace
cd examples/logs                   # or quickstart, order
pnpm start                         # builds the haus packages, then runs src/main.ts
pnpm typecheck                     # tsc 7.1 with the haus content mapper
```

`pnpm start` runs `tsx` with the content mapper's hook, which lets Node import
`.haus` files. To run `tsx` yourself, load the hook too. Plain `tsx src/main.ts`
fails with `Unknown file extension ".haus"`:

```sh
pnpm tsx --import @betalyra/haus-fmt-content-mapper/register src/main.ts
# or once per shell:
export NODE_OPTIONS="--import @betalyra/haus-fmt-content-mapper/register"
pnpm tsx src/main.ts
```

How `.haus` imports work: [`packages/content-mapper`](../packages/content-mapper).
Presentation material (the live demo, the video script, a tour): [`../demos`](../demos).
