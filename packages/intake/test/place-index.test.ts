import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type Env } from "../src/index.js";
import { getIndexedPlace, indexedPlacesInBbox, MAX_PLACE_INDEX_BYTES, type Cell } from "../src/place-index.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const TOKEN = "places-token-for-the-data-release";
const ID = (n: number) => `ocdb_01JBXK3M8Q4R5S6T7V8W9X0Y${String(n).padStart(2, "0")}`;

interface Line {
  id: string;
  cell: Cell;
  facts: Record<string, unknown>;
  fact_sources: Record<string, string>;
  fact_dates: Record<string, string>;
}

const place = (n: number, cell: Cell, facts: Record<string, unknown> = { toilets: true }): Line => ({
  id: ID(n),
  cell,
  facts,
  fact_sources: Object.fromEntries(Object.keys(facts).map((k) => [k, "osm"])),
  fact_dates: {},
});
const line = (p: unknown) => JSON.stringify(p);
const hashOf = (places: Line[]) => createHash("sha256").update(places.map((p) => line(p) + "\n").join("")).digest("hex");

/** A call body: the cells it names, each with its places' hash or null when given no places, then the places. */
function body(cells: Cell[], places: Line[]): string {
  const inCell = (cell: Cell) => places.filter((p) => p.cell[0] === cell[0] && p.cell[1] === cell[1]);
  const head = { cells: cells.map((cell) => ({ cell, hash: inCell(cell).length > 0 ? hashOf(inCell(cell)) : null })) };
  return [line(head), ...places.map(line)].join("\n") + "\n";
}

const put = (payload: string | Uint8Array<ArrayBuffer>, token = TOKEN) =>
  new Request("https://intake.example/v1/place-index", {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${token}` },
    body: payload,
  });
const cells = (token = TOKEN) =>
  new Request("https://intake.example/v1/place-index/cells", { headers: { authorization: `Bearer ${token}` } });

describe("place index", () => {
  let d1: ReturnType<typeof fakeD1>;
  let e: Env;
  const handle = createHandler({ fetch: async () => new Response("not found", { status: 404 }), now: () => Date.parse("2026-11-04T09:00:00Z") });

  beforeEach(() => {
    d1 = fakeD1();
    e = {
      APP_KEYS: "{}",
      DEVICE_SALT: "pepper",
      GH_APP_ID: "1",
      GH_APP_PRIVATE_KEY: "unused",
      GH_INSTALLATION_ID: "2",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: listableKv(),
      RECENT_LIST: d1,
      PLACES_TOKEN: TOKEN,
    };
  });

  const perth: Cell = [115, -32];
  const brookton: Cell = [117, -33];
  const first = [
    place(1, perth, { toilets: true, phone: "+61 8 9000 0000" }),
    place(2, perth),
    { ...place(3, brookton, { fee: false }), fact_sources: { fee: "feedback" }, fact_dates: { fee: "2026-11-01T10:00:00Z" } },
  ];

  it("loads an index and reads a place back by id and by box", async () => {
    const res = await handle(put(body([perth, brookton], first)), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cells: 2, places: 3 });

    expect(await getIndexedPlace(d1, ID(3))).toEqual(first[2]);
    expect(await getIndexedPlace(d1, ID(9))).toBeUndefined();
    expect((await indexedPlacesInBbox(d1, [115.2, -31.9, 115.9, -31.1])).map((p) => p.id)).toEqual([ID(1), ID(2)]);
    expect((await indexedPlacesInBbox(d1, [115.5, -32.5, 117.5, -31.5])).map((p) => p.id)).toEqual([ID(1), ID(2), ID(3)]);
    // An edge on a whole degree only touches the next cell.
    expect((await indexedPlacesInBbox(d1, [114, -33, 116, -31])).map((p) => p.id)).toEqual([ID(1), ID(2)]);
    expect(await indexedPlacesInBbox(d1, [140, -30, 141, -29])).toEqual([]);

    const listed = await handle(cells(), e);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      cells: [
        { cell: perth, hash: hashOf(first.slice(0, 2)) },
        { cell: brookton, hash: hashOf(first.slice(2)) },
      ],
    });
  });

  it("replaces only the cells a call names, in one batch", async () => {
    await handle(put(body([perth, brookton], first)), e);
    const changed = [place(2, perth, { toilets: false })];
    d1.statements.length = 0;
    expect(await (await handle(put(body([perth], changed)), e)).json()).toEqual({ cells: 1, places: 1 });

    expect(await getIndexedPlace(d1, ID(1))).toBeUndefined();
    expect((await getIndexedPlace(d1, ID(2)))!.facts).toEqual({ toilets: false });
    expect(await getIndexedPlace(d1, ID(3))).toEqual(first[2]);
    const written = d1.statements.filter((s) => !/^\s*select/i.test(s));
    expect(written).toHaveLength(4);
  });

  it("forgets a cell sent with no hash, and keeps a place that moved in the cell it moved to", async () => {
    await handle(put(body([perth, brookton], first)), e);
    // Place 3 moved to Perth, and Brookton now holds nothing. Perth arrives first.
    const now = [first[0]!, first[1]!, { ...first[2]!, cell: perth }];
    await handle(put(body([perth], now)), e);
    expect((await getIndexedPlace(d1, ID(3)))!.cell).toEqual(perth);
    await handle(put(body([brookton], [])), e);
    expect((await getIndexedPlace(d1, ID(3)))!.cell).toEqual(perth);
    expect(((await (await handle(cells(), e)).json()) as { cells: unknown[] }).cells).toEqual([{ cell: perth, hash: hashOf(now) }]);
  });

  it("takes a gzipped body", async () => {
    const res = await handle(put(gzipSync(body([perth, brookton], first))), e);
    expect(res.status).toBe(200);
    expect(await getIndexedPlace(d1, ID(1))).toEqual(first[0]);
  });

  it("holds a cell bigger than one insert", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...place(i, perth), facts: { description: "x".repeat(20_000) }, fact_sources: { description: "osm" } }));
    const res = await handle(put(gzipSync(body([perth], many))), e);
    expect(await res.json()).toEqual({ cells: 1, places: 60 });
    expect(await indexedPlacesInBbox(d1, [115, -32, 116, -31])).toHaveLength(60);
    expect(d1.statements.filter((s) => s.includes("INSERT OR REPLACE INTO place_index")).length).toBeGreaterThan(1);
  });

  it("refuses a bad body and changes nothing", async () => {
    await handle(put(body([perth, brookton], first)), e);
    const before = await indexedPlacesInBbox(d1, [-180, -90, 180, 90]);
    const refused = async (payload: string | Uint8Array<ArrayBuffer>) => (await handle(put(payload), e)).status;

    expect(await refused("")).toBe(400);
    expect(await refused(line({ cells: [] }))).toBe(400);
    expect(await refused(line({ cells: [{ cell: [115.5, -32], hash: null }] }))).toBe(400);
    expect(await refused(line({ cells: [{ cell: perth, hash: "abc" }] }))).toBe(400);
    expect(await refused(line({ cells: [{ cell: perth, hash: null }, { cell: perth, hash: null }] }))).toBe(400);
    // A place in a cell the call doesn't name, or names without a hash.
    expect(await refused(body([perth], [place(1, perth), place(3, brookton)]))).toBe(400);
    expect(await refused([line({ cells: [{ cell: perth, hash: null }] }), line(place(1, perth))].join("\n"))).toBe(400);
    expect(await refused(body([perth], [place(1, perth), place(1, perth)]))).toBe(400);
    expect(await refused(body([perth], [{ ...place(1, perth), id: "fb_nope" }]))).toBe(400);
    expect(await refused(body([perth], [{ ...place(1, perth), fact_sources: { toilets: 1 } }] as unknown as Line[]))).toBe(400);
    expect(await refused(body([perth], [place(1, perth)]).replace(/\n$/, "\n{not json\n"))).toBe(400);
    expect(await refused(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).toBe(400);
    expect(await refused(gzipSync(" ".repeat(MAX_PLACE_INDEX_BYTES + 1)))).toBe(413);

    expect(await indexedPlacesInBbox(d1, [-180, -90, 180, 90])).toEqual(before);
  });

  describe("token guard", () => {
    it("refuses a wrong or missing token", async () => {
      expect((await handle(put(body([perth], first.slice(0, 2)), "not-the-token"), e)).status).toBe(401);
      expect((await handle(new Request("https://intake.example/v1/place-index", { method: "PUT", body: body([perth], first.slice(0, 2)) }), e)).status).toBe(401);
      expect((await handle(cells("not-the-token"), e)).status).toBe(401);
      expect(await getIndexedPlace(d1, ID(1))).toBeUndefined();
    });

    it("is not served without a token or the database", async () => {
      const { PLACES_TOKEN: _, ...noToken } = e;
      expect((await handle(put(body([perth], first.slice(0, 2))), noToken)).status).toBe(404);
      expect((await handle(cells(), noToken)).status).toBe(404);
      const { RECENT_LIST: __, ...noDatabase } = e;
      expect((await handle(put(body([perth], first.slice(0, 2))), noDatabase)).status).toBe(404);
    });

    it("answers other methods with 405", async () => {
      expect((await handle(new Request("https://intake.example/v1/place-index", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }), e)).status).toBe(405);
      expect((await handle(new Request("https://intake.example/v1/place-index/cells", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` } }), e)).status).toBe(405);
    });
  });
});
