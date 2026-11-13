/**
 * The painted house on its own, 1024 x 1024 on white: the hero plate in high
 * resolution, for listings, READMEs and anywhere the small icon is too small.
 */
import type { APIRoute } from "astro";
import { housePng } from "@/lib/og/image";

export const GET: APIRoute = () =>
  new Response(new Uint8Array(housePng(512, 2)), { headers: { "Content-Type": "image/png" } });
