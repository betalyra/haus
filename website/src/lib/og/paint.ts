/**
 * The watercolour painter for build time: the same seeded washes as the
 * browser (src/lib/paint.ts), drawn with @napi-rs/canvas at any resolution.
 *
 * Coordinates are in CSS pixels; `scale` is the device pixel ratio, so a plate
 * painted at 544 px with scale 3 looks like the hero on a 3x screen.
 */
import { createCanvas, Path2D, type SKRSContext2D } from "@napi-rs/canvas";
import { mark } from "../mark";
import { inkWidth, layerSeed, stillPuffs, smoke, viewBox, washes, type Light } from "../painting";
import { pigments, type Stroke } from "../pigments";
import { BLEED, EDGE_WIDTH, GRAIN_SIZE, grain, marks, type Pt } from "../wash";

export const ink = "#26231f";

/** A box in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const toPath = (pts: Pt[]) => {
  const p = new Path2D();
  pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
  p.closePath();
  return p;
};

interface WashOptions {
  seed: number;
  strokes: Stroke[];
  /** Soak from the strokes' weighted middle, like the paintings once they have settled. */
  soak?: boolean;
  opacity?: number;
}

/**
 * Paints one wash over `box` onto `target`, the way .wash / .wash__paint do:
 * the paint reaches a quarter past every edge, is granulated by the paper and
 * multiplied onto what is below.
 */
export function paintWash(target: SKRSContext2D, box: Box, scale: number, { seed, strokes, soak = false, opacity = 1 }: WashOptions) {
  const cw = box.w * (1 + 2 * BLEED);
  const ch = box.h * (1 + 2 * BLEED);
  const pw = Math.ceil(cw * scale);
  const ph = Math.ceil(ch * scale);

  // Each glaze is only 1.5% pigment. An 8-bit canvas rounds that away channel
  // by channel (cerulean loses its red and turns teal), so the glazes are
  // accumulated in floating point: each mark is rasterised alone for its
  // coverage, then multiplied into a premultiplied RGBA buffer.
  const acc = new Float32Array(pw * ph * 4);
  const scratch = createCanvas(pw, ph);
  const sc = scratch.getContext("2d");
  sc.scale(scale, scale);
  sc.fillStyle = sc.strokeStyle = "#000";
  sc.lineJoin = "round";
  sc.lineWidth = EDGE_WIDTH;

  const blobs = strokes.map((s) => ({ ...s, color: pigments[s.color] }));
  const paths = new Map<Pt[], Path2D>();
  for (const m of marks({ seed, blobs }, cw, ch)) {
    const path = paths.get(m.pts) ?? paths.set(m.pts, toPath(m.pts)).get(m.pts)!;
    const pad = EDGE_WIDTH + 1;
    const xs = m.pts.map((p) => p.x);
    const ys = m.pts.map((p) => p.y);
    const x0 = Math.max(0, Math.floor((Math.min(...xs) - pad) * scale));
    const y0 = Math.max(0, Math.floor((Math.min(...ys) - pad) * scale));
    const x1 = Math.min(pw, Math.ceil((Math.max(...xs) + pad) * scale));
    const y1 = Math.min(ph, Math.ceil((Math.max(...ys) + pad) * scale));
    if (x1 <= x0 || y1 <= y0) continue;
    sc.clearRect(x0 / scale, y0 / scale, (x1 - x0) / scale, (y1 - y0) / scale);
    if (m.kind === "fill") sc.fill(path);
    else sc.stroke(path);
    const cov = sc.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const [r, g, b] = m.rgb.map((c) => c / 255);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = (cov[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3] / 255) * m.alpha;
        if (a === 0) continue;
        const i = (y * pw + x) * 4;
        const ab = acc[i + 3];
        // Separable multiply over source-over, in premultiplied terms:
        // co = as·Cs·(1 − ab) + as·Cs·cb + (1 − as)·cb
        acc[i] = a * r * (1 - ab) + a * r * acc[i] + (1 - a) * acc[i];
        acc[i + 1] = a * g * (1 - ab) + a * g * acc[i + 1] + (1 - a) * acc[i + 1];
        acc[i + 2] = a * b * (1 - ab) + a * b * acc[i + 2] + (1 - a) * acc[i + 2];
        acc[i + 3] = a + ab * (1 - a);
      }
    }
  }

  // Masks, as on .wash__paint: the paper grain (256 CSS px tiles) and, for the
  // settled paintings, radial-gradient(200% 200% at the middle, #000 40%, transparent 100%).
  const tile = grain();
  const weight = strokes.reduce((n, s) => n + s.rx * s.ry * (s.strength ?? 1), 0);
  const middle = (k: "x" | "y") => strokes.reduce((n, s) => n + s[k] * s.rx * s.ry * (s.strength ?? 1), 0) / weight;
  const cx = (BLEED + middle("x")) / (1 + 2 * BLEED);
  const cy = (BLEED + middle("y")) / (1 + 2 * BLEED);
  const soakAt = (x: number, y: number) => {
    const d = Math.hypot((x / pw - cx) / 2, (y / ph - cy) / 2);
    return d <= 0.4 ? 1 : Math.max(0, 1 - (d - 0.4) / 0.6);
  };

  const layer = createCanvas(pw, ph);
  const lc = layer.getContext("2d");
  const img = lc.createImageData(pw, ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * 4;
      const a = acc[i + 3];
      if (a === 0) continue;
      const gx = Math.floor(x / scale) % GRAIN_SIZE;
      const gy = Math.floor(y / scale) % GRAIN_SIZE;
      const mask = (tile[(gy * GRAIN_SIZE + gx) * 4 + 3] / 255) * (soak ? soakAt(x, y) : 1);
      img.data[i] = Math.round((acc[i] / a) * 255);
      img.data[i + 1] = Math.round((acc[i + 1] / a) * 255);
      img.data[i + 2] = Math.round((acc[i + 2] / a) * 255);
      img.data[i + 3] = Math.round(a * mask * 255);
    }
  }
  lc.putImageData(img, 0, 0);

  target.save();
  target.globalCompositeOperation = "multiply";
  target.globalAlpha = opacity;
  target.drawImage(layer, box.x - box.w * BLEED, box.y - box.h * BLEED, cw, ch);
  target.restore();
}

/** Paints the hero plate (washes, smoke and the ink drawing) into `box`. */
export function paintPlate(ctx: SKRSContext2D, box: Box, scale: number, light: Light = "day") {
  washes[light].forEach((layer, i) => paintWash(ctx, box, scale, { seed: layerSeed(light, i), strokes: layer.strokes, soak: true }));

  stillPuffs.forEach((p, i) => {
    const size = p.size * box.w;
    const at = { x: box.x + p.cx * box.w - size / 2, y: box.y + p.cy * box.h - size / 2, w: size, h: size };
    paintWash(ctx, at, scale, { ...smoke(light, i), opacity: p.opacity });
  });

  const unit = box.w / viewBox.size;
  ctx.save();
  ctx.translate(box.x - viewBox.x * unit, box.y - viewBox.y * unit);
  ctx.scale(unit, unit);
  ctx.strokeStyle = ink;
  ctx.lineWidth = inkWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  [mark.roof, mark.chimney, mark.body].forEach((d) => ctx.stroke(new Path2D(d)));
  ctx.beginPath();
  ctx.arc(mark.window.cx, mark.window.cy, mark.window.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * The plate on its own: a square canvas of `size` CSS px at `scale`, on
 * transparent paper (`paper: false`) or on white.
 */
export function plateCanvas(size: number, scale: number, { light = "day", paper = true }: { light?: Light; paper?: boolean } = {}) {
  const canvas = createCanvas(Math.round(size * scale), Math.round(size * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  if (paper) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
  }
  paintPlate(ctx, { x: 0, y: 0, w: size, h: size }, scale, light);
  return canvas;
}
