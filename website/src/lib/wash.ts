/**
 * The geometry of a watercolour wash, shared by the browser painter
 * (src/lib/paint.ts) and the build-time renderer (src/lib/og/paint.ts).
 *
 * Each brushload is an ellipse whose edge is recursively deformed, then glazed
 * as ~48 slightly different, very transparent layers (the layered-polygon
 * technique), finished with a dried "tide line". Everything is seeded, so the
 * same spec paints the same wash everywhere.
 */

export interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
  rot?: number;
  color: string;
  strength?: number;
  wobble?: number;
}

export interface Spec {
  seed: number;
  delay?: number;
  blobs: Blob[];
}

export interface Pt {
  x: number;
  y: number;
  v: number;
}

/** One glaze (`fill`) or tide line (`edge`), in canvas pixels. */
export interface Mark {
  kind: "fill" | "edge";
  pts: Pt[];
  /** The colour as a canvas style, and the same as 0-255 channels plus alpha. */
  style: string;
  rgb: readonly [number, number, number];
  alpha: number;
  area: number;
}

/** The canvas reaches this fraction of the box beyond each edge (.wash__paint). */
export const BLEED = 0.25;

/** Width of the tide line, in CSS pixels. */
export const EDGE_WIDTH = 1.4;

const LAYERS_PER_BATCH = 16;
const BATCHES = 3;

export const mulberry = (seed: number) => () => {
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

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as readonly [number, number, number];

/** Every glaze and tide line of a wash on a `cw` x `ch` canvas (box plus bleed), smallest first. */
export function marks(spec: Spec, cw: number, ch: number): Mark[] {
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
    const rgb = channels(b.color);
    const glaze = (alpha: number) => ({ rgb, alpha, style: `rgba(${rgb.join(",")},${alpha.toFixed(4)})` });
    const fills: Mark[] = Array.from({ length: BATCHES }, () => deform(base, r, 1, 0.16 * wobble)).flatMap((mid) =>
      Array.from({ length: LAYERS_PER_BATCH }, () => {
        const poly = deform(mid, r, 3, 0.13 * wobble);
        return { kind: "fill" as const, pts: poly, ...glaze(0.015 * strength), area: area(poly) };
      }),
    );
    const edge = deform(base, r, 2, 0.06);
    const edges: Mark[] = Array.from({ length: 3 }, () => ({
      kind: "edge" as const,
      pts: edge,
      ...glaze(0.05 * strength),
      area: Infinity,
    }));
    return [...fills, ...edges];
  });
  return all.sort((a, b) => a.area - b.area);
}

/** Side of the paper-grain tile, in CSS pixels. */
export const GRAIN_SIZE = 256;

/** A tile of cold-press paper as RGBA (black, varying alpha): fine tooth plus soft blotches. */
export function grain(size = GRAIN_SIZE): Uint8ClampedArray<ArrayBuffer> {
  const r = mulberry(7);
  const g = 16;
  const coarse = Array.from({ length: (g + 1) * (g + 1) }, () => r());
  const at = (x: number, y: number) => coarse[(y % g) * (g + 1) + (x % g)];
  const data = new Uint8ClampedArray(size * size * 4);
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
      data[(y * size + x) * 4 + 3] = Math.round(Math.min(Math.max(a, 0), 1) * 255);
    }
  }
  return data;
}
