/**
 * The names a place's own website gives itself: the page's title and its
 * headings. The AI reviewer reads them to confirm a new name a traveller
 * sent for the place (see `nameConfirmed`).
 */

import type { Fetch } from "./github.js";
import { decode, readPage } from "./overture-reviewer.js";

/** The most headings read from one page. */
const MAX_HEADINGS = 20;
/** The longest title or heading kept. */
const MAX_NAME_CHARS = 200;

/** Text inside markup, with tags dropped, entities decoded and spaces folded. */
const plain = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);

/** The title and the `h1` to `h3` headings of an HTML page, in page order after the title, without empty ones. */
export function pageNames(html: string): string[] {
  const page = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1];
  const headings = [...page.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)].slice(0, MAX_HEADINGS).map((m) => m[2]!);
  return [...(title !== undefined ? [title] : []), ...headings].map(plain).filter((text) => text !== "");
}

/**
 * The title and headings of the place's website on record, `website`, or
 * undefined when it has none or the page can't be read, within the limits
 * `readPage` keeps. Never throws.
 */
export async function readSiteNames(fetchSite: Fetch, website: unknown): Promise<string[] | undefined> {
  if (typeof website !== "string") return undefined;
  const page = await readPage(fetchSite, website);
  return "html" in page ? pageNames(page.html) : undefined;
}
