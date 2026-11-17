import type { StoredFeedback } from "@opencampingdb/feedback";
import type { ClosureEvidence } from "./rules.js";
import type { Place } from "./types.js";

/**
 * Evidence of closure from outside the inbox, which the rules count as one
 * more source for a closure a traveller sent (`RulesInput.closureEvidence`).
 */

/**
 * One line of the data repository's `osm/history.ndjson`: what OSM's history
 * says about an object that left the extract. Its sync writes it
 * (`pipeline.custody`), with the object's main tags, lifecycle prefixes
 * included, as they are in its latest version.
 */
export interface OsmHistoryEntry {
  object: string;
  version: number;
  changeset: number;
  visible: boolean;
  tags: Record<string, string>;
}

/** Lifecycle prefixes that say a place closed. `was:`, `demolished:` and the others say less, or something else, so a person decides. */
const CLOSED_PREFIXES = ["disused:", "abandoned:"] as const;

/** Lines of `osm/history.ndjson`, by object (`node/123`). A line that is not a history entry is skipped. */
export function readOsmHistory(text: string): Map<string, OsmHistoryEntry> {
  const out = new Map<string, OsmHistoryEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Partial<OsmHistoryEntry>;
    try {
      entry = JSON.parse(line) as Partial<OsmHistoryEntry>;
    } catch {
      continue;
    }
    if (
      typeof entry.object === "string" &&
      typeof entry.version === "number" &&
      typeof entry.changeset === "number" &&
      typeof entry.visible === "boolean" &&
      typeof entry.tags === "object" &&
      entry.tags !== null
    ) {
      out.set(entry.object, entry as OsmHistoryEntry);
    }
  }
  return out;
}

/**
 * OSM newly tagging the place's object `disused:` or `abandoned:`: the
 * object is still in OSM, its latest version has such a tag, and that version
 * is newer than the one the record follows, which the extract took as a live
 * place. Undefined when OSM says nothing of the kind.
 */
export function osmClosureEvidence(place: Place, history: ReadonlyMap<string, OsmHistoryEntry>): ClosureEvidence | undefined {
  if (!place.osm) return undefined;
  const object = `${place.osm.type}/${place.osm.id}`;
  const entry = history.get(object);
  if (!entry || !entry.visible || entry.version <= place.osm.version) return undefined;
  const tags = Object.entries(entry.tags)
    .filter(([key]) => CLOSED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  return tags.length > 0 ? { kind: "osm_lifecycle", object, tags, changeset: entry.changeset } : undefined;
}

/** Closure evidence from a traveller: a closed report, or a check that found the place gone. */
export function isClosureReport(item: StoredFeedback): boolean {
  return (item.type === "report" && item.report.kind === "closed") || (item.type === "check" && item.check.still_there === false);
}

/** Whether evidence could change the place's status: open or reported closed, and not managed by its owner. */
export function evidenceCounts(place: Place): boolean {
  return (place.status === "open" || place.status === "reported_closed") && !place.owner_verified && place.fact_sources.status !== "owner";
}

/** Where the apply run keeps each domain's first NXDOMAIN answer between runs, in the inbox. */
export const NXDOMAIN_FILE = "evidence/nxdomain.json";

/** A domain not found in DNS: when the first NXDOMAIN answer in a row came. */
export interface NxdomainRecord {
  first: string;
}

/** The state `NXDOMAIN_FILE` holds: domains whose latest answer was NXDOMAIN, by domain. */
export interface NxdomainState {
  domains: Record<string, NxdomainRecord>;
}

/** DNS over HTTPS, answered in the JSON form (`application/dns-json`), as public resolvers such as 1.1.1.1 serve it. */
export interface DnsOptions {
  /** The resolver's JSON endpoint, such as `https://cloudflare-dns.com/dns-query`. */
  resolver: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** How long one lookup may take. Defaults to 5 seconds. */
  timeoutMs?: number;
}

/** What a lookup found: the name does not exist, it exists, or nothing could be told (an HTTP error, a timeout, SERVFAIL). */
export type DnsAnswer = "nxdomain" | "found" | "unknown";

/** Two NXDOMAIN answers this far apart or more count as evidence. */
const NXDOMAIN_APART_MS = 24 * 60 * 60 * 1000;
/** A record this old is dropped: a closure it could confirm is past the 90 day window. */
const NXDOMAIN_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/** The domain of a website on record: its host in lower case, without a leading `www.`. Undefined for a value that is not an https link. */
export function websiteDomain(website: unknown): string | undefined {
  if (typeof website !== "string" || !URL.canParse(website)) return undefined;
  const url = new URL(website);
  if (url.protocol !== "https:" || !url.hostname.includes(".")) return undefined;
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Looks the domain up once. Only the DNS status NXDOMAIN (3) means the name
 * does not exist. NOERROR (0) means it does, even with no address. Anything
 * else, an HTTP error, an answer that is not JSON, or a lookup that takes too
 * long, tells nothing.
 */
export async function lookUpDomain(domain: string, options: DnsOptions): Promise<DnsAnswer> {
  const fetcher = options.fetch ?? fetch;
  try {
    const url = `${options.resolver}?name=${encodeURIComponent(domain)}&type=A`;
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) return "unknown";
    const status = ((await response.json()) as { Status?: unknown }).Status;
    return status === 3 ? "nxdomain" : status === 0 ? "found" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Records one answer for a domain in `state` and returns the evidence it
 * gives: an NXDOMAIN at least a day after the first NXDOMAIN in a row. A found
 * domain starts again. An answer that tells nothing leaves the record as it is.
 */
export function recordAnswer(state: NxdomainState, domain: string, answer: DnsAnswer, now: string): ClosureEvidence | undefined {
  const known = state.domains[domain];
  if (answer === "found") {
    delete state.domains[domain];
    return undefined;
  }
  if (answer === "unknown") return undefined;
  if (!known) {
    state.domains[domain] = { first: now };
    return undefined;
  }
  return Date.parse(now) - Date.parse(known.first) >= NXDOMAIN_APART_MS ? { kind: "nxdomain", domain, first: known.first, confirmed: now } : undefined;
}

/** Drops records whose first NXDOMAIN came more than 90 days ago. */
export function pruneAnswers(state: NxdomainState, now: string): void {
  for (const [domain, record] of Object.entries(state.domains)) {
    if (Date.parse(now) - Date.parse(record.first) > NXDOMAIN_KEEP_MS) delete state.domains[domain];
  }
}
