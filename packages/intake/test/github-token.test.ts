import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApp, type GitHubAppConfig } from "../src/github.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = Date.parse("2026-11-07T09:00:00Z");
const config = (repo: string): GitHubAppConfig => ({ appId: "1", privateKeyPem: privateKey, installationId: "2", repo });

function fakeGitHub() {
  const asked: unknown[] = [];
  let n = 0;
  const fetch = async (_url: string, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ token: `ghs_${++n}`, expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
  };
  return { fetch, asked };
}

describe("GitHubApp.token", () => {
  it("uses a token held for the repository again when it covers the permissions asked for", async () => {
    const gh = fakeGitHub();
    const app = new GitHubApp(gh.fetch, () => NOW);
    const broad = await app.token(config("o/data"), { contents: "write", pull_requests: "write" });
    expect(await app.token(config("o/data"), { contents: "write" })).toBe(broad);
    expect(await app.token(config("o/data"), { pull_requests: "read" })).toBe(broad);
    expect(gh.asked).toHaveLength(1);
  });

  it("asks again for permissions the token held does not cover, another repository, or one near its expiry", async () => {
    const gh = fakeGitHub();
    let clock = NOW;
    const app = new GitHubApp(gh.fetch, () => clock);
    const narrow = await app.token(config("o/data"), { contents: "read" });
    expect(await app.token(config("o/data"), { contents: "write" })).not.toBe(narrow);
    expect(await app.token(config("o/inbox"), { contents: "read" })).not.toBe(narrow);
    expect(gh.asked).toHaveLength(3);
    clock = NOW + 3_600_000 - 60_000;
    await app.token(config("o/data"), { contents: "read" });
    expect(gh.asked).toHaveLength(4);
  });
});
