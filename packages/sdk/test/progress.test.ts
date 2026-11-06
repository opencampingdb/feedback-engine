import { describe, expect, it } from "vitest";
import {
  createFeedbackClient,
  PROGRESS_STATES,
  ProgressRequestError,
  progressInRelease,
  type FetchLike,
  type Progress,
  type StorageAdapter,
} from "../src/index.js";

const storage: StorageAdapter = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
const fbId = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;

type Reply = "network" | { status: number; body?: unknown } | ((ids: string[]) => { status: number; body?: unknown });

/** The intake's GET /v1/feedback/progress: `known` answers each id it holds, others come back unknown. */
function client(replies: Reply[]) {
  const calls: { url: string; method: string; body: unknown; ids: string[] }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
    calls.push({ url, method: init.method, body: init.body, ids });
    const reply = replies[Math.min(n++, replies.length - 1)]!;
    if (reply === "network") throw new TypeError("Network request failed");
    const { status, body } = typeof reply === "function" ? reply(ids) : reply;
    return { status, json: async () => body, headers: { get: () => null } };
  };
  return { feedback: createFeedbackClient({ endpoint: "https://intake.example/", appKey: "key-1", appVersion: "1.0.0", storage, fetch }), calls };
}

/** Answers every id as accepted, in reverse order, as an intake may. */
const acceptedAll = (ids: string[]) => ({ status: 200, body: { items: [...ids].reverse().map((id) => ({ id, state: "accepted", decided_at: "2026-11-03T09:00:00Z" })) } });

describe("progress", () => {
  it("lists every state", () => {
    expect(PROGRESS_STATES).toEqual(["received", "live", "waiting", "accepted", "held", "refused", "in_data", "unknown"]);
  });

  it("asks the public GET with no body and no app key, and answers each id with what the intake keeps", async () => {
    const { feedback, calls } = client([
      {
        status: 200,
        body: {
          items: [
            { id: fbId(1), state: "refused", reason: "names are checked by a person", by: "reviewer", place: "ocdb_01JB0000000000000000000001", received: "2026-11-01T00:00:00Z", decided_at: "2026-11-02T00:00:00Z" },
            { id: fbId(2), state: "received", held_reason: "not_attested", received: "2026-11-01T00:00:00Z" },
          ],
        },
      },
    ]);
    expect(await feedback.progress([fbId(1), fbId(2)])).toEqual([
      { id: fbId(1), state: "refused", reason: "names are checked by a person", by: "reviewer", place: "ocdb_01JB0000000000000000000001", received: "2026-11-01T00:00:00Z", decided_at: "2026-11-02T00:00:00Z" },
      { id: fbId(2), state: "received", held_reason: "not_attested", received: "2026-11-01T00:00:00Z" },
    ]);
    expect(calls).toEqual([{ url: `https://intake.example/v1/feedback/progress?ids=${fbId(1)},${fbId(2)}`, method: "GET", body: undefined, ids: [fbId(1), fbId(2)] }]);
  });

  it("keeps the order given across calls of 100 ids", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => fbId(250 - i));
    const { feedback, calls } = client([acceptedAll]);
    const answer = await feedback.progress(ids);
    expect(calls.map((c) => c.ids.length)).toEqual([100, 100, 50]);
    expect(answer.map((p) => p.id)).toEqual(ids);
    expect(answer.every((p) => p.state === "accepted")).toBe(true);
  });

  it("answers unknown for ids the intake does not know, ids that are not feedback ids, and states this SDK does not know", async () => {
    const { feedback, calls } = client([
      { status: 200, body: { items: [{ id: fbId(1), state: "unknown" }, { id: fbId(2), state: "teleported", reason: "x" }, { id: fbId(3), state: "held", held_reason: "a_new_code" }] } },
    ]);
    expect(await feedback.progress([fbId(1), "pho_01JC0000000000000000000001", fbId(2), fbId(3), fbId(4)])).toEqual([
      { id: fbId(1), state: "unknown" },
      { id: "pho_01JC0000000000000000000001", state: "unknown" },
      { id: fbId(2), state: "unknown" },
      { id: fbId(3), state: "held" },
      { id: fbId(4), state: "unknown" },
    ]);
    // Only feedback ids are asked for, each once.
    expect(calls[0]!.ids).toEqual([fbId(1), fbId(2), fbId(3), fbId(4)]);
  });

  it("asks nothing for no ids", async () => {
    const { feedback, calls } = client([acceptedAll]);
    expect(await feedback.progress([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("throws with httpStatus 0 when the intake cannot be reached, and with the HTTP code when it refuses", async () => {
    const offline = client(["network"]).feedback;
    await expect(offline.progress([fbId(1)])).rejects.toMatchObject({ name: "ProgressRequestError", httpStatus: 0 });
    const refused = client([{ status: 400, body: { error: "invalid" } }]).feedback;
    const error = await refused.progress([fbId(1)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProgressRequestError);
    expect(error).toMatchObject({ httpStatus: 400 });
    const garbled = client([{ status: 200, body: { nothing: true } }]).feedback;
    await expect(garbled.progress([fbId(1)])).rejects.toMatchObject({ httpStatus: 200 });
  });
});

describe("progressInRelease", () => {
  const inData = (at: string): Progress => ({ id: fbId(1), state: "in_data", in_data_at: at });

  it("is true when the change was in the data by the release's commit time", () => {
    expect(progressInRelease(inData("2026-11-03T08:59:59Z"), "20261103T090000Z-abc1234")).toBe(true);
    expect(progressInRelease(inData("2026-11-03T09:00:01Z"), "20261103T090000Z-abc1234")).toBe(false);
  });

  it("is true for a release built from the commit that brought the change in", () => {
    // in_data_at is that commit's time, and the release's data_version starts with it.
    expect(progressInRelease(inData("2026-11-03T09:00:00Z"), "20261103T090000Z-abc1234")).toBe(true);
  });

  it("is false for any other state, and for a version it cannot read", () => {
    expect(progressInRelease({ id: fbId(1), state: "accepted" }, "20261103T090000Z-abc1234")).toBe(false);
    expect(progressInRelease(inData("2026-11-01T00:00:00Z"), "latest")).toBe(false);
  });
});
