import type { RecentList } from "@opencampingdb/feedback";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createHandler, type Env } from "../src/index.js";
import { latestRelease } from "../src/release.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const TOKEN = "places-token-for-the-apply-run";

function env(): Env {
  return {
    APP_KEYS: "{}",
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: "unused",
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    RECENT_LIST: fakeD1(),
    PLACES_TOKEN: TOKEN,
  };
}

const announce = (body: unknown, token: string | null = TOKEN) =>
  new Request("https://intake.example/v1/release", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("the newest release", () => {
  let clock = NOW;
  const handle = createHandler({ fetch: async () => new Response("", { status: 404 }), now: () => clock });
  const recent = async (e: Env) => (await (await handle(new Request("https://intake.example/v1/places/recent"), e)).json()) as Record<string, unknown>;

  it("is on the recent list once the data release has announced it", async () => {
    const e = env();
    expect(await recent(e)).not.toHaveProperty("release");
    const res = await handle(announce({ data_version: "20261107T110000Z-abc1234" }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ release: { data_version: "20261107T110000Z-abc1234", published: "2026-11-07T12:00:00Z" } });
    expect((await recent(e)).release).toEqual({ data_version: "20261107T110000Z-abc1234", published: "2026-11-07T12:00:00Z" });
  });

  it("keeps a layout version when the release sends one, and never goes back to an older release", async () => {
    const e = env();
    clock = NOW;
    await handle(announce({ data_version: "20261107T110000Z-abc1234", layout_version: 2 }), e);
    clock += 60_000;
    const older = await handle(announce({ data_version: "20261107T100000Z-0000aaa" }), e);
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ release: { data_version: "20261107T110000Z-abc1234", published: "2026-11-07T12:00:00Z", layout_version: 2 } });
    // The same release announced again keeps its first time.
    await handle(announce({ data_version: "20261107T110000Z-abc1234", layout_version: 2 }), e);
    expect((await recent(e)).release).toEqual({ data_version: "20261107T110000Z-abc1234", published: "2026-11-07T12:00:00Z", layout_version: 2 });
    await handle(announce({ data_version: "20261107T120000Z-def5678" }), e);
    expect((await recent(e)).release).toEqual({ data_version: "20261107T120000Z-def5678", published: "2026-11-07T12:01:00Z" });
  });

  it("refuses a release dated more than 7 days ahead of its clock, and keeps the one it has", async () => {
    const e = env();
    clock = NOW;
    await handle(announce({ data_version: "20261107T110000Z-abc1234" }), e);
    for (const ahead of ["20261114T120001Z-def5678", "20991231T000000Z-fffffff"]) {
      expect((await handle(announce({ data_version: ahead }), e)).status).toBe(400);
    }
    expect((await handle(announce({ data_version: "20261114T115959Z-def5678" }), e)).status).toBe(200);
    expect((await recent(e)).release).toEqual({ data_version: "20261114T115959Z-def5678", published: "2026-11-07T12:00:00Z" });
  });

  it("serves the release as the SDK's recent list types it", () => {
    expectTypeOf<NonNullable<Awaited<ReturnType<typeof latestRelease>>>>().toEqualTypeOf<NonNullable<RecentList["release"]>>();
  });

  it("refuses an announcement without the places token, or one it cannot read", async () => {
    const e = env();
    expect((await handle(announce({ data_version: "20261107T110000Z-abc1234" }, null), e)).status).toBe(401);
    expect((await handle(announce({ data_version: "20261107T110000Z-abc1234" }, "wrong"), e)).status).toBe(401);
    expect(await recent(e)).not.toHaveProperty("release");
    for (const body of [{}, { data_version: "latest" }, { data_version: "20261107T110000Z" }, { data_version: "20261107T110000Z-ABC1234" }, { data_version: "20261107T110000Z-abc1234 x" }, { data_version: "20261340T110000Z-abc1234" }, { data_version: "20261107T110000Z-abc1234", layout_version: 0 }, { data_version: "20261107T110000Z-abc1234", layout_version: "2" }]) {
      expect((await handle(announce(body), e)).status).toBe(400);
    }
    expect((await handle(new Request("https://intake.example/v1/release"), e)).status).toBe(405);
    const { PLACES_TOKEN: _, ...without } = e;
    expect((await handle(announce({ data_version: "20261107T110000Z-abc1234" }), without)).status).toBe(404);
  });
});
