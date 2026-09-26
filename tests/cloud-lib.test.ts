import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkConnectRequest, pkcePair } from "../scripts/cloud-lib";


describe("本番接続の補助", () => {
  it("PKCEのchallengeはverifierのSHA-256をbase64urlにしたもの", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });
  it("接続ページはこのPCの同一オリジン・同じsだけを受け付ける", () => {
    const ok = { host: "127.0.0.1:53682", origin: "http://127.0.0.1:53682", method: "POST", path: "/start", s: "S" };
    expect(checkConnectRequest(ok, 53682, "S")).toBeNull();
    expect(checkConnectRequest({ ...ok, method: "GET", path: "/", origin: undefined }, 53682, "S")).toBeNull();
    expect(checkConnectRequest({ ...ok, method: "GET", path: "/", s: null }, 53682, "S")).toMatch(/URL/);
    expect(checkConnectRequest({ ...ok, origin: "https://evil.example" }, 53682, "S")).toMatch(/外部/);
    expect(checkConnectRequest({ ...ok, host: "evil.example" }, 53682, "S")).toMatch(/接続先/);
    expect(checkConnectRequest({ ...ok, s: "other" }, 53682, "S")).toMatch(/開き直/);
    expect(checkConnectRequest({ ...ok, method: "GET", path: "/save" }, 53682, "S")).toMatch(/外部/);
  });
});
