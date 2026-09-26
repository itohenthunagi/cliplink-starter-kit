import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleDrive, RECONNECT_MESSAGE, contentHashOf } from "../src/core/gdrive";
import { FileStore, dropboxHash } from "../src/server/storage";
import { createRemoteStore, missingRemoteEnv } from "../src/server/remote-store";
import { versionSchema, type Version } from "../src/core/model";
import { FakeGoogleDrive } from "./helpers/fake-gdrive";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 3, 1, 4, 1, 5, 9, 2, 6]);
const creds = { clientId: "id.apps.googleusercontent.com", clientSecret: "secret-value", refreshToken: "refresh", folderId: "folder-0000001" };
const key = () => `assets/${crypto.randomUUID()}/original/${crypto.randomUUID()}.png`;
const setup = () => {
  const fake = new FakeGoogleDrive();
  return { fake, drive: new GoogleDrive(creds, fake.fetch) };
};
const versionFor = (meta: NonNullable<Version["dropbox"]>, relativePath: string, bytes = png): Version => ({
  id: crypto.randomUUID(),
  kind: "original",
  relativePath,
  mime: "image/png",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  createdAt: new Date().toISOString(),
  createdBy: "user",
  dropbox: meta,
});

describe("GoogleDrive（Googleドライブの保管器）", () => {
  it("Web Cryptoで求めた内容ハッシュはDropbox算法（dropboxHash）と一致する", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 10).map((_, i) => i % 251);
    for (const b of [png, big]) expect(await contentHashOf(b)).toBe(dropboxHash(b));
  });

  it("トークンを更新し、再開可能アップロードでフォルダ・名前・appPropertiesを付けて保存する", async () => {
    const { fake, drive } = setup();
    const k = key();
    const meta = await drive.upload(k, png, dropboxHash(png));
    expect(meta.id).toMatch(/^gdrive:file\d{12}$/);
    expect(meta).toMatchObject({ rev: "1", contentHash: dropboxHash(png) });
    expect(versionSchema.parse(versionFor(meta, k)).dropbox).toEqual(meta);

    const token = fake.calls[0];
    expect(token.url).toBe("https://oauth2.googleapis.com/token");
    const form = token.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    const start = fake.calls[1];
    expect(start.method).toBe("POST");
    expect(start.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,sha256Checksum,version",
    );
    expect(start.headers["X-Upload-Content-Type"]).toBe("image/png");
    expect(JSON.parse(String(start.body))).toEqual({
      name: k.replaceAll("/", "__"),
      parents: [creds.folderId],
      appProperties: { cliplinkKey: k },
      mimeType: "image/png",
    });
    expect(fake.calls[2].method).toBe("PUT");
    const saved = fake.files.get(meta.id.slice("gdrive:".length))!;
    expect(saved.bytes).toEqual(png);

    // トークンは期限内なら使い回す。
    await drive.upload(key(), png, dropboxHash(png));
    expect(fake.count((c) => c.url.includes("oauth2"))).toBe(1);
  });

  it("Googleが返したSHA-256が送った内容と違えば保存済みとして扱わない", async () => {
    const { fake, drive } = setup();
    fake.checksumOverride = "0".repeat(64);
    await expect(drive.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({
      status: 503,
      message: "Googleドライブのファイル整合確認に失敗しました。",
    });
    // 呼び出し側の期待ハッシュと違う内容は送らない。
    const before = fake.calls.length;
    await expect(drive.upload(key(), png, "f".repeat(64))).rejects.toMatchObject({ status: 503 });
    expect(fake.calls.length).toBe(before);
    await expect(drive.upload("assets/../x.png", png, dropboxHash(png))).rejects.toMatchObject({ status: 400 });
  });

  it("GoogleがSHA-256を返さない時は、保存した中身を読み戻して照合する", async () => {
    const { fake, drive } = setup();
    fake.omitChecksum = true;
    const meta = await drive.upload(key(), png, dropboxHash(png));
    expect(meta.id).toMatch(/^gdrive:/);
    expect(fake.count((c) => c.url.includes("alt=media"))).toBe(1);
  });

  it("Range付きの取得は206で、Content-Type・Content-Range・Content-Lengthだけを返す", async () => {
    const { fake, drive } = setup();
    const k = key();
    const v = versionFor(await drive.upload(k, png, dropboxHash(png)), k);
    const part = await drive.download(v, "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 2-5/${png.length}`);
    expect(part.headers.get("Content-Length")).toBe("4");
    expect(part.headers.get("Content-Type")).toBe("image/png");
    expect(part.headers.get("X-GUploader-UploadID")).toBeNull();
    expect(part.headers.get("Content-Disposition")).toBeNull();
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.subarray(2, 6));
    const get = fake.calls.at(-1)!;
    expect(get.url).toBe(`https://www.googleapis.com/drive/v3/files/${v.dropbox!.id.slice(7)}?alt=media`);
    expect(get.headers.Range).toBe("bytes=2-5");

    const whole = await drive.download(v);
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(png);
    const bad = await drive.download(v, "bytes=99-");
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${png.length}`);
    await expect(drive.download(v, "items=0-1")).rejects.toMatchObject({ status: 416 });
    const missing = versionFor({ ...v.dropbox!, id: "gdrive:missing000000" }, k);
    await expect(drive.download(missing)).rejects.toMatchObject({ status: 503 });
    await expect(drive.download(versionFor({ ...v.dropbox!, id: "id:dropbox" }, k))).rejects.toMatchObject({ status: 503 });
  });

  it("refresh tokenが失効（invalid_grant）したら、setup:googleのやり直しを案内する", async () => {
    const { fake, drive } = setup();
    fake.tokenError = "invalid_grant";
    await expect(drive.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({ status: 503, message: RECONNECT_MESSAGE });
    expect(RECONNECT_MESSAGE).toContain("npm run setup:google");
    expect(RECONNECT_MESSAGE).toContain("7日");
    fake.tokenError = "invalid_client";
    await expect(drive.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({ status: 503 });
    await expect(drive.upload(key(), png, dropboxHash(png))).rejects.not.toMatchObject({ message: RECONNECT_MESSAGE });
    const offline = new GoogleDrive(creds, (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await expect(offline.upload(key(), png, dropboxHash(png))).rejects.toMatchObject({ status: 503 });
  });

  it("verifyは存在・大きさ・SHA-256・ごみ箱でないことを確かめる", async () => {
    const { fake, drive } = setup();
    const k = key();
    const v = versionFor(await drive.upload(k, png, dropboxHash(png)), k);
    await expect(drive.verify(v)).resolves.toBeUndefined();
    await expect(drive.verify({ ...v, size: v.size + 1 })).rejects.toThrow();
    await expect(drive.verify({ ...v, sha256: "c".repeat(64) })).rejects.toThrow();
    await expect(drive.verify(versionFor({ ...v.dropbox!, id: "id:dropbox" }, k))).rejects.toThrow("保管先の種類");
    fake.files.get(v.dropbox!.id.slice(7))!.trashed = true;
    await expect(drive.verify(v)).rejects.toThrow("Googleドライブ保存未完了");
  });

  it("FileStore経由で保存し、別端末（ローカルに無い）でも同じ実体を取り出せる", async () => {
    const { drive } = setup();
    const first = new FileStore(await mkdtemp(join(tmpdir(), "cliplink-gd-a-")), drive);
    const second = new FileStore(await mkdtemp(join(tmpdir(), "cliplink-gd-b-")), drive);
    expect(first.provider).toBe("gdrive");
    const version = await first.put(crypto.randomUUID(), "original", png, "image/png");
    expect(version.dropbox!.id.startsWith("gdrive:")).toBe(true);
    expect(versionSchema.parse(version)).toEqual(version);
    expect(new Uint8Array(await readFile(await second.materialize(version)))).toEqual(png);
  });

  it("工場関数と必要な.envのキー", () => {
    expect(missingRemoteEnv("gdrive", { GOOGLE_CLIENT_ID: "x" })).toEqual([
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN",
      "GOOGLE_DRIVE_FOLDER_ID",
    ]);
    const store = createRemoteStore("gdrive", { gateway: "https://g.example", adminToken: "t", env: {} });
    expect(store.provider).toBe("gdrive");
    expect(store.keyFor?.("assets/a/original/b.png")).toBe("assets/a/original/b.png");
  });
});
