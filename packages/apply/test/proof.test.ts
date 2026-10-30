import { describe, expect, it } from "vitest";
import { checkProof, isPrivateAddress, USER_AGENT, type Transport, type TransportResponse } from "../src/proof.js";

const NOW = () => new Date("2026-10-31T09:00:00Z");

function page(status: number, body = "", headers: Record<string, string> = {}): TransportResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers,
    body: (async function* () {
      // Two chunks, so the size cap is tested across chunks.
      yield bytes.slice(0, Math.floor(bytes.length / 2));
      yield bytes.slice(Math.floor(bytes.length / 2));
    })(),
  };
}

function transport(pages: Record<string, TransportResponse | Error>) {
  const seen: { url: string; headers: Record<string, string>; timeoutMs: number }[] = [];
  const t: Transport = async (url, options) => {
    seen.push({ url: url.href, headers: options.headers, timeoutMs: options.timeoutMs });
    const reply = pages[url.href];
    if (!reply) throw new Error(`no page for ${url.href}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { t, seen };
}

describe("checkProof", () => {
  it("finds the code on the page, ignoring case, and sends the Open Camping DB User-Agent", async () => {
    const { t, seen } = transport({ "https://farm.example/about": page(200, "<p>Listed on Open Camping DB: ocdb-7kq2</p>") });
    const result = await checkProof("https://farm.example/about", "OCDB-7KQ2", { transport: t, now: NOW });
    expect(result).toEqual({ found: true, checked: "2026-10-31T09:00:00Z", detail: "code found at https://farm.example/about" });
    expect(seen[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^OpenCampingDB\//);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("reports a page without the code", async () => {
    const { t } = transport({ "https://farm.example/about": page(200, "<p>Welcome to the farm</p>") });
    const result = await checkProof("https://farm.example/about", "OCDB-7KQ2", { transport: t, now: NOW });
    expect(result).toMatchObject({ found: false, detail: "code not found on the page" });
  });

  it("refuses an address that is not https before fetching it", async () => {
    const { t, seen } = transport({});
    const result = await checkProof("http://farm.example/about", "OCDB-7KQ2", { transport: t, now: NOW });
    expect(result).toMatchObject({ found: false, detail: expect.stringMatching(/https/) });
    expect(seen).toHaveLength(0);
  });

  it("follows a redirect to another https page", async () => {
    const { t } = transport({
      "https://farm.example/about": page(301, "", { location: "/about-us" }),
      "https://farm.example/about-us": page(200, "code OCDB-7KQ2"),
    });
    expect((await checkProof("https://farm.example/about", "OCDB-7KQ2", { transport: t, now: NOW })).found).toBe(true);
  });

  it.each(["https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "http://farm.example/x", "https://10.0.0.5/admin"])(
    "does not follow a redirect to %s",
    async (target) => {
      const { t, seen } = transport({ "https://farm.example/about": page(302, "", { location: target }) });
      const result = await checkProof("https://farm.example/about", "OCDB-7KQ2", { transport: t, now: NOW });
      expect(result.found).toBe(false);
      expect(result.detail).toMatch(/redirect/);
      expect(seen).toHaveLength(1);
    },
  );

  it("stops after three redirects", async () => {
    const { t } = transport({
      "https://a.example/1": page(302, "", { location: "https://a.example/2" }),
      "https://a.example/2": page(302, "", { location: "https://a.example/3" }),
      "https://a.example/3": page(302, "", { location: "https://a.example/4" }),
      "https://a.example/4": page(302, "", { location: "https://a.example/5" }),
    });
    const result = await checkProof("https://a.example/1", "OCDB-7KQ2", { transport: t, now: NOW });
    expect(result).toMatchObject({ found: false, detail: expect.stringMatching(/too many redirects/) });
  });

  it("reads no more than the size cap", async () => {
    const { t } = transport({ "https://farm.example/big": page(200, `${"x".repeat(2000)}OCDB-7KQ2`) });
    const result = await checkProof("https://farm.example/big", "OCDB-7KQ2", { transport: t, now: NOW, maxBytes: 1000 });
    expect(result.found).toBe(false);
  });

  it("reports an error status, a timeout or a refused address without throwing", async () => {
    const { t } = transport({
      "https://farm.example/gone": page(404),
      "https://farm.example/slow": Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
      "https://farm.example/inside": new Error("farm.example resolves to a private address"),
    });
    const at = (u: string) => checkProof(u, "OCDB-7KQ2", { transport: t, now: NOW });
    expect(await at("https://farm.example/gone")).toMatchObject({ found: false, detail: "the page answered 404" });
    expect(await at("https://farm.example/slow")).toMatchObject({ found: false, detail: expect.stringMatching(/timed out/) });
    expect(await at("https://farm.example/inside")).toMatchObject({ found: false, detail: expect.stringMatching(/private address/) });
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.150",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "203.0.113.9", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
