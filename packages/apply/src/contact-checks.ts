import { isContactFact, isValidFactValue, type AddressState, type ContactFactName, type FactValue, type PlaceAddress, type StoredFeedback } from "@opencampingdb/feedback";

/**
 * The automatic contact checks, which stand in for a person on a reported
 * contact. Pure functions over an injected `fetch`, with no Node APIs, so the
 * apply runs every check and the intake runs the website check at send time.
 *
 * - `website`: the place's own website on record (its home page and up to
 *   MAX_CONTACT_PAGES contact pages it links to) shows the reported phone,
 *   email or social link.
 * - `domain_age`: the domain of a reported website or email was not
 *   registered in the last NEW_DOMAIN_DAYS days, from its registry's RDAP
 *   answer, found through the IANA bootstrap file.
 * - `address`: the address's state and postcode belong where the place is.
 *
 * Every check fails safe: a timeout, an error or an answer that cannot be read
 * fails it, so the contact is held rather than accepted.
 */

/** A fetch as Workers and Node have it. The checks only ever pass these options. */
export type Fetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

export type ContactCheckName = "website" | "domain_age" | "address";

/**
 * One check on one contact. `detail` says what it found, in plain words, for
 * the review PR. It never holds the reported value.
 */
export interface CheckOutcome {
  check: ContactCheckName;
  passed: boolean;
  detail: string;
}

/** Domains registered fewer than this many days ago fail `domain_age`. */
export const NEW_DOMAIN_DAYS = 90;
/** IANA's list of the RDAP service for each top-level domain. */
export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
/** Contact pages the website check reads besides the home page. */
export const MAX_CONTACT_PAGES = 3;
/** How long one check may take, every page or lookup in it, in the apply. */
export const CHECK_TIMEOUT_MS = 10_000;
/** How long the website check may take at send time. */
export const SEND_TIME_BUDGET_MS = 3_000;
/** The most of a page that is read. */
export const MAX_PAGE_BYTES = 1_000_000;
/** How far, in degrees (about 33 km), the place may be from a state border and still count in either state. */
export const BORDER_DEGREES = 0.3;

const MAX_REDIRECTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = "OpenCampingDB/1.0 (+https://github.com/opencampingdb; contact check)";

/**
 * The checks a contact fact gets. A phone, email or social link is looked for
 * on the place's website, an email's and a website's domain must not be new,
 * and an address must belong where the place is.
 */
export function checksFor(fact: ContactFactName): ContactCheckName[] {
  if (fact === "website") return ["domain_age"];
  if (fact === "address") return ["address"];
  if (fact === "email") return ["website", "domain_age"];
  return ["website"];
}

/** The checks among `outcomes` that failed. */
export const failedChecks = (outcomes: readonly CheckOutcome[]) => outcomes.filter((o) => !o.passed);

// ------------------------------------------------------------------ fetching

/** The URL when it is an http or https address on a public host name and the default port, or null. */
function publicUrl(text: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (["localhost", "local", "internal", "home.arpa"].some((name) => host === name || host.endsWith(`.${name}`))) return null;
  return url;
}

const bareHost = (url: URL) => url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");

/** Reads at most `max` bytes of a response's body, and stops the rest. */
async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, max - size));
    size += Math.min(value.byteLength, max - size);
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

class CheckFailed extends Error {}

/**
 * The text of one page, following redirects on the same host (with or
 * without `www.`), at most MAX_REDIRECTS. Throws CheckFailed with why it could
 * not be read.
 */
async function getPage(fetch: Fetch, start: URL, signal: AbortSignal, accept: string): Promise<string> {
  let url = start;
  for (let hops = 0; ; hops++) {
    const res = await fetch(url.href, { redirect: "manual", signal, headers: { accept, "user-agent": USER_AGENT } });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      const next = location ? publicUrl(location, url) : null;
      if (!next || bareHost(next) !== bareHost(start)) throw new CheckFailed(`${bareHost(start)} redirects to another host`);
      if (hops >= MAX_REDIRECTS) throw new CheckFailed(`${bareHost(start)} redirects too many times`);
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new CheckFailed(`${url.href} answered ${res.status}`);
    }
    return readLimited(res, MAX_PAGE_BYTES);
  }
}

/**
 * Runs `work` with an abort signal that fires after `ms`, and gives `fallback`
 * with "timed out" when it does, or with the reason it failed.
 */
async function timeBoxed(ms: number, work: (signal: AbortSignal) => Promise<CheckOutcome>, fail: (detail: string) => CheckOutcome): Promise<CheckOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fail("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([
      work(controller.signal).catch((error: unknown) =>
        fail(error instanceof CheckFailed ? error.message : controller.signal.aborted ? "timed out" : "could not be read"),
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ------------------------------------------------------------------ website

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: "." };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

/** A phone number's digits as dialled in Australia: +61 becomes the trunk 0. */
function phoneDigits(text: string): string {
  const digits = text.replace(/\D/g, "");
  return digits.startsWith("61") && digits.length === 11 ? `0${digits.slice(2)}` : digits;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a page's HTML shows the contact `value` of `fact`. */
function pageShows(html: string, fact: ContactFactName, value: string): boolean {
  const page = decode(html);
  if (fact === "email") return page.toLowerCase().includes(value.trim().toLowerCase());
  if (fact === "phone" || fact === "phone_2") {
    const wanted = phoneDigits(value);
    if (wanted.length < 6) return false;
    const text = `${page} ${page.replace(/<[^>]*>/g, " ")}`;
    return (text.match(/\+?\d[\d\s\-.()]{4,24}\d/g) ?? []).some((run) => phoneDigits(run).includes(wanted));
  }
  // A social link: the same host (with or without www. or m.) and path.
  const url = publicUrl(value);
  if (!url) return false;
  const path = url.pathname.replace(/\/+$/, "");
  const pattern = new RegExp(`//(?:www\\.|m\\.)?${escapeRegExp(bareHost(url))}${escapeRegExp(path)}(?![\\w.-])`, "i");
  return pattern.test(page);
}

/** Links on a page to its contact pages: same host, the link or its words naming "contact". */
function contactLinks(html: string, page: URL): URL[] {
  const found = new Map<string, URL>();
  for (const [, href, words] of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/contact/i.test(`${href} ${words}`)) continue;
    const url = publicUrl(decode(href!), page);
    if (!url || bareHost(url) !== bareHost(page)) continue;
    url.hash = "";
    if (url.href !== page.href) found.set(url.href, url);
    if (found.size >= MAX_CONTACT_PAGES) break;
  }
  return [...found.values()];
}

/**
 * Whether the place's website on record shows `value`: its home page, then up
 * to MAX_CONTACT_PAGES contact pages it links to, all within `timeoutMs`. An
 * http address on record is read over https.
 */
export async function websiteCheck(fetch: Fetch, website: unknown, fact: ContactFactName, value: FactValue, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckOutcome> {
  const fail = (detail: string): CheckOutcome => ({ check: "website", passed: false, detail: `the place's website: ${detail}` });
  if (typeof website !== "string") return fail("there is none on record");
  if (typeof value !== "string") return fail("the value is not text");
  const home = publicUrl(website.replace(/^http:/i, "https:"));
  if (!home) return fail("it is not a public web address");
  return timeBoxed(
    timeoutMs,
    async (signal) => {
      const accept = "text/html,text/plain;q=0.9";
      const html = await getPage(fetch, home, signal, accept);
      if (pageShows(html, fact, value)) return { check: "website", passed: true, detail: `${bareHost(home)} shows it` };
      for (const page of contactLinks(html, home)) {
        const text = await getPage(fetch, page, signal, accept).catch((error: unknown) => {
          if (signal.aborted) throw error;
          return "";
        });
        if (pageShows(text, fact, value)) return { check: "website", passed: true, detail: `${page.href} shows it` };
      }
      return fail(`${bareHost(home)} does not show it`);
    },
    fail,
  );
}

// ------------------------------------------------------------------ domain age

/** Second-level names under which a domain is registered one level down (`example.com.au`). */
const SECOND_LEVEL = new Set([
  "com.au", "net.au", "org.au", "asn.au", "id.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz", "co.uk", "org.uk", "me.uk",
]);

/** Hosts under these are open only to government and education bodies, so no throwaway domain is under them. */
const RESTRICTED = ["gov.au", "edu.au"];

/** The registered domain of a host name: `www.camp.example.com.au` is `example.com.au`. */
export function registeredDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.+$/, "").split(".").filter((l) => l.length > 0);
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(SECOND_LEVEL.has(lastTwo) ? -3 : -2).join(".");
}

/** The RDAP base URL for each top-level domain, from IANA's bootstrap file. */
type Bootstrap = Map<string, string>;

function parseBootstrap(json: unknown): Bootstrap {
  const out: Bootstrap = new Map();
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) throw new CheckFailed("the RDAP bootstrap file could not be read");
  for (const service of services) {
    if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
    const urls = (service[1] as unknown[]).filter((u): u is string => typeof u === "string");
    const base = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    if (base === undefined) continue;
    for (const tld of service[0] as unknown[]) if (typeof tld === "string") out.set(tld.toLowerCase(), base.endsWith("/") ? base : `${base}/`);
  }
  return out;
}

/** The date of an RDAP event, as a time, or undefined. */
function eventTime(events: unknown, action: string): number | undefined {
  if (!Array.isArray(events)) return undefined;
  for (const e of events) {
    const { eventAction, eventDate } = (e ?? {}) as { eventAction?: unknown; eventDate?: unknown };
    if (eventAction === action && typeof eventDate === "string" && Number.isFinite(Date.parse(eventDate))) return Date.parse(eventDate);
  }
  return undefined;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Whether `host`'s registered domain is older than NEW_DOMAIN_DAYS, from its
 * RDAP `registration` event. A registry that gives no registration date (the
 * .au registry gives only `last changed`) passes when the domain has not
 * changed in that time either, since it is at least that old; otherwise its
 * age is unknown and the check fails.
 */
async function domainAgeCheck(fetch: Fetch, host: string, now: number, bootstrap: (signal: AbortSignal) => Promise<Bootstrap>, timeoutMs: number): Promise<CheckOutcome> {
  const domain = registeredDomain(host);
  // The domain is the traveller's own value, so the detail never names it: details go into the review PR's held cases.
  const fail = (detail: string): CheckOutcome => ({ check: "domain_age", passed: false, detail: `the domain: ${detail}` });
  const pass = (detail: string): CheckOutcome => ({ check: "domain_age", passed: true, detail: `the domain: ${detail}` });
  if (!domain.includes(".")) return fail("not a domain name");
  if (RESTRICTED.some((r) => domain === r || domain.endsWith(`.${r}`) || host.endsWith(`.${r}`))) return pass("a government or education domain");
  return timeBoxed(
    timeoutMs,
    async (signal) => {
      const base = (await bootstrap(signal)).get(domain.split(".").at(-1)!);
      if (base === undefined) return fail("no RDAP service lists its top-level domain");
      const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
        redirect: "manual",
        signal,
        headers: { accept: "application/rdap+json, application/json", "user-agent": USER_AGENT },
      });
      if (res.status === 404) return fail("the registry has no such domain");
      if (!res.ok) return fail(`the registry answered ${res.status}`);
      const answer = JSON.parse(await readLimited(res, MAX_PAGE_BYTES)) as { events?: unknown };
      const limit = now - NEW_DOMAIN_DAYS * DAY_MS;
      const registered = eventTime(answer.events, "registration");
      if (registered !== undefined) {
        return registered <= limit ? pass(`registered on ${day(registered)}`) : fail(`registered on ${day(registered)}, less than ${NEW_DOMAIN_DAYS} days ago`);
      }
      const changed = eventTime(answer.events, "last changed");
      if (changed !== undefined && changed <= limit) return pass(`no registration date, unchanged since ${day(changed)}`);
      return fail(`the registry gives no registration date, and it changed in the last ${NEW_DOMAIN_DAYS} days`);
    },
    fail,
  );
}

// ------------------------------------------------------------------ address

/** The state a postcode belongs to, from Australia Post's ranges, or null. */
export function postcodeState(postcode: string): AddressState | null {
  if (!/^\d{4}$/.test(postcode)) return null;
  const n = Number(postcode);
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
  if (n >= 800 && n <= 999) return "NT";
  if (n >= 1000 && n <= 2999) return "NSW";
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return "VIC";
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return "QLD";
  if (n >= 5000 && n <= 5999) return "SA";
  if (n >= 6000 && n <= 6999) return "WA";
  if (n >= 7000 && n <= 7999) return "TAS";
  return null;
}

/** The Murray River and the line to Cape Howe, the border between New South Wales and Victoria, as (lon, lat) points. */
const MURRAY: readonly [number, number][] = [
  [141.0, -34.1], [142.4, -34.6], [143.4, -35.2], [144.3, -35.8], [145.0, -35.9],
  [146.0, -36.0], [147.0, -36.1], [148.2, -36.8], [150.0, -37.5],
];

/** The latitude of a border line given as points, at `lon`. */
function borderLat(points: readonly [number, number][], lon: number): number {
  if (lon <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    if (lon <= x1) return y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points.at(-1)![1];
}

/**
 * The state or territory a point is in, from the borders simplified to
 * straight lines and a few points, or null outside Australia. Near a border it
 * may be wrong, which `statesNear` allows for.
 */
function stateAt(lat: number, lon: number): AddressState | null {
  if (lat > -9 || lat < -44 || lon < 112.5 || lon > 154) return null;
  if (lat < -39.4) return "TAS";
  if (lon < 129) return "WA";
  if (lon < 141) return lat >= -26 ? (lon < 138 ? "NT" : "QLD") : "SA";
  if (lon >= 148.76 && lon <= 149.4 && lat >= -35.92 && lat <= -35.12) return "ACT";
  // The Queensland border runs along 29 degrees south, then north east along rivers and ranges to the coast.
  const queensland = lon < 148.9 ? -29 : -29 + ((lon - 148.9) / (153.6 - 148.9)) * 0.83;
  if (lat >= queensland) return "QLD";
  return lat < borderLat(MURRAY, lon) ? "VIC" : "NSW";
}

/** The states a place may be in: the one at its location, and any within BORDER_DEGREES of it. */
export function statesNear(location: { lat: number; lon: number }): Set<AddressState> {
  const out = new Set<AddressState>();
  for (const dLat of [-BORDER_DEGREES, 0, BORDER_DEGREES]) {
    for (const dLon of [-BORDER_DEGREES, 0, BORDER_DEGREES]) {
      const state = stateAt(location.lat + dLat, location.lon + dLon);
      if (state !== null) out.add(state);
    }
  }
  return out;
}

/**
 * Whether an address belongs where the place is: its state, and the state its
 * postcode belongs to, are among the states the place may be in (`statesNear`).
 * There is no geocoder, so this catches an address in another part of the
 * country, not one in the next town.
 */
export function addressCheck(value: FactValue, location: { lat: number; lon: number }): CheckOutcome {
  const fail = (detail: string): CheckOutcome => ({ check: "address", passed: false, detail });
  const address = value as PlaceAddress;
  if (typeof address !== "object" || address === null) return fail("the address could not be read");
  const states = statesNear(location);
  if (states.size === 0) return fail("the place is not in an Australian state or territory");
  if (address.state === undefined && address.postcode === undefined) return fail("the address has no state or postcode to check");
  if (address.state !== undefined && !states.has(address.state)) return fail(`the address is in ${address.state}, which the place is not`);
  if (address.postcode !== undefined) {
    const state = postcodeState(address.postcode);
    if (state === null) return fail("the postcode is not an Australian postcode");
    if (!states.has(state)) return fail(`the postcode is in ${state}, which the place is not`);
  }
  return { check: "address", passed: true, detail: `the address is in ${[...states].sort().join(" or ")}, as the place is` };
}

// ------------------------------------------------------------------ all checks

export interface CheckerDeps {
  fetch: Fetch;
  now: () => number;
  /** How long each check may take. Defaults to CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** What the checks read of a place: its facts (for its website on record) and where it is. */
export interface CheckedPlace {
  facts: Record<string, unknown> | object;
  location: { lat: number; lon: number };
  /** On a tombstone: the record it was merged into, which the checks read instead. */
  merged_into?: string;
}

/** The record the rules decide a report about `id` against, following a merge once. */
function placeFor(id: string, places: ReadonlyMap<string, CheckedPlace>): CheckedPlace | undefined {
  const record = places.get(id);
  return record?.merged_into !== undefined ? (places.get(record.merged_into) ?? record) : record;
}

export interface ContactChecker {
  /** Every check `fact` gets (`checksFor`), in that order. Never throws. */
  check(fact: ContactFactName, value: FactValue, place: CheckedPlace): Promise<CheckOutcome[]>;
}

/** A checker that fetches IANA's bootstrap file once, the first time a domain is looked up. */
export function contactChecker(deps: CheckerDeps): ContactChecker {
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  let bootstrap: Promise<Bootstrap> | undefined;
  const getBootstrap = (signal: AbortSignal) => {
    bootstrap ??= deps
      .fetch(RDAP_BOOTSTRAP_URL, { redirect: "manual", signal, headers: { accept: "application/json", "user-agent": USER_AGENT } })
      .then(async (res) => {
        if (!res.ok) throw new CheckFailed(`the RDAP bootstrap file answered ${res.status}`);
        return parseBootstrap(JSON.parse(await readLimited(res, MAX_PAGE_BYTES)));
      });
    // A failed fetch is tried again for the next domain.
    bootstrap.catch(() => (bootstrap = undefined));
    return bootstrap;
  };
  return {
    async check(fact, value, place) {
      const out: CheckOutcome[] = [];
      for (const check of checksFor(fact)) {
        if (check === "website") out.push(await websiteCheck(deps.fetch, (place.facts as Record<string, unknown>).website, fact, value, timeoutMs));
        else if (check === "address") out.push(addressCheck(value, place.location));
        else {
          const host = fact === "email" ? String(value).split("@").at(-1) ?? "" : (publicUrl(String(value))?.hostname ?? "");
          out.push(await domainAgeCheck(deps.fetch, host, deps.now(), getBootstrap, timeoutMs));
        }
      }
      return out;
    },
  };
}

/** Whether the website check applies to a contact fact, so the intake can run it at send time. */
export const websiteCheckApplies = (fact: ContactFactName) => checksFor(fact).includes("website");

export interface CheckContactsOptions extends CheckerDeps {
  /** Time the whole run of checks may take, and how many contacts are checked at once. Defaults to 3 minutes and 4. */
  budget?: { ms: number; concurrency: number };
}

/** The contact fact reports among `items` that the checks are for: a valid contact value about a place in `places`. */
function checkable(item: StoredFeedback, places: ReadonlyMap<string, CheckedPlace>): boolean {
  if (item.type !== "report" || item.report.kind !== "fact" || typeof item.place !== "string") return false;
  const fact = item.report.fact;
  return isContactFact(fact) && isValidFactValue(fact, item.report.value) && places.has(item.place);
}

/**
 * Runs the checks on every contact fact report in `items`, oldest first,
 * within the budget. The result maps each checked item's id to its outcomes.
 * An item left out ran out of time and is checked again by a later run.
 */
export async function checkContacts(
  items: readonly StoredFeedback[],
  places: ReadonlyMap<string, CheckedPlace>,
  options: CheckContactsOptions,
): Promise<Map<string, CheckOutcome[]>> {
  const checker = contactChecker(options);
  const budget = options.budget ?? { ms: 3 * 60_000, concurrency: 4 };
  const todo = items.filter((i) => checkable(i, places)).sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  const out = new Map<string, CheckOutcome[]>();
  const deadline = options.now() + budget.ms;
  let next = 0;
  await Promise.all(
    Array.from({ length: budget.concurrency }, async () => {
      while (next < todo.length && options.now() < deadline) {
        const item = todo[next++] as Extract<StoredFeedback, { type: "report" }>;
        out.set(item.id, await checker.check(item.report.fact as ContactFactName, item.report.value as FactValue, placeFor(item.place as string, places)!));
      }
    }),
  );
  return out;
}
