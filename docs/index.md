---
title: Welcome to haus
description: A data format for humans, friendly to write, pleasant to read, and at home in your code.
---

haus lets your data say what it means. An order isn't a bag of strings and flags: it is `Shipped`, `Pending` or `Cancelled`, its total is exact `Money`, and an empty note is plainly `None`.

```haus
// Comments are welcome, keys don't need quotes, trailing commas are fine.
{
  order: 1042,
  total: Money(30.30, EUR),
  status: Shipped { at: Instant("2026-11-08T09:12:00Z") },
  gift: True,
  note: None,
}
```

:::caution[Experimental]
haus is a draft. Everything may still change, so play with it, but don't use it in production yet.
:::

## Where to go next

- Try it in the [playground](/play).
- Install the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=betalyra.haus).
- Read the [specification](/docs/spec).
