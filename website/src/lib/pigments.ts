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
