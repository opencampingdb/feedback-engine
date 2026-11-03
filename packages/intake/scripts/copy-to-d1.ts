/**
 * Copies the recent list from the old RECENT_PLACES KV namespace into the
 * RECENT_LIST D1 database, from the operator's own machine, through
 * Wrangler's platform proxy. Run it from packages/intake after `wrangler login`:
 *
 *   npm run copy-to-d1 -- --kv <RECENT_PLACES namespace id> --d1 <RECENT_LIST database_id>
 *
 * That first copy, before the deploy, copies everything and prints the
 * `--since <time>` to add to the copy after the deploy, which then copies
 * only what KV took from that time on and leaves the block list alone.
 * Add `--local` to rehearse against the local state `wrangler dev` keeps.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { copyToD1 } from "../src/copy-to-d1.js";
import type { ListableKV } from "../src/recent-kv.js";
import type { D1Like } from "../src/recent.js";

const { values } = parseArgs({
  options: {
    kv: { type: "string" },
    d1: { type: "string" },
    since: { type: "string" },
    local: { type: "boolean", default: false },
  },
});
const id = /^[0-9a-f-]{8,}$/i;
const badSince = values.since !== undefined && Number.isNaN(Date.parse(values.since));
if (!values.kv || !values.d1 || !id.test(values.kv) || !id.test(values.d1) || badSince) {
  console.error(
    "Usage: npm run copy-to-d1 -- --kv <RECENT_PLACES namespace id> --d1 <RECENT_LIST database_id> [--since <ISO time>] [--local]",
  );
  process.exit(2);
}

// A configuration holding only the two stores, so nothing else of the intake is touched.
const remote = !values.local;
const dir = mkdtempSync(join(tmpdir(), "recent-list-copy-"));
const configPath = join(dir, "wrangler.toml");
writeFileSync(
  configPath,
  [
    'name = "recent-list-copy"',
    'compatibility_date = "2026-10-01"',
    "",
    "[[kv_namespaces]]",
    'binding = "RECENT_PLACES"',
    `id = "${values.kv}"`,
    `remote = ${remote}`,
    "",
    "[[d1_databases]]",
    'binding = "RECENT_LIST"',
    'database_name = "recent-list"',
    `database_id = "${values.d1}"`,
    `remote = ${remote}`,
    "",
  ].join("\n"),
);

const proxy = await getPlatformProxy<{ RECENT_PLACES: ListableKV; RECENT_LIST: D1Like }>({
  configPath,
  remoteBindings: remote,
  persist: { path: resolve(".wrangler/state/v3") },
});
// Five minutes early, so a clock a little behind Cloudflare's misses nothing the next copy should pick up.
const started = new Date(Date.now() - 5 * 60 * 1000).toISOString();
try {
  const what = values.since ? `what KV took from ${values.since}, without the block list` : "everything";
  console.log(`Copying ${what} from ${remote ? "Cloudflare" : "local state"}: KV ${values.kv} into D1 ${values.d1}`);
  const count = await copyToD1(proxy.env.RECENT_PLACES, proxy.env.RECENT_LIST, values.since ? { since: values.since } : {});
  console.log(`D1 now holds the ${count.places} new places, ${count.evidence} pieces of evidence and ${count.blocked} blocked contributors from KV.`);
  if (!values.since) console.log(`For the copy after the deploy, add: --since ${started}`);
} finally {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}
