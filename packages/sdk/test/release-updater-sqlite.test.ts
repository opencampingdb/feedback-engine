import type { DatabaseSync as Database } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createReleaseUpdater, sha256HexBytes, type ReleaseDatabaseAdapter, type ReleaseFetchLike } from "../src/index.js";

// A real changeset made with SQLite's session extension (node:sqlite), applied
// through the updater to a real database that also holds a traveller's own table.
// Skipped on a Node whose node:sqlite has no sessions (before 22.13).
const sqlite = await import("node:sqlite").catch(() => undefined);
const sessions = typeof sqlite?.DatabaseSync.prototype.createSession === "function";
const { DatabaseSync, constants } = (sqlite ?? {}) as typeof import("node:sqlite");

const MANIFEST_URL = "https://example.org/manifest.json";
const V1 = "20261101T000000Z-aaaaaaa";
const V2 = "20261101T010000Z-bbbbbbb";
const V3 = "20261101T020000Z-ccccccc";

const LAYOUT = `
  CREATE TABLE release (id INTEGER PRIMARY KEY, data_version TEXT NOT NULL, layout_version INTEGER NOT NULL);
  CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL, record TEXT NOT NULL);
`;

function releaseDatabase(dataVersion: string, places: [string, string | null, string][]): Database {
  const db = new DatabaseSync(":memory:");
  db.exec(LAYOUT);
  db.prepare("INSERT INTO release VALUES (1, ?, 1)").run(dataVersion);
  const insert = db.prepare("INSERT INTO places VALUES (?, ?, ?, '{}')");
  for (const place of places) insert.run(...place);
  return db;
}

/** The changeset that turns `from` into `to`, made the way the release build does: a session diff of every table. */
function changeset(from: Database, to: Database): Uint8Array {
  const work = new DatabaseSync(":memory:");
  work.exec(LAYOUT);
  for (const table of ["release", "places"]) {
    for (const row of from.prepare(`SELECT * FROM ${table}`).all()) {
      const values = Object.values(row);
      work.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(", ")})`).run(...(values as never[]));
    }
  }
  const session = work.createSession();
  work.exec("DELETE FROM release; DELETE FROM places;");
  for (const table of ["release", "places"]) {
    for (const row of to.prepare(`SELECT * FROM ${table}`).all()) {
      const values = Object.values(row);
      work.prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(", ")})`).run(...(values as never[]));
    }
  }
  return session.changeset();
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The adapter an app writes, over node:sqlite: each changeset in a transaction, aborting on any conflict. */
function adapterFor(db: Database): ReleaseDatabaseAdapter {
  return {
    currentDataVersion: async () => (db.prepare("SELECT data_version FROM release").get()?.data_version as string | undefined) ?? null,
    currentLayoutVersion: async () => (db.prepare("SELECT layout_version FROM release").get()?.layout_version as number | undefined) ?? null,
    applyChangeset: async (bytes) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const applied = db.applyChangeset(bytes, { onConflict: () => constants.SQLITE_CHANGESET_ABORT });
        if (!applied) throw new Error("the changeset conflicts with the database");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    replaceDatabase: async () => {
      throw new Error("not used here");
    },
  };
}

async function serve(changesets: { from: string; to: string; bytes: Uint8Array }[], latest: string) {
  const files = new Map<string, Uint8Array>();
  const entries = await Promise.all(
    changesets.map(async (c, i) => {
      const gz = await gzip(c.bytes);
      const url = `https://example.org/changeset-${i}.bin.gz`;
      files.set(url, gz);
      return { file: `changeset-${i}.bin.gz`, url, sha256: sha256HexBytes(gz), bytes: gz.length, from: c.from, to: c.to, day: false };
    }),
  );
  const manifest = {
    data_version: latest,
    layout_version: 1,
    database: { file: "ocdb.sqlite.gz", url: "https://example.org/ocdb.sqlite.gz", sha256: "0".repeat(64), bytes: 1 },
    changesets: entries,
  };
  const fetch: ReleaseFetchLike = async (url) => {
    const body = url === MANIFEST_URL ? new TextEncoder().encode(JSON.stringify(manifest)) : files.get(url);
    if (!body) return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return { status: 200, json: async () => JSON.parse(new TextDecoder().decode(body)), arrayBuffer: async () => body.slice().buffer };
  };
  return fetch;
}

describe.skipIf(!sessions)("createReleaseUpdater with node:sqlite", () => {
  const r1 = sessions && releaseDatabase(V1, [["ocdb_a", "River Bend", "camp_site"], ["ocdb_b", "Old Rest Stop", "rest_area"]]);
  const r2 = sessions && releaseDatabase(V2, [["ocdb_a", "River Bend Reserve", "camp_site"], ["ocdb_b", "Old Rest Stop", "rest_area"], ["ocdb_c", null, "toilets"]]);
  const r3 = sessions && releaseDatabase(V3, [["ocdb_a", "River Bend Reserve", "camp_site"], ["ocdb_c", "Main Street Toilets", "toilets"]]);

  it("applies real changesets and leaves the traveller's own table alone", async () => {
    const fetch = await serve([{ from: V1, to: V2, bytes: changeset(r1 as Database, r2 as Database) }, { from: V2, to: V3, bytes: changeset(r2 as Database, r3 as Database) }], V3);
    const phone = releaseDatabase(V1, [["ocdb_a", "River Bend", "camp_site"], ["ocdb_b", "Old Rest Stop", "rest_area"]]);
    phone.exec("CREATE TABLE own_places (id TEXT PRIMARY KEY, name TEXT); INSERT INTO own_places VALUES ('new_1', 'My Spot');");

    const result = await createReleaseUpdater({ adapter: adapterFor(phone), readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL }).update();

    expect(result).toEqual({ status: "updated", dataVersion: V3 });
    expect(phone.prepare("SELECT id, name, kind FROM places ORDER BY id").all().map((row) => ({ ...row }))).toEqual(
      (r3 as Database).prepare("SELECT id, name, kind FROM places ORDER BY id").all().map((row) => ({ ...row })),
    );
    expect({ ...phone.prepare("SELECT * FROM own_places").get() }).toEqual({ id: "new_1", name: "My Spot" });
  });

  it("leaves the database as it was when a changeset conflicts", async () => {
    const fetch = await serve([{ from: V1, to: V2, bytes: changeset(r1 as Database, r2 as Database) }], V2);
    // Someone wrote to a release table, which a changeset expects untouched.
    const phone = releaseDatabase(V1, [["ocdb_a", "Edited on the phone", "camp_site"], ["ocdb_b", "Old Rest Stop", "rest_area"]]);

    const result = await createReleaseUpdater({ adapter: adapterFor(phone), readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL }).update();

    expect(result).toEqual({ status: "failed", dataVersion: V1, reason: "apply" });
    expect(phone.prepare("SELECT id, name FROM places ORDER BY id").all().map((row) => ({ ...row }))).toEqual([
      { id: "ocdb_a", name: "Edited on the phone" },
      { id: "ocdb_b", name: "Old Rest Stop" },
    ]);
  });
});
