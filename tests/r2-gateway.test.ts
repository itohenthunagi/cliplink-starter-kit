import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R2Gateway } from "../src/server/r2-gateway";
import { FileStore, dropboxHash } from "../src/server/storage";
import { createRemoteStore, missingRemoteEnv } from "../src/server/remote-store";
import { Dropbox } from "../src/core/dropbox";
import { createWorker } from "../src/worker";
import { R2Blobs } from "../src/worker/r2";
import { MemoryRepository } from "../src/core/library";
import { versionSchema } from "../src/core/model";
import { FakeBucket } from "./helpers/fake-r2";

const token = "t".repeat(40);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7]);
const key = () => `assets/${crypto.randomUUID()}/original/${crypto.randomUUID()}.png`;

// 管理クライアントのfetchを、実際のWorker（偽のR2バケット付き）へつなぐ。
const connected = () => {
  const bucket = new FakeBucket();
  const app = createWorker(new MemoryRepository(), new R2Blobs(bucket.asBucket()), token, undefined, {
    bucket: bucket.asBucket(),
  });
  const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.origin).toBe("https://clips.example.pages.dev");
    return Promise.resolve(app.request(u.pathname, init));
  });
  return { bucket, gateway: new R2Gateway("https://clips.example.pages.dev/", token, fetcher as typeof fetch), fetcher };
};

describe("R2Gateway（管理クライアント → 共有ゲートウェイ → R2）", () => {
  it("SHA-256付きで送り、版のメタデータ（id=キー、rev=etag、contentHash）を返す", async () => {
    const { bucket, gateway, fetcher } = connected();
    const k = key();
    const meta = await gateway.upload(k, png, dropboxHash(png));
    expect(meta).toEqual({ id: k, rev: "etag-1", contentHash: dropboxHash(png) });
    expect(bucket.objects.get(k)?.bytes).toEqual(png);
    const init = fetcher.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("PUT");
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["x-content-sha256"]).toBe(createHash("sha256").update(png).digest("hex"));
  });

  it("FileStoreはR2では版の相対パスをそのままキーにし、別端末で同じ実体を取り出せる", async () => {
    const { bucket, gateway } = connected();
    const first = new FileStore(await mkdtemp(join(tmpdir(), "cliplink-r2-a-")), gateway);
    const second = new FileStore(await mkdtemp(join(tmpdir(), "cliplink-r2-b-")), gateway);
    expect(first.provider).toBe("r2");
    const version = await first.put(crypto.randomUUID(), "original", png, "image/png");
    expect(version.dropbox!.id).toBe(version.relativePath);
    expect(bucket.objects.has(version.relativePath)).toBe(true);
    expect(versionSchema.parse(version)).toEqual(version);
    const path = await second.materialize(version);
    expect(new Uint8Array(await readFile(path))).toEqual(png);
    const partial = await gateway.download(version, "bytes=1-2");
    expect(partial.status).toBe(206);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(png.subarray(1, 3));
  });

  it("上書きの拒否は409、通信失敗・不正な応答・不正なキーは例外にする", async () => {
    const { gateway } = connected();
    const k = key();
    await gateway.upload(k, png, dropboxHash(png));
    await expect(gateway.upload(k, new Uint8Array([...png, 1]), "x")).rejects.toMatchObject({ status: 409 });
    await expect(gateway.upload("assets/../x.png", png, dropboxHash(png))).rejects.toMatchObject({ status: 400 });
    const offline = new R2Gateway("https://g.example", token, (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await expect(offline.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({ status: 503 });
    const lying = new R2Gateway("https://g.example", token, (async () =>
      Response.json({ id: "assets/other.png", rev: "e", size: png.length })) as typeof fetch);
    await expect(lying.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({ status: 503 });
  });
});

describe("外部保管先の工場関数", () => {
  it("保管先の名前から保管器を作り、R2ではDropboxのキーを求めない", () => {
    const base = { gateway: "https://g.example", adminToken: token };
    expect(createRemoteStore("r2", { ...base, env: {} })).toBeInstanceOf(R2Gateway);
    expect(
      createRemoteStore("dropbox", { ...base, env: { DROPBOX_APP_KEY: "k", DROPBOX_REFRESH_TOKEN: "r" } }),
    ).toBeInstanceOf(Dropbox);
    expect(missingRemoteEnv("r2", {})).toEqual([]);
    expect(missingRemoteEnv("dropbox", { DROPBOX_APP_KEY: "k" })).toEqual(["DROPBOX_REFRESH_TOKEN"]);
  });
});
