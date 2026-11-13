import { defineCollection } from "astro:content";
import { glob, type Loader } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { repo } from "@/lib/links";

/** The repo root: docs live in /docs, next to the spec, and read well on GitHub too. */
const root = new URL("../../", import.meta.url);

/** Doc pages: docs/foo/bar.md becomes /docs/foo/bar, docs/index.md becomes /docs. */
const pages = glob({
  base: fileURLToPath(new URL("docs/", root)),
  pattern: "**/*.{md,mdx}",
  generateId: ({ entry }) => `docs/${entry.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "")}`.replace(/\/$/, ""),
});

/**
 * Spec files rendered as doc pages. They stay plain Markdown for GitHub: the
 * title comes from the first heading (dropped from the body, Starlight renders
 * it), and links into the repo point at GitHub.
 */
const specs = [
  {
    id: "docs/spec",
    file: "spec/README.md",
    title: "Specification",
    description: "The precise rules of haus: data model, numbers, strings, variants, streams, limits, the standard format and schemas.",
  },
  {
    id: "docs/spec/time",
    file: "spec/std/time.md",
    title: "The std/time profile",
    description: "Which strings Date, Time, Instant, Duration and the other std/time types accept.",
  },
];

/** Relative links (not anchors, not docs pages) resolved against the file and sent to GitHub. */
const linkToRepo = (markdown: string, file: string) =>
  markdown.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, href: string) => {
    const target = new URL(href, new URL(file, "https://repo/")).pathname.replace(/^\//, "");
    const kind = /\.[a-z]+$/i.test(target) ? "blob" : "tree";
    return `](${repo}/${kind}/main/${target})`;
  });

const spec: Loader = {
  name: "haus-spec",
  load: async ({ store, parseData, renderMarkdown, generateDigest, watcher }) => {
    for (const { id, file, title, description } of specs) {
      const path = fileURLToPath(new URL(file, root));
      const load = async () => {
        const source = await readFile(path, "utf8");
        const body = linkToRepo(source.replace(/^# .*\n+/, ""), file);
        const data = await parseData({ id, data: { title, description, editUrl: `${repo}/edit/main/${file}` } });
        store.set({ id, data, body, filePath: `../${file}`, digest: generateDigest(body), rendered: await renderMarkdown(body, { fileURL: new URL(file, root) }) });
      };
      await load();
      watcher?.add(path);
      watcher?.on("change", (changed) => changed === path && load());
    }
  },
};

/** Both loaders feed one collection. */
const docsAndSpec: Loader = {
  name: "haus-docs",
  load: async (context) => {
    await pages.load(context);
    await spec.load(context);
  },
};

export const collections = {
  docs: defineCollection({ loader: docsAndSpec, schema: docsSchema() }),
};
