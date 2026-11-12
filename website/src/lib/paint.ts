/**
 * Watercolour washes on <canvas data-wash>.
 *
 * Each brushload is an ellipse whose edge is recursively deformed, then glazed
 * as ~33 slightly different, very transparent layers (the layered-polygon
 * technique). Each wash is painted once, in idle time, about a screen before
 * it scrolls into view; it is then revealed with a CSS transition (opacity,
 * a growing soft mask), with no script running per frame. The paintings
 * (.is-soak) take their time and spread from the middle of their strokes. A dried "tide line" finishes
 * the edge, and a paper-grain mask (set once as --grain) granulates the pigment.
 */

interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
  rot?: number;
  color: string;
  strength?: number;
  wobble?: number;
}

interface Spec {
  seed: number;
  delay?: number;
  blobs: Blob[];
}

interface Pt {
  x: number;
  y: number;
  v: number;
}

type Mark = { kind: "fill" | "edge"; path: Path2D; style: string; area: number };

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

const deform = (pts: Pt[], r: () => number, depth: number, amount: number): Pt[] =>
  depth === 0
    ? pts
    : deform(
        pts.flatMap((a, i) => {
          const b = pts[(i + 1) % pts.length];
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          const v = (a.v + b.v) / 2;
          const ang = r() * Math.PI * 2;
          const m = gauss(r) * len * amount * v;
          return [a, { x: (a.x + b.x) / 2 + Math.cos(ang) * m, y: (a.y + b.y) / 2 + Math.sin(ang) * m, v: v * (0.88 + r() * 0.24) }];
        }),
        r,
        depth - 1,
        amount,
      );

const area = (pts: Pt[]) =>
  Math.abs(pts.reduce((s, a, i) => {
    const b = pts[(i + 1) % pts.length];
    return s + a.x * b.y - b.x * a.y;
  }, 0)) / 2;

const toPath = (pts: Pt[]) => {
  const p = new Path2D();
  pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
  p.closePath();
  return p;
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");

const LAYERS_PER_BATCH = 16;

/** The canvas reaches this fraction of the box beyond each edge (.wash__paint). */
const BLEED = 0.25;
const BATCHES = 3;

function marks(spec: Spec, cw: number, ch: number): Mark[] {
  const r = mulberry(spec.seed * 9973 + 17);
  // Strokes are placed in the box; the canvas is the box plus the bleed.
  const w = cw / (1 + 2 * BLEED);
  const h = ch / (1 + 2 * BLEED);
  const ox = BLEED * w;
  const oy = BLEED * h;
  const all = spec.blobs.flatMap((b) => {
    const { x, y, rx, ry, rot = 0, strength = 1, wobble = 1 } = b;
    const n = 12;
    const ring: Pt[] = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      const k = 1 + (r() - 0.5) * 0.24;
      const px = Math.cos(t) * rx * w * k;
      const py = Math.sin(t) * ry * h * k;
      return {
        x: ox + x * w + px * Math.cos(rot) - py * Math.sin(rot),
        y: oy + y * h + px * Math.sin(rot) + py * Math.cos(rot),
        v: 0.35 + r() * 1.25,
      };
    });
    const base = deform(ring, r, 2, 0.24 * wobble);
    const color = rgb(b.color);
    const fills: Mark[] = Array.from({ length: BATCHES }, () => deform(base, r, 1, 0.16 * wobble)).flatMap((mid) =>
      Array.from({ length: LAYERS_PER_BATCH }, () => {
        const poly = deform(mid, r, 3, 0.13 * wobble);
        return { kind: "fill" as const, path: toPath(poly), style: `rgba(${color},${(0.015 * strength).toFixed(4)})`, area: area(poly) };
      }),
    );
    const edge = toPath(deform(base, r, 2, 0.06));
    const edges: Mark[] = Array.from({ length: 3 }, () => ({
      kind: "edge" as const,
      path: edge,
      style: `rgba(${color},${(0.05 * strength).toFixed(4)})`,
      area: Infinity,
    }));
    return [...fills, ...edges];
  });
  return all.sort((a, b) => a.area - b.area);
}

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
      c.ctx.lineWidth = 1.4;
      c.ctx.stroke(m.path);
    }
  }
};

/** Runs `f` when the browser is idle (or soon, where idle callbacks don't exist). */
const idle = (f: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(f, { timeout: 400 }) : setTimeout(f, 16);

/** A tile of cold-press paper: fine tooth plus soft blotches, as an alpha mask. */
const grain = () => {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const r = mulberry(7);
  const g = 16;
  const coarse = Array.from({ length: (g + 1) * (g + 1) }, () => r());
  const at = (x: number, y: number) => coarse[(y % g) * (g + 1) + (x % g)];
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * g;
      const gy = (y / size) * g;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const blotch =
        at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
      const tooth = r();
      const a = 0.62 + blotch * 0.3 + tooth * 0.16 - (tooth > 0.94 ? 0.35 : 0);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(Math.min(Math.max(a, 0), 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
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
