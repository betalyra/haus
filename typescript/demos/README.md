# Demos

Presentation material, not examples (see [`../examples`](../examples) for those).

```sh
pnpm demo         # src/demo/demo.ts: the starting point of the live demo
pnpm demo:watch   # reruns on every change to a .ts or .haus file
pnpm video        # src/video/main.ts: the script of the video
pnpm tour         # src/tour.ts: a tour of the content mapper on ../../examples
```

In VS Code, open [`demo.ts`](src/demo/demo.ts) and hover `order`; then set a
`quantity` in [`order.haus`](src/demo/order.haus) to `300` (the schema says
`UInt8`) and see the error at that value.
