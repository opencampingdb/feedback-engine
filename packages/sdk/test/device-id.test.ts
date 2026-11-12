// The deviceId option: a caller's own device id, used in place of the stored one and never stored.
import { describe, expect, it } from "vitest";
import { createFeedbackClient, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "2f6c1b9e-4a7d-4c3e-9b8a-1d2e3f4a5b6c";

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
  return { storage, data };
}

function setup(extra: { deviceId?: string; stored?: string } = {}) {
  const { storage, data } = memoryStorage();
  if (extra.stored) data.set("ocdb.feedback.device", extra.stored);
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { status: 202, json: async () => ({ id: "fb_01JBXK3M8Q4R5S6T7V8W9X0Y01" }), headers: { get: () => null } };
  };
  const client = createFeedbackClient({
    endpoint: "https://intake.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage,
    fetch,
    ...(extra.deviceId !== undefined ? { deviceId: extra.deviceId } : {}),
  });
  return { client, data, bodies };
}

const closed = { place: PLACE, report: { kind: "closed" as const }, consent: true as const };

describe("deviceId", () => {
  it("sends the given device id and never stores one", async () => {
    const { client, data, bodies } = setup({ deviceId: DEVICE });
    await client.report(closed);
    expect(bodies[0]!.device).toBe(DEVICE);
    expect(data.has("ocdb.feedback.device")).toBe(false);
  });

  it("wins over a stored device id and leaves it as it was", async () => {
    const stored = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const { client, data, bodies } = setup({ deviceId: DEVICE, stored });
    await client.report(closed);
    expect(bodies[0]!.device).toBe(DEVICE);
    expect(data.get("ocdb.feedback.device")).toBe(stored);
  });

  it("without it, makes and keeps a device id as before", async () => {
    const { client, data, bodies } = setup();
    await client.report(closed);
    expect(bodies[0]!.device).toBe(data.get("ocdb.feedback.device"));
  });

  it("refuses a device id that is not a UUID", () => {
    expect(() => setup({ deviceId: "phone-1" })).toThrow(/deviceId must be a UUID/);
  });
});
