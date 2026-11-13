/**
 * Watercolour washes on <canvas data-wash>, with the geometry from wash.ts.
 *
 * Each wash is painted once, in idle time, about a screen before it scrolls
 * into view; it is then revealed with a CSS transition (opacity, a growing
 * soft mask), with no script running per frame. The paintings (.is-soak) take
 * their time and spread from the middle of their strokes. A paper-grain mask
 * (set once as --grain) granulates the pigment.
 */
import { EDGE_WIDTH, GRAIN_SIZE, grain as grainTile, marks as washMarks, type Pt, type Spec } from "./wash";

type Mark = { kind: "fill" | "edge"; path: Path2D; style: string };

const toPath = (pts: Pt[]) => {
  const p = new Path2D();
  pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
  p.closePath();
  return p;
};

/** The marks as Path2Ds; the tide lines share one outline, so it is built once. */
const marks = (spec: Spec, w: number, h: number): Mark[] => {
  const paths = new Map<Pt[], Path2D>();
  const path = (pts: Pt[]) => paths.get(pts) ?? paths.set(pts, toPath(pts)).get(pts)!;
  return washMarks(spec, w, h).map((m) => ({ kind: m.kind, path: path(m.pts), style: m.style }));
};

interface Canvas {
  el: HTMLCanvasElement;
  spec: Spec;
  ctx: CanvasRenderingContext2D;
  queue: Mark[];
  drawn: number;
  size: string;
}

const prep = (el: HTMLCanvasElement): Canvas | null => {
  const w = el.clientWidth;
  const h = el.clientHeight;
  const ctx = el.getContext("2d");
  if (!w || !h || !ctx) return null;
  // Soft paint needs no more than 1.5x: sharper costs memory, not looks.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  el.width = Math.round(w * dpr);
  el.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.lineJoin = "round";
  const spec = JSON.parse(el.dataset.wash ?? "{}") as Spec;
  return { el, spec, ctx, queue: marks(spec, w, h), drawn: 0, size: `${w}x${h}` };
};

const drawUpTo = (c: Canvas, upto: number) => {
  for (; c.drawn < upto; c.drawn++) {
    const m = c.queue[c.drawn];
    if (m.kind === "fill") {
      c.ctx.fillStyle = m.style;
      c.ctx.fill(m.path);
    } else {
      c.ctx.strokeStyle = m.style;
      c.ctx.lineWidth = EDGE_WIDTH;
      c.ctx.stroke(m.path);
    }
  }
};

/** Runs `f` when the browser is idle (or soon, where idle callbacks don't exist). */
const idle = (f: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(f, { timeout: 400 }) : setTimeout(f, 16);

/** A tile of cold-press paper: fine tooth plus soft blotches, as an alpha mask. */
const grain = () => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = GRAIN_SIZE;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(new ImageData(grainTile(), GRAIN_SIZE, GRAIN_SIZE), 0, 0);
  document.documentElement.style.setProperty("--grain", `url(${cv.toDataURL()})`);
};

export function paintAll() {
  grain();
  const canvases = new Map<HTMLCanvasElement, Canvas | null>();
  const els = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[data-wash]"));

  const paint = (el: HTMLCanvasElement) => {
    if (canvases.has(el)) return;
    const c = prep(el);
    canvases.set(el, c);
    if (c) drawUpTo(c, c.queue.length);
  };

  // Paint a screen ahead, while the browser is idle.
  const ahead = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        ahead.unobserve(e.target);
        idle(() => paint(e.target as HTMLCanvasElement));
      }),
    { rootMargin: "100% 0px 100% 0px" },
  );

  // Reveal once it's actually on screen (painting it now if idle time hasn't come yet).
  const shown = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target as HTMLCanvasElement;
        shown.unobserve(el);
        paint(el);
        // A little randomness in when and how fast, so washes revealed together
        // don't move in lockstep. The paintings soak in slowly and quietly:
        // [opacity, spread] in ms.
        const soak = el.classList.contains("is-soak");
        const delay = (canvases.get(el)?.spec.delay ?? 0) + Math.random() * (soak ? 150 : 30);
        const pace = 0.9 + Math.random() * 0.3;
        const times = soak ? [1300, 2400] : [180, 400, 400];
        el.style.transitionDelay = `${Math.round(delay)}ms`;
        el.style.transitionDuration = times.map((ms) => `${Math.round(ms * pace)}ms`).join(", ");
        requestAnimationFrame(() => el.classList.add("is-shown"));
      }),
    { rootMargin: "0px 0px 10% 0px" },
  );

  const ro = new ResizeObserver((entries) => {
    entries.forEach((e) => {
      const el = e.target as HTMLCanvasElement;
      const old = canvases.get(el);
      if (!old || old.size === `${el.clientWidth}x${el.clientHeight}`) return;
      canvases.delete(el);
      paint(el);
    });
  });

  els.forEach((el) => {
    ro.observe(el);
    // The hero headline: painted now and shown as it is, with no reveal.
    if (el.classList.contains("is-instant")) return paint(el);
    ahead.observe(el);
    shown.observe(el);
  });
}
