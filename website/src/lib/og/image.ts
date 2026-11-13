/**
 * Open Graph images: every page gets the hero. The page title in ink with its
 * last word brushed, a line of text under it, and the painted house on the
 * right, on white paper. Rendered at build time by src/pages/og/[...slug].png.ts.
 */
import { createCanvas, GlobalFonts, Path2D, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mark } from "../mark";
import { brushFor, hash, type Pigment } from "../pigments";
import { ink, paintWash, plateCanvas } from "./paint";

export const WIDTH = 1200;
export const HEIGHT = 630;
/** Pixel ratio of the PNG: 2400 x 1260, sharp on high-density screens. */
const SCALE = 2;

const ink2 = "#57514a";
const ink3 = "#7a726a";

export interface OgImage {
  title: string;
  description?: string;
  /** Small label above the title, e.g. the docs section. */
  eyebrow?: string;
}

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);

let ready = false;
const registerFonts = () => {
  if (ready) return;
  GlobalFonts.registerFromPath(font("@fontsource/albert-sans", "albert-sans-latin-600-normal.woff2"), "Albert Sans");
  GlobalFonts.registerFromPath(font("@fontsource/geist-sans", "geist-sans-latin-400-normal.woff2"), "Geist");
  GlobalFonts.registerFromPath(font("@fontsource/geist-mono", "geist-mono-latin-500-normal.woff2"), "Geist Mono");
  ready = true;
};

// The house is the same on every image: paint it once per build.
const PLATE = 500;
let plate: Canvas | undefined;
const housePlate = () => (plate ??= plateCanvas(PLATE, SCALE, { paper: false }));

/** Greedy word wrap; a word longer than the line gets a line of its own. */
const wrap = (ctx: SKRSContext2D, text: string, width: number) =>
  text.split(/\s+/).reduce<string[]>((lines, word) => {
    const last = lines.at(-1);
    if (last !== undefined && ctx.measureText(`${last} ${word}`).width <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
    return lines;
  }, []);

/** The largest of `sizes` at which `text` fits in `maxLines` lines; else the smallest, cut with an ellipsis. */
const fit = (ctx: SKRSContext2D, text: string, family: string, width: number, sizes: number[], maxLines: number) => {
  for (const size of sizes) {
    ctx.font = family.replace("{size}", String(size));
    const lines = wrap(ctx, text, width);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes.at(-1)!;
  ctx.font = family.replace("{size}", String(size));
  const lines = wrap(ctx, text, width).slice(0, maxLines);
  lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s*\S+$/, "")}…`;
  return { size, lines };
};


/** The haus mark, as in the site header. */
const drawMark = (ctx: SKRSContext2D, x: number, y: number, size: number) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 64, size / 64);
  ctx.strokeStyle = ctx.fillStyle = ink;
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  [mark.roof, mark.chimney, mark.body].forEach((d) => ctx.stroke(new Path2D(d)));
  ctx.lineWidth = 3.2 * 0.8;
  ctx.beginPath();
  ctx.arc(mark.window.cx, mark.window.cy, mark.window.r, 0, Math.PI * 2);
  ctx.stroke();
  mark.puffs.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
};

export function ogImage({ title, description, eyebrow }: OgImage): Buffer {
  registerFonts();
  const canvas = createCanvas(WIDTH * SCALE, HEIGHT * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const left = 80;
  const textWidth = 570;

  // Header: the mark and the wordmark, like the site's nav.
  drawMark(ctx, left, 56, 44);
  ctx.fillStyle = ink;
  ctx.font = "34px 'Albert Sans'";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("haus", left + 56, 92);

  // The house, right, as in the hero.
  const plateBox = { x: WIDTH - PLATE - 40, y: (HEIGHT - PLATE) / 2 + 10 };
  ctx.drawImage(housePlate(), plateBox.x, plateBox.y, PLATE, PLATE);

  // Title: Albert Sans, tight, up to three lines.
  const titleFit = fit(ctx, title, "{size}px 'Albert Sans'", textWidth, [84, 76, 68, 60, 54, 48], 3);
  const lineHeight = titleFit.size * 1.06;
  ctx.font = `${titleFit.size}px 'Albert Sans'`;
  ctx.letterSpacing = `${(-0.025 * titleFit.size).toFixed(2)}px`;

  ctx.letterSpacing = "0px";
  const sub = description ? fit(ctx, description, "{size}px Geist", textWidth - 10, [27, 25, 23], 3) : undefined;
  const subLine = sub ? sub.size * 1.45 : 0;

  const eyebrowHeight = eyebrow ? 44 : 0;
  const block = eyebrowHeight + titleFit.lines.length * lineHeight + (sub ? 28 + sub.lines.length * subLine : 0);
  const top = Math.max(150, (HEIGHT - block) / 2 + 30);

  if (eyebrow) {
    ctx.font = "500 19px 'Geist Mono'";
    ctx.letterSpacing = "1.5px";
    ctx.fillStyle = ink3;
    ctx.fillText(eyebrow.toUpperCase(), left, top + 19);
  }

  // The brush under the last word, like "home." in the hero (.brush > .wash).
  ctx.font = `${titleFit.size}px 'Albert Sans'`;
  ctx.letterSpacing = `${(-0.025 * titleFit.size).toFixed(2)}px`;
  const firstBaseline = top + eyebrowHeight + titleFit.size * 0.9;
  const lastLine = titleFit.lines.at(-1)!;
  const lastWord = lastLine.split(" ").at(-1)!;
  const lastBaseline = firstBaseline + (titleFit.lines.length - 1) * lineHeight;
  const wordX = left + ctx.measureText(lastLine).width - ctx.measureText(lastWord).width;
  const em = titleFit.size;
  const [a, b] = brushFor(title);
  paintWash(
    ctx,
    { x: wordX - 0.3 * em, y: lastBaseline + 0.24 * em - 0.75 * em, w: ctx.measureText(lastWord).width + 0.55 * em, h: 0.75 * em },
    SCALE,
    {
      seed: 21 + (hash(title) % 997),
      strokes: [
        { x: 0.48, y: 0.55, rx: 0.46, ry: 0.32, rot: -0.03, color: a, strength: 1.5, wobble: 0.7 },
        { x: 0.8, y: 0.5, rx: 0.18, ry: 0.28, color: b, strength: 1.2, wobble: 0.7 },
      ],
    },
  );

  ctx.fillStyle = ink;
  titleFit.lines.forEach((line, i) => ctx.fillText(line, left, firstBaseline + i * lineHeight));

  if (sub) {
    ctx.font = `${sub.size}px Geist`;
    ctx.letterSpacing = "0px";
    ctx.fillStyle = ink2;
    const subTop = lastBaseline + 28 + sub.size * 1.1;
    sub.lines.forEach((line, i) => ctx.fillText(line, left, subTop + i * subLine));
  }

  // Footer: the address.
  ctx.font = "500 19px 'Geist Mono'";
  ctx.letterSpacing = "0.5px";
  ctx.fillStyle = ink3;
  ctx.fillText("haus-fmt.org", left, HEIGHT - 52);

  return canvas.toBuffer("image/png");
}

/** The painted house alone, square, on white: for READMEs, listings and the like. */
export const housePng = (size: number, scale: number) => plateCanvas(size, scale).toBuffer("image/png");
