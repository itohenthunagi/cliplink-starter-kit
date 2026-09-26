import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { Library } from "../src/core/library";
import { FileStore, hash } from "../src/server/storage";
import { SqliteRepository } from "../src/server/repository";
import type { Asset } from "../src/core/model";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
let repo: SqliteRepository,
  lib: Library,
  store: FileStore,
  app: ReturnType<typeof createApp>,
  token: string;
const origin = "http://127.0.0.1:4317";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(origin + path, {
    method,
    headers: {
      host: "127.0.0.1:4317",
      "x-cliplink-token": token,
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body
      ? { body: body instanceof FormData ? body : JSON.stringify(body) }
      : {}),
  });
}
async function upload(title = "操作説明") {
  const form = new FormData();
  form.set("file", new Blob([png]), "sample.png");
  form.set("title", title);
  form.set("sourceUrl", "https://private.example.test/internal");
  const r = await request("/api/assets", "POST", form);
  expect(r.status).toBe(201);
  return (await r.json()) as Asset;
}
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "cliplink-test-"));
  repo = new SqliteRepository(join(root, "catalog.sqlite"));
  lib = new Library(repo);
  store = new FileStore(join(root, "library"));
  app = createApp({
    library: lib,
    store,
    origin,
    mode: "local",
    shareBase: origin,
  });
  token = (await (await request("/api/session")).json()).token;
});
afterEach(() => repo.db.close());
describe("ローカルAPIの受入条件", () => {
  it("既定CSPが最初のmiddlewareで全ルートにかかり、API/公開ページは自分の用途に絞ったCSPで上書きされる", async () => {
    const sessionRes = await request("/api/session");
    expect(sessionRes.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    const fallbackRes = await request("/unknown-path");
    expect(fallbackRes.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });
  it("撮影直後に公開URLを作り、同じPCから画像を開ける", async () => {
    const form = new FormData();
    form.set("file", new Blob([png]), "quick.png");
    form.set("title", "すぐ共有");
    form.set("publishNow", "true");
    const response = await request("/api/assets", "POST", form);
    expect(response.status).toBe(201);
    const a = (await response.json()) as Asset;
    expect(a.status).toBe("published");
    expect(a.currentPublishedVersionId).toBeTruthy();
    expect(response.headers.get("x-cliplink-share-url")).toBe(`${origin}/s/${a.slug}`);
    expect((await request(`/s/${a.slug}`)).status).toBe(200);
    expect(Buffer.from(await (await request(`/s/${a.slug}/media/${a.id}`)).arrayBuffer())).toEqual(png);
    expect(hash(await readFile(store.path(a.versions[0])))).toBe(a.versions[0].sha256);
  });
  it("公開直後だけ固定共有URLを返し、下書き作成APIは従来の応答を保つ", async () => {
    const draftForm = new FormData();
    draftForm.set("file", new Blob([png]), "draft.png");
    draftForm.set("title", "下書き");
    const draftResponse = await request("/api/assets", "POST", draftForm);
    expect(draftResponse.status).toBe(201);
    expect(draftResponse.headers.get("x-cliplink-share-url")).toBeNull();
    expect(((await draftResponse.json()) as Asset).status).toBe("draft");

    const publishedForm = new FormData();
    publishedForm.set("file", new Blob([png]), "published.png");
    publishedForm.set("title", "即時公開");
    publishedForm.set("publishNow", "true");
    const publishedResponse = await request("/api/assets", "POST", publishedForm);
    expect(publishedResponse.status).toBe(201);
    const published = (await publishedResponse.json()) as Asset;
    expect(published.status).toBe("published");
    expect(publishedResponse.headers.get("x-cliplink-share-url")).toBe(
      `${origin}/s/${published.slug}`,
    );
  });
  it("管理画面の版は不変なのでキャッシュし、公開媒体は共有停止を効かせるため保存させない", async () => {
    const form = new FormData();
    form.set("file", new Blob([png]), "cache.png");
    form.set("publishNow", "true");
    const a = (await (await request("/api/assets", "POST", form)).json()) as Asset;
    const managed = await request(`/api/assets/${a.id}/versions/${a.versions[0].id}`);
    expect(managed.status).toBe(200);
    expect(managed.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    const missing = await request(`/api/assets/${a.id}/versions/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    const shared = await request(`/s/${a.slug}/media/${a.id}`);
    expect(shared.headers.get("cache-control")).toContain("no-store");
  });
  it("原本保存→作業版→公開→差し替え→停止。公開面に内部情報を出さない", async () => {
    let a = await upload("<script>alert(1)</script>");
    const original = a.versions[0];
    const originalPath = store.path(original);
    expect(hash(await readFile(originalPath))).toBe(original.sha256);
    a = await (
      await request(`/api/assets/${a.id}`, "PATCH", {
        revision: a.revision,
        notes: "SECRET-NOTE-123",
      })
    ).json();
    const form = new FormData();
    form.set(
      "file",
      new Blob([Buffer.concat([png, Buffer.from("annotation")])]),
      "edit.png",
    );
    form.set("revision", String(a.revision));
    form.set("createdBy", "ai");
    a = await (
      await request(`/api/assets/${a.id}/versions`, "POST", form)
    ).json();
    expect(a.status).toBe("draft");
    a = await (
      await request(`/api/assets/${a.id}/publish`, "POST", {
        revision: a.revision,
        versionId: a.versions[1].id,
      })
    ).json();
    const url = `/s/${a.slug}`;
    const html = await (await request(url)).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    for (const privateValue of [
      "SECRET-NOTE-123",
      "private.example.test",
      store.root,
      original.relativePath,
      original.id,
    ])
      expect(html).not.toContain(privateValue);
    const first = await request(`${url}/media/${a.id}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await first.arrayBuffer()).length).toBeGreaterThan(
      png.length,
    );
    a = await (
      await request(`/api/assets/${a.id}/publish`, "POST", {
        revision: a.revision,
        versionId: original.id,
      })
    ).json();
    expect(`/s/${a.slug}`).toBe(url);
    expect(
      Buffer.from(await (await request(`${url}/media/${a.id}`)).arrayBuffer()),
    ).toEqual(png);
    expect(
      (
        await request(`/api/entities/${a.id}/archive`, "POST", {
          revision: a.revision,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/entities/${a.id}/revoke`, "POST", {
          revision: a.revision,
        })
      ).status,
    ).toBe(200);
    expect((await request(url)).status).toBe(404);
    expect((await request(`${url}/media/${a.id}`)).status).toBe(404);
    expect(hash(await readFile(originalPath))).toBe(original.sha256);
  });
  it("外部Origin、不正Host、トークンなし操作、パストラバーサルを拒否", async () => {
    expect(
      (
        await request("/api/session", "GET", undefined, {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/session", "GET", undefined, { host: "evil.test" }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/settings",
          "POST",
          { root: store.root },
          { "x-cliplink-token": "" },
        )
      ).status,
    ).toBe(403);
    expect((await request("/api/assets/not-an-id/ai")).status).toBe(400);
    const form = new FormData();
    form.set("file", new Blob(['<svg onload="alert(1)">']), "x.png");
    expect((await request("/api/assets", "POST", form)).status).toBe(400);
    expect(
      (await request("/api/settings", "POST", { root: "../../outside" }))
        .status,
    ).toBe(400);
  });
  it("動画の部分取得・不正範囲・同時更新競合を扱う", async () => {
    const form = new FormData();
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypmp42"),
      Buffer.alloc(128),
    ]);
    form.set("file", new Blob([bytes]), "screen.mp4");
    form.set("title", "動画");
    let a = (await (
      await request("/api/assets", "POST", form)
    ).json()) as Asset;
    expect(a.type).toBe("video");
    a = await (
      await request(`/api/assets/${a.id}/publish`, "POST", {
        revision: a.revision,
        versionId: a.versions[0].id,
      })
    ).json();
    const url = `/s/${a.slug}/media/${a.id}`;
    const range = await request(url, "GET", undefined, { range: "bytes=4-11" });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("ftypmp42");
    expect(
      (await request(url, "GET", undefined, { range: "bytes=99999-" })).status,
    ).toBe(416);
    const stale = a.revision;
    expect(
      (
        await request(`/api/assets/${a.id}`, "PATCH", {
          revision: stale,
          title: "先",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/assets/${a.id}`, "PATCH", {
          revision: stale,
          title: "後",
        })
      ).status,
    ).toBe(409);
  });
  it("appNameは既定値Cliplinkを使い、CLIPLINK_APP_NAME相当の指定時はsession APIと公開ページに反映される", async () => {
    expect((await (await request("/api/session")).json()).appName).toBe(
      "Cliplink",
    );
    const branded = createApp({
      library: lib,
      store,
      origin,
      mode: "local",
      shareBase: origin,
      appName: "MyBrand",
    });
    const brandedRequest = (
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      branded.request(origin + path, {
        method,
        headers: {
          host: "127.0.0.1:4317",
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
      });
    const brandedSession = await (await brandedRequest("/api/session")).json();
    expect(brandedSession.appName).toBe("MyBrand");
    const form = new FormData();
    form.set("file", new Blob([png]), "brand.png");
    form.set("title", "ブランド確認");
    form.set("publishNow", "true");
    const created = await brandedRequest("/api/assets", "POST", form, {
      "x-cliplink-token": brandedSession.token,
    });
    expect(created.status).toBe(201);
    const asset = (await created.json()) as Asset;
    const html = await (await brandedRequest(`/s/${asset.slug}`)).text();
    expect(html).toContain("<title>ブランド確認 · MyBrand</title>");
    expect(html).toContain("<small>MyBrand</small>");
  });
  it("保存先の変更は既存実体がないと拒否し、AI参照は管理画面だけで取得する", async () => {
    const newRoot = join(store.root, "new");
    expect(
      (await request("/api/settings", "POST", { root: newRoot })).status,
    ).toBe(200);
    const a = await upload();
    const ref = await (await request(`/api/assets/${a.id}/ai`)).json();
    expect(ref.local_path).toContain(newRoot);
    expect(ref.version_id).toBe(a.versions[0].id);
    expect(
      (
        await request("/api/settings", "POST", {
          root: join(newRoot, "missing"),
        })
      ).status,
    ).toBe(409);
    await writeFile(store.path(a.versions[0]), "unexpected external edit");
    expect(
      (
        await request(`/api/assets/${a.id}/publish`, "POST", {
          revision: a.revision,
          versionId: a.versions[0].id,
        })
      ).status,
    ).toBe(503);
    expect((await lib.asset(a.id)).status).toBe("draft");
  });
});
