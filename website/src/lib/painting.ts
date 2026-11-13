/**
 * The painted plate: the haus mark drawn large in ink, with loose washes laid
 * in behind it. Shared by Painting.astro (painted in the browser) and the
 * Open Graph images (painted at build time by src/lib/og/paint.ts).
 *
 * Wash coordinates are fractions of the plate; the mark's 64-unit grid sits in
 * a viewBox of -4 -8 72 72, so grid (u, v) lands at ((u + 4) / 72, (v + 8) / 72).
 */
import type { Stroke } from "./pigments";

/** The plate's viewBox around the mark's 64-unit grid. */
export const viewBox = { x: -4, y: -8, size: 72 } as const;

/** Ink weight of the drawing, in grid units. */
export const inkWidth = 1.5;

// Each layer is its own canvas and soaks into the paper slowly. The layers
// start a little apart but overlap for most of their time, so the plate reads
// as one painting settling, not a sequence: by day the roof leads, then the
// sky, the garden and the lamplight; at dusk the sunset, the garden, the sky
// and the lamps.
export type Layer = { delay: number; strokes: Stroke[] };
export type Light = "day" | "dusk";

export const washes: Record<Light, Layer[]> = {
  day: [
    {
      delay: 200,
      strokes: [
        { x: 0.52, y: 0.2, rx: 0.36, ry: 0.15, rot: -0.08, color: "cerulean", strength: 0.7, wobble: 1.1 },
        { x: 0.3, y: 0.24, rx: 0.13, ry: 0.08, rot: -0.2, color: "ultramarine", strength: 0.6 },
        { x: 0.2, y: 0.15, rx: 0.12, ry: 0.07, color: "violet", strength: 0.4 },
      ],
    },
    {
      delay: 0,
      strokes: [
        { x: 0.46, y: 0.44, rx: 0.26, ry: 0.09, rot: -0.1, color: "rose", strength: 1.1 },
        { x: 0.65, y: 0.4, rx: 0.08, ry: 0.05, rot: 0.3, color: "sienna", strength: 0.7 },
      ],
    },
    {
      delay: 600,
      strokes: [
        { x: 0.5, y: 0.7, rx: 0.2, ry: 0.14, color: "gold", strength: 1 },
        { x: 0.55, y: 0.76, rx: 0.08, ry: 0.08, color: "yellow", strength: 0.9 },
      ],
    },
    {
      delay: 400,
      strokes: [
        { x: 0.5, y: 0.87, rx: 0.42, ry: 0.04, rot: 0.02, color: "sap", strength: 1.1, wobble: 0.8 },
        { x: 0.2, y: 0.86, rx: 0.12, ry: 0.035, color: "gold", strength: 0.5, wobble: 0.8 },
      ],
    },
  ],
  // Evening: a violet sky, the last light low behind the house, lamps on.
  dusk: [
    {
      delay: 400,
      strokes: [
        { x: 0.5, y: 0.17, rx: 0.4, ry: 0.13, rot: 0.05, color: "violet", strength: 0.75, wobble: 1.1 },
        { x: 0.24, y: 0.24, rx: 0.17, ry: 0.1, color: "ultramarine", strength: 0.75 },
      ],
    },
    {
      delay: 0,
      strokes: [
        { x: 0.76, y: 0.5, rx: 0.2, ry: 0.13, rot: -0.1, color: "rose", strength: 0.9 },
        { x: 0.84, y: 0.62, rx: 0.12, ry: 0.1, color: "gold", strength: 1 },
        { x: 0.45, y: 0.43, rx: 0.22, ry: 0.08, rot: -0.1, color: "sienna", strength: 0.75 },
      ],
    },
    {
      delay: 600,
      strokes: [
        { x: 0.5, y: 0.72, rx: 0.15, ry: 0.11, color: "yellow", strength: 1.1 },
        { x: 0.52, y: 0.76, rx: 0.08, ry: 0.07, color: "gold", strength: 1 },
      ],
    },
    {
      delay: 200,
      strokes: [
        { x: 0.5, y: 0.87, rx: 0.42, ry: 0.04, rot: -0.02, color: "sap", strength: 1.15, wobble: 0.8 },
        { x: 0.78, y: 0.86, rx: 0.13, ry: 0.035, color: "ultramarine", strength: 0.45, wobble: 0.8 },
      ],
    },
  ],
};

/** Seed of a wash layer, as Painting.astro numbers them. */
export const layerSeed = (light: Light, i: number) => (light === "day" ? 4 : 91) + i * 13;

/** Chimney smoke: two soft grey washes. */
export const smoke = (light: Light, i: number) => ({
  seed: (light === "day" ? 7 : 93) + i * 5,
  strokes: [
    { x: 0.5, y: 0.52, rx: 0.34, ry: 0.3, color: "payne", strength: 1.25, wobble: 1.2 },
    { x: 0.42, y: 0.44, rx: 0.16, ry: 0.14, color: light === "day" ? "ultramarine" : "violet", strength: 0.5 },
  ] satisfies Stroke[],
});

/**
 * The two puffs for still images (Open Graph), caught mid-rise as they look in
 * the animation (.puff in global.css): one just out of the chimney, one higher
 * and wider. Centre and size are fractions of the plate.
 */
export const stillPuffs = [
  { cx: 0.69, cy: 0.24, size: 0.15 * 0.9, opacity: 0.4 },
  { cx: 0.74, cy: 0.12, size: 0.15 * 1.35, opacity: 0.28 },
] as const;
