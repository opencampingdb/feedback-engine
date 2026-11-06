import { describe, expect, it } from "vitest";
import { withRequestLog, type RequestLine } from "../src/requestlog.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function logged(request: Request, answer: () => Promise<Response>) {
  const lines: RequestLine[] = [];
  let t = 1000;
  const response = await withRequestLog(request, answer, (line) => lines.push(line), () => (t += 5));
  return { response, lines };
}

describe("withRequestLog", () => {
  it("logs method, path, status and time, and never the query string, body or other headers", async () => {
    const request = new Request("https://intake.example/v1/feedback?secret=1", {
      method: "POST",
      headers: { "x-app-key": "app-key-value", "x-attest-platform": "ios", "x-attest-assertion": "assertion-value" },
      body: JSON.stringify({ report: { name: "A private name" } }),
    });
    const { response, lines } = await logged(request, async () => json(202, { id: "fb_1" }));
    expect(response.status).toBe(202);
    expect(lines).toEqual([{ method: "POST", path: "/v1/feedback", status: 202, platform: "ios", ms: 5 }]);
    const text = JSON.stringify(lines);
    for (const secret of ["secret", "app-key-value", "assertion-value", "A private name", "fb_1"]) expect(text).not.toContain(secret);
  });

  it("adds the refusal code from a JSON error answer and leaves the answer readable", async () => {
    const { response, lines } = await logged(new Request("https://intake.example/v1/feedback", { method: "POST" }), async () =>
      json(400, { error: "invalid", details: ["report.name is required"] }),
    );
    expect(lines[0]).toMatchObject({ status: 400, error: "invalid" });
    expect(lines[0]).not.toHaveProperty("details");
    expect(await response.json()).toEqual({ error: "invalid", details: ["report.name is required"] });
  });

  it("drops an unknown platform and an error field that is not a plain code", async () => {
    const request = new Request("https://intake.example/v1/feedback", { method: "POST", headers: { "x-attest-platform": "<script>" } });
    const { lines } = await logged(request, async () => json(500, { error: "Something with spaces" }));
    expect(lines).toEqual([{ method: "POST", path: "/v1/feedback", status: 500, ms: 5 }]);
  });

  it("logs a thrown error as a 500 and throws it again", async () => {
    const lines: RequestLine[] = [];
    await expect(
      withRequestLog(new Request("https://intake.example/v1/places/recent"), async () => Promise.reject(new Error("boom")), (line) => lines.push(line), () => 0),
    ).rejects.toThrow("boom");
    expect(lines).toEqual([{ method: "GET", path: "/v1/places/recent", status: 500, error: "exception", ms: 0 }]);
  });
});
