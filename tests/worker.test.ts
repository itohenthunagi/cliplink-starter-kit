import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import worker, { createWorker, type Env } from "../src/worker";
import { R2Blobs } from "../src/worker/r2";
import { FakeBucket } from "./helpers/fake-r2";
import { FakeGoogleDrive } from "./helpers/fake-gdrive";
import { GoogleDrive } from "../src/core/gdrive";
import { createWorkerStorage } from "../src/worker/storage";
import { dropboxHash } from "../src/server/storage";
import { MemoryRepository, Library } from "../src/core/library";
import { Dropbox } from "../src/core/dropbox";
import type { Version } from "../src/core/model";
const v = (kind: Version["kind"]): Version => ({
  id: crypto.randomUUID(),
  kind,
  relativePath: `assets/${crypto.randomUUID()}/${kind}/${crypto.randomUUID()}.png`,
  mime: "image/png",
  size: 10,
  sha256: "a".repeat(64),
  createdAt: new Date().toISOString(),
  createdBy: "user",
  dropbox: { id: "id:stable", rev: "r1", contentHash: "b".repeat(64) },
});
describe("共有ゲートウェイとDropbox契約", () => {
  it("管理APIの認証、公開中の版だけを中継、停止後はDropboxも呼ばない", async () => {
    const repo = new MemoryRepository();
    const lib = new Library(repo);
    let a = await lib.createAsset({
      title: "公開画像",
      version: v("original"),
    });
    a = await lib.publish(a.id, a.revision, v("published"));
    const download = vi.fn(
      async () =>
        new Response("image", {
          headers: {
            "Dropbox-API-Result": "private-metadata",
            "Content-Length": "5",
          },
        }),
    );
    const app = createWorker(repo, { download }, "x".repeat(40));
    expect((await app.request("/internal/entities")).status).toBe(401);
    const content = await app.request(`/s/${a.slug}/media/${a.id}`);
    expect(content.status).toBe(200);
    expect(content.headers.get("Dropbox-API-Result")).toBeNull();
    expect(download.mock.calls).toHaveLength(1);
    await lib.revoke(a.id, a.revision);
    expect((await app.request(`/s/${a.slug}/media/${a.id}`)).status).toBe(404);
    expect(download.mock.calls).toHaveLength(1);
    expect(
      (
        await app.request("/internal/entities", {
          headers: { Authorization: "Bearer " + "x".repeat(40) },
        })
      ).status,
    ).toBe(200);
  });
  it("Dropbox保存前の公開、過去版の改変、競合更新を拒否する", async () => {
    const repo = new MemoryRepository();
    const lib = new Library(repo);
    const a = await lib.createAsset({ title: "原本", version: v("original") });
    const app = createWorker(
      repo,
      { download: async () => new Response() },
      "x".repeat(40),
    );
    const send = (entity: unknown, expected: number) =>
      app.request(`/internal/entities/${a.id}`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + "x".repeat(40),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity, expected }),
      });
    const changed = structuredClone(a);
    changed.revision = 2;
    changed.versions[0].sha256 = "c".repeat(64);
    expect((await send(changed, 1)).status).toBe(400);
    const missing = structuredClone(a);
    missing.revision = 2;
    delete missing.versions[0].dropbox;
    expect((await send(missing, 1)).status).toBe(400);
    expect((await send({ ...a, revision: 2, title: "更新" }, 1)).status).toBe(
      200,
    );
    expect(
      (await send({ ...a, revision: 2, title: "古い画面" }, 1)).status,
    ).toBe(409);
  });
  it("トークンを更新し、移動に強いfile id + revとRangeで取得する", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return String(url).includes("oauth2")
          ? Response.json({ access_token: "test-access", expires_in: 3600 })
          : new Response("abc", {
              status: 206,
              headers: { "Content-Range": "bytes 0-2/10" },
            });
      },
    );
    const dropbox = new Dropbox(
      { appKey: "app", refreshToken: "refresh" },
      fetcher as typeof fetch,
    );
    const version = v("published");
    const response = await dropbox.download(version, "bytes=0-2");
    expect(response.status).toBe(206);
    const headers = calls[1].init.headers as Record<string, string>;
    // Dropboxは別フィールドのrevを廃止し400を返す（2026-09-25 本番で確認）。pathの "rev:" 形式だけを送る。
    expect(JSON.parse(headers["Dropbox-API-Arg"])).toEqual({ path: "rev:r1" });
    expect(headers.Range).toBe("bytes=0-2");
    await dropbox.download(version);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });
  it("既定のfetchはthisを付けずに呼ぶ（Workersは別のthisでの呼び出しをIllegal invocationで拒否する）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function (this: unknown, url: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Illegal invocation");
      return Promise.resolve(
        String(url).includes("oauth2")
          ? Response.json({ access_token: "test", expires_in: 3600 })
          : new Response("abc"),
      );
    } as typeof fetch;
    try {
      const dropbox = new Dropbox({ appKey: "app", refreshToken: "refresh" });
      expect((await dropbox.download(v("published"))).status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("APP_NAME相当の引数を公開ページのtitle・見出し・ダウンロードファイル名に反映する", async () => {
    const repo = new MemoryRepository();
    const lib = new Library(repo);
    let a = await lib.createAsset({ title: "ブランド画像", version: v("original") });
    a = await lib.publish(a.id, a.revision, v("published"));
    const download = vi.fn(
      async () => new Response("image", { headers: { "Content-Length": "5" } }),
    );
    const app = createWorker(repo, { download }, "x".repeat(40), "MyBrand");
    const html = await (await app.request(`/s/${a.slug}`)).text();
    expect(html).toContain("<title>ブランド画像 · MyBrand</title>");
    expect(html).toContain("<small>MyBrand</small>");
    const media = await app.request(`/s/${a.slug}/media/${a.id}?download=1`);
    expect(media.headers.get("Content-Disposition")).toContain(
      `filename="mybrand-${a.id}`,
    );
  });
  it("Dropbox同期クライアントとの同時保存は一致するhashだけ受け入れる", async () => {
    let hash = "b".repeat(64);
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("oauth2")
        ? Response.json({ access_token: "test", expires_in: 3600 })
        : String(url).includes("get_metadata")
          ? Response.json({ id: "id:stable", rev: "r1", content_hash: hash })
          : new Response("conflict", { status: 409 }),
    );
    const dropbox = new Dropbox(
      { appKey: "app", refreshToken: "refresh" },
      fetcher as typeof fetch,
    );
    expect(
      (
        await dropbox.upload(
          "/日本語/test.png",
          new Uint8Array([1]),
          "b".repeat(64),
        )
      ).id,
    ).toBe("id:stable");
    hash = "c".repeat(64);
    await expect(
      dropbox.upload("/日本語/test.png", new Uint8Array([1]), "b".repeat(64)),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("保管先がCloudflare R2の共有ゲートウェイ", () => {
  const token = "x".repeat(40);
  const auth = { Authorization: `Bearer ${token}` };
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6]);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const r2Version = (kind: Version["kind"], assetId: string, bytes = png): Version => {
    const relativePath = `assets/${assetId}/${kind}/${crypto.randomUUID()}.png`;
    return {
      id: crypto.randomUUID(),
      kind,
      relativePath,
      mime: "image/png",
      size: bytes.length,
      sha256: sha(bytes),
      createdAt: new Date().toISOString(),
      createdBy: "user",
      dropbox: { id: relativePath, rev: "pending", contentHash: "b".repeat(64) },
    };
  };
  const setup = () => {
    const repo = new MemoryRepository();
    const bucket = new FakeBucket();
    const app = createWorker(repo, new R2Blobs(bucket.asBucket()), token, "R2App", {
      bucket: bucket.asBucket(),
    });
    const putBlob = (key: string, bytes = png, headers: Record<string, string> = {}) =>
      app.request(`/internal/blobs/${key}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "image/png", "x-content-sha256": sha(bytes), ...headers },
        body: bytes,
      });
    return { repo, bucket, app, lib: new Library(repo), putBlob };
  };

  it("PUTで保存した画像を公開ページで返し、Rangeは206、共有停止後は媒体も404でR2を読まない", async () => {
    const { bucket, app, lib, putBlob } = setup();
    const assetId = crypto.randomUUID();
    const original = r2Version("original", assetId);
    const published = r2Version("published", assetId);
    for (const v of [original, published]) {
      const r = await putBlob(v.relativePath);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { id: string; rev: string; size: number };
      expect(body).toMatchObject({ id: v.relativePath, size: png.length });
      v.dropbox!.rev = body.rev;
    }
    expect(bucket.objects.get(original.relativePath)?.contentType).toBe("image/png");
    let a = await lib.createAsset({ id: assetId, title: "R2画像", version: original });
    a = await lib.publish(a.id, a.revision, published);

    const media = await app.request(`/s/${a.slug}/media/${a.id}`);
    expect(media.status).toBe(200);
    expect(media.headers.get("Content-Type")).toBe("image/png");
    expect(media.headers.get("Content-Length")).toBe(String(png.length));
    expect(media.headers.get("Location")).toBeNull();
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(png);

    const part = await app.request(`/s/${a.slug}/media/${a.id}`, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 2-5/${png.length}`);
    expect(part.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.subarray(2, 6));
    const tail = await app.request(`/s/${a.slug}/media/${a.id}`, { headers: { Range: "bytes=-3" } });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(png.subarray(-3));
    const bad = await app.request(`/s/${a.slug}/media/${a.id}`, { headers: { Range: "bytes=99-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${png.length}`);

    const reads = bucket.calls.get;
    await lib.revoke(a.id, (await lib.asset(a.id)).revision);
    expect((await app.request(`/s/${a.slug}/media/${a.id}`)).status).toBe(404);
    expect((await app.request(`/s/${a.slug}`)).status).toBe(404);
    expect(bucket.calls.get).toBe(reads);
  });

  it("管理用の合言葉が無い・違う時は保存も取得も拒否する", async () => {
    const { bucket, app } = setup();
    const key = r2Version("original", crypto.randomUUID()).relativePath;
    const noAuth = await app.request(`/internal/blobs/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png", "x-content-sha256": sha(png) },
      body: png,
    });
    expect(noAuth.status).toBe(401);
    const wrong = await app.request(`/internal/blobs/${key}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${"y".repeat(40)}`, "Content-Type": "image/png", "x-content-sha256": sha(png) },
      body: png,
    });
    expect(wrong.status).toBe(401);
    expect((await app.request(`/internal/blobs/${key}`)).status).toBe(401);
    expect(bucket.calls.put).toBe(0);
  });

  it("SHA-256の不一致・不正なキー・種類と拡張子の食い違いを拒否し、何も保存しない", async () => {
    const { bucket, putBlob } = setup();
    const key = r2Version("original", crypto.randomUUID()).relativePath;
    expect((await putBlob(key, png, { "x-content-sha256": "0".repeat(64) })).status).toBe(400);
    expect((await putBlob(key, png, { "x-content-sha256": "" })).status).toBe(400);
    expect((await putBlob(key, png, { "Content-Type": "image/jpeg" })).status).toBe(400);
    const id = crypto.randomUUID();
    for (const bad of [
      `assets/%2e%2e/original/${id}.png`,
      `assets//original/${id}.png`,
      `/assets/${id}/original/${id}.png`,
      `assets/${id}/original/${id}.png/extra`,
      `other/${id}/original/${id}.png`,
      `assets/${id}/secret/${id}.png`,
      `assets/${id}/original/..png`,
    ])
      expect((await putBlob(bad)).status, bad).toBe(400);
    expect(bucket.calls.put).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("同じ内容の再送は同じ版として受け、別の内容での上書きは409で拒否する", async () => {
    const { bucket, putBlob } = setup();
    const key = r2Version("original", crypto.randomUUID()).relativePath;
    const first = (await (await putBlob(key)).json()) as { rev: string };
    const again = await putBlob(key);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { rev: string }).rev).toBe(first.rev);
    const other = new Uint8Array([...png, 9]);
    expect((await putBlob(key, other)).status).toBe(409);
    expect(bucket.calls.put).toBe(1);
    expect(bucket.objects.get(key)?.bytes).toEqual(png);
  });

  it("管理APIのGETで実体をRange付きで取り出せる", async () => {
    const { app, putBlob } = setup();
    const key = r2Version("original", crypto.randomUUID()).relativePath;
    await putBlob(key);
    const whole = await app.request(`/internal/blobs/${key}`, { headers: auth });
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(png);
    const part = await app.request(`/internal/blobs/${key}`, { headers: { ...auth, Range: "bytes=0-1" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.subarray(0, 2));
    const missing = r2Version("original", crypto.randomUUID()).relativePath;
    expect((await app.request(`/internal/blobs/${missing}`, { headers: auth })).status).toBe(404);
  });

  it("台帳の新しい版は、R2に同じキー・大きさ・SHA-256の実体がある時だけ受け付ける", async () => {
    const { repo, app, putBlob } = setup();
    const assetId = crypto.randomUUID();
    const original = r2Version("original", assetId);
    const a = await new Library(new MemoryRepository()).createAsset({ id: assetId, title: "台帳", version: original });
    const send = (entity: unknown, expected: number) =>
      app.request(`/internal/entities/${assetId}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ entity, expected }),
      });
    expect((await send(a, 0)).status).toBe(400);
    await putBlob(original.relativePath);
    const moved = structuredClone(a);
    moved.versions[0].dropbox!.id = r2Version("original", assetId).relativePath;
    expect((await send(moved, 0)).status).toBe(400);
    const dropboxStyle = structuredClone(a);
    dropboxStyle.versions[0].dropbox!.id = "id:stable";
    expect((await send(dropboxStyle, 0)).status).toBe(400);
    expect((await send(a, 0)).status).toBe(200);
    expect(await repo.get(assetId)).not.toBeNull();
  });

  it("保管先の設定が不正・R2バケット未接続なら503で止まる", async () => {
    const env = { DB: {}, ADMIN_TOKEN: token } as unknown as Env;
    const req = () => new Request("https://example.pages.dev/s/" + "0".repeat(32));
    expect((await worker.fetch(req(), { ...env, STORAGE_PROVIDER: "r2" })).status).toBe(503);
    expect((await worker.fetch(req(), { ...env, STORAGE_PROVIDER: "s3" })).status).toBe(503);
  });
});

describe("保管先がGoogleドライブの共有ゲートウェイ", () => {
  const token = "x".repeat(40);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 8, 6, 7, 5, 3, 0, 9]);
  const creds = {
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "secret-value",
    GOOGLE_REFRESH_TOKEN: "refresh",
    GOOGLE_DRIVE_FOLDER_ID: "folder-0000001",
  };
  const setup = async () => {
    const fake = new FakeGoogleDrive();
    // 管理クライアント側と同じ偽のドライブへ保存しておき、Workerは vars.STORAGE_PROVIDER=gdrive の工場関数で読む。
    const drive = new GoogleDrive(
      { clientId: creds.GOOGLE_CLIENT_ID, clientSecret: creds.GOOGLE_CLIENT_SECRET, refreshToken: "refresh", folderId: creds.GOOGLE_DRIVE_FOLDER_ID },
      fake.fetch,
    );
    const storage = createWorkerStorage(
      { DB: {}, ADMIN_TOKEN: token, STORAGE_PROVIDER: "gdrive", ...creds } as unknown as Env,
      fake.fetch,
    );
    if (storage.error !== undefined) throw new Error(storage.error);
    const repo = new MemoryRepository();
    const app = createWorker(repo, storage.reader, token, "DriveApp");
    const version = async (kind: Version["kind"], assetId: string): Promise<Version> => {
      const relativePath = `assets/${assetId}/${kind}/${crypto.randomUUID()}.png`;
      return {
        id: crypto.randomUUID(),
        kind,
        relativePath,
        mime: "image/png",
        size: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        createdAt: new Date().toISOString(),
        createdBy: "user",
        dropbox: await drive.upload(relativePath, png, dropboxHash(png)),
      };
    };
    return { fake, repo, app, lib: new Library(repo), version };
  };
  const media = (fake: FakeGoogleDrive) => fake.count((c) => c.url.includes("alt=media"));

  it("公開ページで画像を中継し（リダイレクトしない）、Rangeは206、共有停止後は404でGoogleを呼ばない", async () => {
    const { fake, app, lib, version } = await setup();
    const assetId = crypto.randomUUID();
    let a = await lib.createAsset({ id: assetId, title: "ドライブ画像", version: await version("original", assetId) });
    a = await lib.publish(a.id, a.revision, await version("published", assetId));

    const html = await app.request(`/s/${a.slug}`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<title>ドライブ画像 · DriveApp</title>");
    const whole = await app.request(`/s/${a.slug}/media/${a.id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Location")).toBeNull();
    expect(whole.headers.get("Content-Type")).toBe("image/png");
    expect(whole.headers.get("X-GUploader-UploadID")).toBeNull();
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(png);
    const part = await app.request(`/s/${a.slug}/media/${a.id}`, { headers: { Range: "bytes=1-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 1-3/${png.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.subarray(1, 4));

    const reads = media(fake);
    await lib.revoke(a.id, (await lib.asset(a.id)).revision);
    expect((await app.request(`/s/${a.slug}/media/${a.id}`)).status).toBe(404);
    expect((await app.request(`/s/${a.slug}`)).status).toBe(404);
    expect(media(fake)).toBe(reads);
  });

  it("台帳の新しい版は、Googleドライブに同じ大きさ・SHA-256の実体がある時だけ受け付ける", async () => {
    const { fake, repo, app, version } = await setup();
    const assetId = crypto.randomUUID();
    const original = await version("original", assetId);
    const a = await new Library(new MemoryRepository()).createAsset({ id: assetId, title: "台帳", version: original });
    const send = (entity: unknown) =>
      app.request(`/internal/entities/${assetId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ entity, expected: 0 }),
      });
    const dropboxStyle = structuredClone(a);
    dropboxStyle.versions[0].dropbox!.id = "id:stable";
    expect((await send(dropboxStyle)).status).toBe(400);
    const tampered = structuredClone(a);
    tampered.versions[0].sha256 = "c".repeat(64);
    expect((await send(tampered)).status).toBe(400);
    fake.files.get(original.dropbox!.id.slice("gdrive:".length))!.trashed = true;
    expect((await send(a)).status).toBe(400);
    fake.files.get(original.dropbox!.id.slice("gdrive:".length))!.trashed = false;
    expect((await send(a)).status).toBe(200);
    expect(await repo.get(assetId)).not.toBeNull();
  });
});
