/**
 * Links two editors that show the same values: a document and its formatted
 * version. Formatting keeps every value and its order, so walking both parse
 * trees side by side pairs each value with its copy. Those pairs drive two
 * things: scrolling one side scrolls the other to the same value, and the
 * value under one cursor is marked on the other side.
 */
import type { EditorView } from "@codemirror/view";
import type { Value } from "../../../../typescript/packages/haus/src/index.ts";
import { linkRange } from "../play/editor";

interface Span {
  readonly from: number;
  readonly to: number;
}

/** A value on the left and its copy on the right. */
export interface Pair {
  readonly a: Span;
  readonly b: Span;
}

const span = (v: Value, key?: readonly [number, number]): Span | undefined =>
  v.start === undefined || v.end === undefined ? undefined : { from: key ? key[0] : v.start, to: v.end };

/** Pair the values of two parses of the same data (both with locations). */
export function pairValues(left: readonly Value[], right: readonly Value[]): Pair[] {
  const pairs: Pair[] = [];
  const walk = (a: Value, b: Value, keys?: [readonly [number, number] | undefined, readonly [number, number] | undefined]) => {
    const sa = span(a, keys?.[0]);
    const sb = span(b, keys?.[1]);
    if (sa && sb) pairs.push({ a: sa, b: sb });
    if (a.kind === "array" && b.kind === "array") a.items.forEach((item, i) => b.items[i] && walk(item, b.items[i]!));
    else if (a.kind === "record" && b.kind === "record")
      for (const [k, v] of a.fields) {
        const w = b.fields.get(k);
        if (w) walk(v, w, [a.keySpans?.get(k), b.keySpans?.get(k)]);
      }
    else if (a.kind === "variant" && b.kind === "variant") a.args.forEach((arg, i) => b.args[i] && walk(arg, b.args[i]!));
  };
  left.forEach((v, i) => right[i] && walk(v, right[i]!));
  return pairs;
}

/** Keep two editors scrolled to the same values, and mark the value under either cursor on the other side. */
export function linkEditors(left: EditorView, right: EditorView) {
  let pairs: Pair[] = [];
  let version = 0;

  // Scroll positions (in px from each document's top) that show the same value, rising on both sides.
  let cache: { key: string; points: [number, number][] } | undefined;
  const points = (from: EditorView, to: EditorView, fromSide: "a" | "b") => {
    const key = `${version}|${fromSide}|${from.contentHeight}|${to.contentHeight}`;
    if (cache?.key === key) return cache.points;
    const toSide = fromSide === "a" ? "b" : "a";
    const raw: [number, number][] = pairs
      .map((p): [number, number] => [from.lineBlockAt(p[fromSide].from).top, to.lineBlockAt(p[toSide].from).top])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const out: [number, number][] = [[0, 0]];
    for (const [x, y] of raw) {
      const last = out[out.length - 1]!;
      if (x > last[0] && y >= last[1]) out.push([x, y]);
    }
    out.push([Math.max(from.contentHeight, out[out.length - 1]![0] + 1), Math.max(to.contentHeight, out[out.length - 1]![1])]);
    cache = { key, points: out };
    return out;
  };

  /** Where `to` should scroll so it shows what `from` shows at its top. */
  const follow = (from: EditorView, to: EditorView, fromSide: "a" | "b") => {
    const pts = points(from, to, fromSide);
    const top = from.scrollDOM.scrollTop;
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1]![0] <= top) i++;
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const t = Math.min(1, Math.max(0, (top - x0) / (x1 - x0)));
    return y0 + t * (y1 - y0);
  };

  // A scroll we caused shouldn't scroll back the side that caused it.
  const expected = new Map<EditorView, number>();
  const onScroll = (from: EditorView, to: EditorView, fromSide: "a" | "b") => {
    let frame = 0;
    return () => {
      const want = expected.get(from);
      if (want !== undefined && Math.abs(from.scrollDOM.scrollTop - want) < 2) {
        expected.delete(from);
        return;
      }
      expected.delete(from);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!pairs.length) return;
        const target = Math.round(follow(from, to, fromSide));
        const max = to.scrollDOM.scrollHeight - to.scrollDOM.clientHeight;
        const next = Math.min(max, Math.max(0, target));
        if (Math.abs(to.scrollDOM.scrollTop - next) < 1) return;
        expected.set(to, next);
        to.scrollDOM.scrollTop = next;
      });
    };
  };
  left.scrollDOM.addEventListener("scroll", onScroll(left, right, "a"), { passive: true });
  right.scrollDOM.addEventListener("scroll", onScroll(right, left, "b"), { passive: true });

  /** The innermost pair whose `side` contains `pos`. */
  const at = (pos: number, side: "a" | "b") => {
    let best: Pair | undefined;
    for (const p of pairs) {
      const s = p[side];
      if (s.from <= pos && pos <= s.to && (!best || s.to - s.from < best[side].to - best[side].from)) best = p;
    }
    return best;
  };

  return {
    /** New pairs, after either text changed. Empty while they can't be paired (a syntax error). */
    setPairs(next: Pair[]) {
      pairs = next;
      version++;
      cache = undefined;
      linkRange(left, null);
      linkRange(right, null);
    },
    /** The cursor moved in one editor: mark the same value in the other. */
    cursor(side: "a" | "b", pos: number) {
      const p = at(pos, side);
      const self = side === "a" ? left : right;
      const other = side === "a" ? right : left;
      const range = p ? p[side === "a" ? "b" : "a"] : null;
      linkRange(self, null);
      linkRange(other, range);
      if (!range) return;
      // Out of sight on the other side: bring it level with the cursor.
      const top = other.lineBlockAt(range.from).top;
      const view = other.scrollDOM;
      if (top >= view.scrollTop && top < view.scrollTop + view.clientHeight - 20) return;
      const level = self.lineBlockAt(pos).top - self.scrollDOM.scrollTop;
      const next = Math.max(0, Math.min(view.scrollHeight - view.clientHeight, Math.round(top - level)));
      expected.set(other, next);
      view.scrollTop = next;
    },
  };
}
