#!/usr/bin/env node
/**
 * Tools for an app's photo repository.
 *
 *   ocdb-photos sync --root <dir> --serving <bucket> --pending <bucket> [--dry-run]
 *   ocdb-photos check --root <dir> --places <Open Camping DB data dir> --licence <id>
 *   ocdb-photos replace --root <dir> --photo <pho_id> --full <file> --thumb <file>
 *                       --serving <bucket> --pending <bucket> --state-namespace <KV namespace id>
 *
 * sync and replace talk to R2 through its S3 API with the AWS CLI, using
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY from the
 * environment. replace also writes the photo server's state namespace through
 * the Cloudflare API, with CLOUDFLARE_API_TOKEN (Workers KV Storage Write) in
 * the environment, and changes the photo's line in the checkout: commit it to
 * the records repository's main. sync exits 1 when a visible photo has no file
 * to copy. check exits 1 on any problem.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { DataRepo } from "./io.js";
import { readFile as readBytes } from "node:fs/promises";
import { replacePhoto, ReplaceError } from "./photo-replace.js";
import { checkPhotos, photoStates, planSync, recordFiles, RECORDS } from "./photorepo.js";

const run = promisify(execFile);

class R2 {
  readonly #endpoint: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(account: string) {
    this.#endpoint = `https://${account}.r2.cloudflarestorage.com`;
    this.#env = {
      ...process.env,
      AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      AWS_DEFAULT_REGION: "auto",
      // R2 does not take the checksums newer AWS CLI versions add by default.
      AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
    };
  }

  async #s3api(...args: string[]): Promise<string> {
    const { stdout } = await run("aws", ["s3api", ...args, "--endpoint-url", this.#endpoint, "--output", "json"], {
      env: this.#env,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  }

  async keys(bucket: string): Promise<Set<string>> {
    const out = new Set<string>();
    let token: string | undefined;
    do {
      const page = JSON.parse((await this.#s3api("list-objects-v2", "--bucket", bucket, "--max-items", "100000", ...(token ? ["--starting-token", token] : []))) || "{}") as {
        Contents?: { Key: string }[];
        NextToken?: string;
      };
      for (const object of page.Contents ?? []) out.add(object.Key);
      token = page.NextToken;
    } while (token);
    return out;
  }

  async copy(fromBucket: string, fromKey: string, toBucket: string, toKey: string): Promise<void> {
    // COPY keeps the upload's metadata (its contributor), which the photo server reads to withhold an erased contributor's photos.
    await this.#s3api("copy-object", "--copy-source", `${fromBucket}/${fromKey}`, "--bucket", toBucket, "--key", toKey, "--metadata-directive", "COPY");
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.#s3api("head-object", "--bucket", bucket, "--key", key);
      return true;
    } catch (error) {
      // head-object exits non-zero with "Not Found" (404) for a missing key. Anything else is a real failure.
      if (/\(404\)|Not Found/.test(String((error as { stderr?: unknown }).stderr ?? error))) return false;
      throw error;
    }
  }

  async put(bucket: string, key: string, body: string | Uint8Array, contentType: string, metadata?: Record<string, string>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "photos-"));
    try {
      const file = join(dir, "body");
      await writeFile(file, body);
      const meta = metadata ? ["--metadata", JSON.stringify(metadata)] : [];
      await this.#s3api("put-object", "--bucket", bucket, "--key", key, "--body", file, "--content-type", contentType, ...meta);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async delete(bucket: string, keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true };
      await this.#s3api("delete-objects", "--bucket", bucket, "--delete", JSON.stringify(batch));
    }
  }
}

async function sync(root: string, serving: string, pending: string, dryRun: boolean): Promise<number> {
  const account = process.env.R2_ACCOUNT_ID;
  if (!account) {
    console.error("R2_ACCOUNT_ID is not set, so there are no buckets to update");
    return 0;
  }
  const r2 = new R2(account);
  const { visible, other } = await photoStates(root);
  const removed = new Set((await new DataRepo(root).removedPhotos()).map((e) => e.photo));
  const servingKeys = await r2.keys(serving);
  const todo = planSync({ visible, other, removed, serving: servingKeys, pending: await r2.keys(pending) }, { serving, pending });

  for (const [fromBucket, fromKey, toBucket, toKey] of todo.copies) {
    console.log(`copy ${fromBucket}/${fromKey} to ${toBucket}/${toKey}`);
    if (!dryRun) await r2.copy(fromBucket, fromKey, toBucket, toKey);
  }
  for (const [bucket, keys] of Object.entries(todo.deletes)) {
    for (const key of keys) console.log(`delete ${bucket}/${key}`);
    if (!dryRun) await r2.delete(bucket, keys);
  }

  // Each place's records are written again every run. Files for places with no visible photos go.
  const records = await recordFiles(root);
  for (const [place, text] of records) {
    if (!dryRun) await r2.put(serving, `${RECORDS}${place}.ndjson`, text, "application/x-ndjson; charset=utf-8");
  }
  const stale = [...servingKeys].filter((k) => k.startsWith(RECORDS) && !records.has(k.slice(RECORDS.length, -".ndjson".length)));
  for (const key of stale) console.log(`delete ${serving}/${key}`);
  if (!dryRun && stale.length > 0) await r2.delete(serving, stale);

  for (const key of todo.missing) console.error(`::error::no file for visible photo ${key}`);
  console.log(`${visible.size} visible photos, ${records.size} places, ${todo.copies.length} copies, ${Object.values(todo.deletes).reduce((n, k) => n + k.length, 0) + stale.length} deletes`);
  return todo.missing.length > 0 ? 1 : 0;
}

async function check(root: string, placesRoot: string, licence: string): Promise<number> {
  const placeIds = new Set((await new DataRepo(root).allPhotos()).map((p) => p.place));
  const known = new Set((await new DataRepo(placesRoot).places(placeIds)).keys());
  const errors = await checkPhotos(root, { places: known, licence });
  for (const error of errors) console.error(`::error::${error}`);
  console.log(errors.length === 0 ? "photo lines are valid" : `${errors.length} problem(s)`);
  return errors.length > 0 ? 1 : 0;
}

async function replace(values: Record<string, string | boolean | undefined>): Promise<number> {
  const account = process.env.R2_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    console.error("replace needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and CLOUDFLARE_API_TOKEN");
    return 2;
  }
  const namespace = String(values["state-namespace"]);
  const state = async (key: string, value: string, ttlSeconds: number) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(key)}?expiration_ttl=${ttlSeconds}`;
    const res = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: value });
    if (!res.ok) throw new Error(`writing ${key} to the photo server's state answered ${res.status}: ${await res.text()}`);
  };
  try {
    const result = await replacePhoto({
      root: String(values.root),
      photo: String(values.photo),
      full: new Uint8Array(await readBytes(String(values.full))),
      thumb: new Uint8Array(await readBytes(String(values.thumb))),
      buckets: { serving: String(values.serving), pending: String(values.pending) },
      stores: new R2(account),
      state,
      now: new Date(),
    });
    for (const key of result.wrote) console.log(`wrote ${key}`);
    console.log(`${result.before.id}: sha256 ${result.before.sha256} -> ${result.after.sha256}, ${result.before.width} x ${result.before.height} -> ${result.after.width} x ${result.after.height}`);
    console.log(`Commit ${result.file} to the records repository's main, so the photo sync keeps the new hash.`);
    return 0;
  } catch (error) {
    if (error instanceof ReplaceError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      root: { type: "string", default: "." },
      serving: { type: "string" },
      pending: { type: "string" },
      places: { type: "string" },
      licence: { type: "string" },
      photo: { type: "string" },
      full: { type: "string" },
      thumb: { type: "string" },
      "state-namespace": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (command === "sync" && values.serving && values.pending) return sync(values.root!, values.serving, values.pending, values["dry-run"]!);
  if (command === "check" && values.places && values.licence) return check(values.root!, values.places, values.licence);
  if (command === "replace" && values.photo && values.full && values.thumb && values.serving && values.pending && values["state-namespace"]) return replace(values);
  console.log(
    "Usage: ocdb-photos sync --root <dir> --serving <bucket> --pending <bucket> [--dry-run]\n" +
      "       ocdb-photos check --root <dir> --places <dir> --licence <id>\n" +
      "       ocdb-photos replace --root <dir> --photo <pho_id> --full <file> --thumb <file> --serving <bucket> --pending <bucket> --state-namespace <id>",
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
