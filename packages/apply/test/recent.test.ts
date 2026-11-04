import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intakeRecentList, intakeRecentStore, sendBlockList, settleRecentPlaces } from "../src/recent.js";

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
    const ids = await settleRecentPlaces({ inbox, main, store: { remove, block: async () => {} }, now: NOW });
    expect(ids).toEqual([placeOf(1), placeOf(3), placeOf(9)]);
    expect(remove).toHaveBeenCalledWith([placeOf(1), placeOf(3), placeOf(9)]);
  });

  it("calls nothing when there is nothing to remove", async () => {
    const remove = vi.fn(async (_ids: readonly string[]) => {});
    expect(await settleRecentPlaces({ inbox, main, store: { remove, block: async () => {} }, now: NOW })).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("sendBlockList", () => {
  it("sends every blocked contributor on main, so the intake keeps their places off the list", async () => {
    await put(join(main, "moderation", "blocked_contributors.json"), {
      contributors: [
        { contributor: "ctr_00000000000000b2", added: "2026-10-01", reason: "spam" },
        { contributor: "ctr_00000000000000a1", added: "2026-10-02", reason: "fake places" },
      ],
    });
    const block = vi.fn(async (_contributors: readonly string[]) => {});
    expect(await sendBlockList({ main, store: { remove: async () => {}, block } })).toEqual(["ctr_00000000000000a1", "ctr_00000000000000b2"]);
    expect(block).toHaveBeenCalledWith(["ctr_00000000000000a1", "ctr_00000000000000b2"]);
  });

  it("sends an empty list when nobody is blocked, so anyone unblocked is listed again", async () => {
    const block = vi.fn(async (_contributors: readonly string[]) => {});
    expect(await sendBlockList({ main, store: { remove: async () => {}, block } })).toEqual([]);
    expect(block).toHaveBeenCalledWith([]);
  });
});

describe("intakeRecentStore", () => {
  it("posts the whole block list to the intake with the token", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ blocked: 1 }), { status: 200 }));
    await intakeRecentStore("https://intake.example.org/", "secret", fetch).block(["ctr_00000000000000a1"]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://intake.example.org/v1/places/recent/block");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(init.body as string)).toEqual({ contributors: ["ctr_00000000000000a1"] });
  });

  it("throws when the block list is refused", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "invalid" }), { status: 400 }));
    await expect(intakeRecentStore("https://intake.example.org", "secret", fetch).block(["nope"])).rejects.toThrow(/400/);
  });

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

describe("intakeRecentList", () => {
  const answer = (status: number, body: unknown) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it("reads the ids of the places on the intake's recent list, with no token", async () => {
    const fetcher = answer(200, { places: [{ id: placeOf(1), standing: "shown" }, { id: placeOf(2), standing: "confirmed" }] });
    const ids = await intakeRecentList("https://intake.example.org", fetcher as unknown as typeof fetch).ids();
    expect([...ids].sort()).toEqual([placeOf(1), placeOf(2)]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://intake.example.org/v1/places/recent");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("throws when the intake answers with an error", async () => {
    const list = intakeRecentList("https://intake.example.org", answer(503, { error: "down" }) as unknown as typeof fetch);
    await expect(list.ids()).rejects.toThrow(/503/);
  });

  it("throws when the answer is not a list of places", async () => {
    const list = intakeRecentList("https://intake.example.org", answer(200, { nope: true }) as unknown as typeof fetch);
    await expect(list.ids()).rejects.toThrow();
  });
});
