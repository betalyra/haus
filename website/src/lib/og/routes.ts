/**
 * Where each page's Open Graph image lives: /og/<page>.png, with the landing
 * page at /og/index.png.
 */

/** Pages outside the docs, with what their image says. */
export const sitePages = {
  index: {
    title: "A data format that feels like home.",
    description: "Readable like a note, strict like a type system.",
  },
  play: {
    title: "Try haus in the playground",
    description: "Write haus in your browser and see the types it infers as you type.",
  },
} as const;

/** The image path for a route id ("" or "index" for the landing page, "docs/spec", …). */
export const ogImagePath = (id: string) => `/og/${id.replace(/^\/|\/$/g, "") || "index"}.png`;

export const ogImageUrl = (id: string, site: URL | undefined) => new URL(ogImagePath(id), site).toString();
