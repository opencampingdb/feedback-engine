import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intakeRecentStore, settleRecentPlaces } from "../src/recent.js";

let root: string;
let inbox: string;
let main: string;
const NOW = new Date("2026-10-30T00:00:00Z");
const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;
const placeOf = (n: number) => `ocdb_${id(n).slice(3)}`;

async function put(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body)}\n`);
}

/** A decided inbox item, as the apply run moves it to applied/ or refused/. */
async function decided(folder: "applied" | "refused", n: number, received: string, body: Record<string, unknown>, reason = "") {
  await put(join(inbox, folder, received.slice(0, 10), `${id(n)}.json`), {
    id: id(n),
    received,
    app: "example-app",
    device: "aaaa",
    app_version: "1.0.0",
    consent: true,
    ...body,
    outcome: { result: folder === "applied" ? "applied" : "refused", reason, run: received },
  });
}
const newPlace = { type: "report", place: null, location: { lat: -30, lon: 140 }, report: { kind: "new_place" } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-recent-"));
  inbox = join(root, "inbox");
  main = join(root, "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("settleRecentPlaces", () => {
  it("removes new places that are in the data and withdrawn ones, and keeps the rest", async () => {
    await decided("applied", 1, "2026-10-28T00:00:00Z", newPlace);
    await put(join(main, "places", placeOf(1).slice(-2).toLowerCase(), `${placeOf(1)}.json`), { id: placeOf(1) });
    // Held for a person and not merged yet: it stays in the store.
    await decided("applied", 2, "2026-10-28T01:00:00Z", newPlace);
    // Withdrawn in the run that saw it.
    await decided("refused", 3, "2026-10-28T02:00:00Z", newPlace, "the person who added it withdrew it");
    // Published, then withdrawn in a later run.
    await decided("applied", 4, "2026-10-28T03:00:00Z", { type: "withdraw", place: placeOf(9) }, "new place withdrawn");
    // Too old to still be in the store.
    await decided("applied", 5, "2026-07-01T00:00:00Z", newPlace);
    await put(join(main, "places", placeOf(5).slice(-2).toLowerCase(), `${placeOf(5)}.json`), { id: placeOf(5) });

    const remove = vi.fn(async (_ids: readonly string[]) => {});
    const ids = await settleRecentPlaces({ inbox, main, store: { remove }, now: NOW });
    expect(ids).toEqual([placeOf(1), placeOf(3), placeOf(9)]);
    expect(remove).toHaveBeenCalledWith([placeOf(1), placeOf(3), placeOf(9)]);
  });

  it("calls nothing when there is nothing to remove", async () => {
    const remove = vi.fn(async (_ids: readonly string[]) => {});
    expect(await settleRecentPlaces({ inbox, main, store: { remove }, now: NOW })).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("intakeRecentStore", () => {
  it("posts the ids to the intake with the token, at most 500 at a time", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ removed: 1 }), { status: 200 }));
    const store = intakeRecentStore("https://intake.example.org/", "secret", fetch);
    const ids = Array.from({ length: 501 }, (_, n) => placeOf(n));
    await store.remove(ids);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://intake.example.org/v1/places/recent/remove");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(init.body as string).ids).toHaveLength(500);
    expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).ids).toEqual([placeOf(500)]);
  });

  it("throws when the intake refuses", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 }));
    await expect(intakeRecentStore("https://intake.example.org", "wrong", fetch).remove([placeOf(1)])).rejects.toThrow(/401/);
  });
});
