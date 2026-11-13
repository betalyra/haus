/**
 * The watercolour box. Mid-strength pigment colours: washes dilute them with
 * low-alpha glazes, so they land pale on the paper and deepen where they overlap.
 */
export const pigments = {
  cerulean: "#1f8fc4",
  ultramarine: "#3a4fb8",
  violet: "#6b4bb0",
  rose: "#d93d78",
  sienna: "#c0582a",
  gold: "#e39b16",
  yellow: "#f2c419",
  sap: "#5d9a2f",
  /** Payne's grey: smoke and shadow. */
  payne: "#4b5566",
} as const;

export type Pigment = keyof typeof pigments;

/** One brushload: an ellipse in fractions of the canvas, before the water moves it. */
export interface Stroke {
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** radians */
  rot?: number;
  color: Pigment;
  /** 1 is a normal wash; lower is more water, higher is more pigment. */
  strength?: number;
  /** How far the edge wanders. 1 is a normal wash. */
  wobble?: number;
}

/** Brush colours for a page's title wash (on the page and in its Open Graph image). */
export const brushes: [Pigment, Pigment][] = [
  ["rose", "gold"],
  ["cerulean", "ultramarine"],
  ["sap", "gold"],
  ["violet", "rose"],
  ["gold", "sienna"],
];

export const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7) >>> 0;

/** The brush pair for a title: the same title always gets the same colours. */
export const brushFor = (title: string) => brushes[hash(title) % brushes.length]!;
