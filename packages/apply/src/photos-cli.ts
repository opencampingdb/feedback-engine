#!/usr/bin/env node
/**
 * Tools for an app's photo repository.
 *
 *   ocdb-photos sync --root <dir> --serving <bucket> --pending <bucket> [--dry-run]
 *   ocdb-photos check --root <dir> --places <Open Camping DB data dir> --licence <id>
 *
 * sync talks to R2 through its S3 API with the AWS CLI, using R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY from the environment. It exits 1
 * when a visible photo has no file to copy. check exits 1 on any problem.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { DataRepo } from "./io.js";
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
    await this.#s3api("copy-object", "--copy-source", `${fromBucket}/${fromKey}`, "--bucket", toBucket, "--key", toKey);
  }

  async put(bucket: string, key: string, body: string, contentType: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "photos-"));
    try {
      const file = join(dir, "body");
      await writeFile(file, body, "utf8");
      await this.#s3api("put-object", "--bucket", bucket, "--key", key, "--body", file, "--content-type", contentType);
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

  // Each place's records, rewritten every run; files for places with no visible photos go.
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
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (command === "sync" && values.serving && values.pending) return sync(values.root!, values.serving, values.pending, values["dry-run"]!);
  if (command === "check" && values.places && values.licence) return check(values.root!, values.places, values.licence);
  console.log("Usage: ocdb-photos sync --root <dir> --serving <bucket> --pending <bucket> [--dry-run]\n       ocdb-photos check --root <dir> --places <dir> --licence <id>");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
