import { describe, expect, it } from "vitest";
import { MAX_PROOF_SECONDS, signContributorProof, verifyContributorProof } from "../src/index.js";

const NOW = Date.parse("2026-11-09T01:00:00Z");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const base64Url = (text: string) => base64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: base64(raw) };
}

const claims = (over: Record<string, unknown> = {}) => ({
  app: "example-app",
  contributor: CONTRIBUTOR,
  action: "photo_removal" as const,
  photo: PHOTO,
  issued: NOW / 1000,
  expires: NOW / 1000 + 600,
  ...over,
});

const expected = { app: "example-app", contributor: CONTRIBUTOR, action: "photo_removal" as const, photo: PHOTO, now: NOW };

describe("contributor proof (audit run-2 OCDB-NV-06)", () => {
  it("verifies a proof the app's server signed for this contributor, action and photo", async () => {
    const k = await keys();
    const proof = await signContributorProof(k.privateKey, claims());
    expect(await verifyContributorProof(k.publicKey, proof, expected)).toBe("ok");
  });

  it("verifies an erasure proof, which names no photo", async () => {
    const k = await keys();
    const proof = await signContributorProof(k.privateKey, claims({ action: "photo_erasure", photo: "*" }));
    expect(await verifyContributorProof(k.publicKey, proof, { ...expected, action: "photo_erasure", photo: "*" })).toBe("ok");
  });

  it("refuses a proof for another contributor, app, action or photo", async () => {
    const k = await keys();
    const proof = await signContributorProof(k.privateKey, claims());
    for (const other of [
      { contributor: "acct_someone_else_000" },
      { app: "other-app" },
      { action: "photo_erasure" as const, photo: "*" },
      { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZC" },
    ]) {
      expect(await verifyContributorProof(k.publicKey, proof, { ...expected, ...other })).toBe("invalid");
    }
  });

  it("refuses an expired proof, one issued in the future, and one that lives too long", async () => {
    const k = await keys();
    const late = { ...expected, now: NOW + 601_000 };
    expect(await verifyContributorProof(k.publicKey, await signContributorProof(k.privateKey, claims()), late)).toBe("invalid");
    const future = await signContributorProof(k.privateKey, claims({ issued: NOW / 1000 + 600, expires: NOW / 1000 + 900 }));
    expect(await verifyContributorProof(k.publicKey, future, expected)).toBe("invalid");
    const long = await signContributorProof(k.privateKey, claims({ expires: NOW / 1000 + MAX_PROOF_SECONDS + 1 }));
    expect(await verifyContributorProof(k.publicKey, long, expected)).toBe("invalid");
  });

  it("refuses a proof signed by another key, or changed after signing", async () => {
    const k = await keys();
    const other = await keys();
    const proof = await signContributorProof(other.privateKey, claims());
    expect(await verifyContributorProof(k.publicKey, proof, expected)).toBe("invalid");
    const good = await signContributorProof(k.privateKey, claims());
    const [, sig] = good.split(".");
    const forged = `${base64Url(JSON.stringify(claims({ contributor: "acct_someone_else_000" })))}.${sig}`;
    expect(await verifyContributorProof(k.publicKey, forged, { ...expected, contributor: "acct_someone_else_000" })).toBe("invalid");
    for (const junk of ["", "abc", "a.b.c", "!!.!!"]) expect(await verifyContributorProof(k.publicKey, junk, expected)).toBe("invalid");
  });
});
