/**
 * Shareable links: page state, compressed, in the URL fragment (after #),
 * which browsers never send to a server.
 */

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** JSON state as a compact URL-safe string. */
export async function encodeState(state: unknown): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream("deflate-raw")));
}

/** The JSON state back, or undefined if the string is damaged. */
export async function decodeState(text: string): Promise<unknown> {
  try {
    const bytes = await pipe(fromBase64Url(text), new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** Copy the current address, and say so on the button for a moment. */
export async function copyLink(button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    button.dataset.done = "Link copied";
  } catch {
    button.dataset.done = "Copy the address bar";
  }
  setTimeout(() => delete button.dataset.done, 1800);
}

/** Copy a text, and say so on the button for a moment. */
export async function copyText(button: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    button.dataset.done = "Copied";
  } catch {
    button.dataset.done = "Couldn't copy";
  }
  setTimeout(() => delete button.dataset.done, 1500);
}
