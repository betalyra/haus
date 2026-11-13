/**
 * One Open Graph image per page, rendered at build time: the landing page,
 * the playground and every docs page (src/lib/og/image.ts).
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { ogImage, type OgImage } from "@/lib/og/image";
import { sitePages } from "@/lib/og/routes";

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  // The eyebrow names the sidebar group: the first folder under docs/, or "Docs".
  const eyebrow = (id: string) => (id.split("/")[1] ?? "docs").replace(/-/g, " ");
  return [
    ...Object.entries(sitePages).map(([slug, page]) => ({ params: { slug }, props: page satisfies OgImage })),
    ...docs.map((doc) => ({
      params: { slug: doc.id },
      props: { title: doc.data.title, description: doc.data.description, eyebrow: eyebrow(doc.id) } satisfies OgImage,
    })),
  ];
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(new Uint8Array(ogImage(props as OgImage)), { headers: { "Content-Type": "image/png" } });
