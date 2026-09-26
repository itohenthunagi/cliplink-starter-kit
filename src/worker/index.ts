import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import {
  entitySchema,
  extensions,
  relativePathPattern,
  type Entity,
  type Repository,
} from "../core/model";
import { Library, DomainError, conflict } from "../core/library";
import { publicApp } from "../core/public";
import { readObject, toHex, type BlobBucket } from "./r2";
import { createWorkerStorage, type MediaReader } from "./storage";
export type { MediaReader } from "./storage";
export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  // 保管先がDropboxの時だけ使う。
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  DROPBOX_REFRESH_TOKEN?: string;
  // 保管先がGoogleドライブの時だけ使う（フォルダIDは読み出しでは使わないが、setup:cloudflare が同じ組で送る）。
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
  APP_NAME?: string;
  // 画像の保管先（src/core/storage-provider.ts の一覧のどれか。未設定は dropbox）。
  STORAGE_PROVIDER?: string;
  // 保管先がR2の時のバケット（wranglerの r2_buckets, binding: BUCKET）。
  BUCKET?: R2Bucket;
}
const BLOB_PREFIX = "/internal/blobs/";
const MAX_BLOB = 100 * 1024 * 1024;
// 管理用の合言葉を、一致した文字数で処理時間が変わらない方法で比べる（両方をSHA-256にしてから全バイトを比較）。
async function sameSecret(given: string, expected: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map(async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v)))),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export class D1Repository implements Repository {
  constructor(private db: D1Database) {}
  private parse(row: { body: string } | null) {
    return row ? entitySchema.parse(JSON.parse(row.body)) : null;
  }
  async get(id: string) {
    return this.parse(
      await this.db
        .prepare("SELECT body FROM entities WHERE id=?")
        .bind(id)
        .first<{ body: string }>(),
    );
  }
  async bySlug(slug: string) {
    return this.parse(
      await this.db
        .prepare("SELECT body FROM entities WHERE slug=?")
        .bind(slug)
        .first<{ body: string }>(),
    );
  }
  async list() {
    const r = await this.db
      .prepare("SELECT body FROM entities ORDER BY rowid DESC")
      .all<{ body: string }>();
    return r.results.map((row) => this.parse(row)!);
  }
  async save(e: Entity, expected: number) {
    const r =
      expected === 0
        ? await this.db
            .prepare(
              "INSERT OR IGNORE INTO entities(id,slug,revision,body) VALUES(?,?,?,?)",
            )
            .bind(e.id, e.slug, e.revision, JSON.stringify(e))
            .run()
        : await this.db
            .prepare(
              "UPDATE entities SET body=?,revision=? WHERE id=? AND revision=? AND slug=?",
            )
            .bind(JSON.stringify(e), e.revision, e.id, expected, e.slug)
            .run();
    if (!r.meta.changes) throw conflict();
  }
}
export function createWorker(
  repo: Repository,
  reader: MediaReader,
  adminToken: string,
  appName?: string,
  // bucket を渡すと管理API /internal/blobs/* でR2への保存・取得を受け持つ（保管先がR2の時）。
  options: { bucket?: BlobBucket } = {},
) {
  const { bucket } = options;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((err, c) =>
    c.json(
      {
        error:
          err instanceof DomainError
            ? err.message
            : err instanceof ZodError
              ? "入力内容が不正です。"
              : "一時的に利用できません。",
      },
      err instanceof DomainError
        ? (err.status as 400)
        : err instanceof ZodError
          ? 400
          : 503,
    ),
  );
  app.route(
    "/s",
    publicApp(
      new Library(repo),
      { read: (v, r) => reader.download(v, r) },
      { appName },
    ),
  );
  app.use("/internal/*", async (c, next) => {
    if (
      !adminToken ||
      adminToken.length < 32 ||
      !(await sameSecret(c.req.header("authorization") ?? "", `Bearer ${adminToken}`))
    )
      return c.json({ error: "認証が必要です。" }, 401);
    await next();
  });
  app.use(
    "/internal/entities/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "台帳1件の容量上限です。" }, 413),
    }),
  );
  if (bucket) {
    const blobKey = (path: string) => {
      const key = path.slice(BLOB_PREFIX.length);
      // assets/<id>/<kind>/<id>.<ext> だけを許す（".."・先頭の/・空の区切りはこの形に一致しない）。
      if (!relativePathPattern.test(key))
        throw new DomainError("保存先のキーが不正です。");
      return key;
    };
    app.put(
      `${BLOB_PREFIX}*`,
      bodyLimit({
        maxSize: MAX_BLOB,
        onError: (c) => c.json({ error: "ファイルは100MB以下にしてください。" }, 413),
      }),
      async (c) => {
        const key = blobKey(c.req.path);
        const mime = (c.req.header("content-type") || "").split(";")[0].trim();
        if (extensions[mime as keyof typeof extensions] !== key.split(".").at(-1))
          throw new DomainError("ファイルの種類とキーの拡張子が一致しません。");
        const expected = (c.req.header("x-content-sha256") || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expected))
          throw new DomainError("x-content-sha256 が必要です。");
        const body = await c.req.arrayBuffer();
        if (!body.byteLength || body.byteLength > MAX_BLOB)
          throw new DomainError("ファイルは100MB以下にしてください。", 413);
        const actual = toHex(await crypto.subtle.digest("SHA-256", body));
        if (actual !== expected)
          throw new DomainError("受け取った内容の整合確認に失敗しました。");
        // 版は不変。同じ内容の再送（再試行）だけ受け入れ、別の内容で上書きしない。
        const existing = await bucket.head(key);
        if (existing) {
          const saved = existing.checksums?.sha256;
          if (saved && toHex(saved) === actual && existing.size === body.byteLength)
            return c.json({ id: key, rev: existing.etag, size: existing.size });
          throw new DomainError("同じ場所に別の内容があります。上書きはしません。", 409);
        }
        const obj = await bucket.put(key, body, {
          httpMetadata: { contentType: mime },
          sha256: actual,
        });
        if (!obj) throw new DomainError("R2へ保存できませんでした。", 503);
        return c.json({ id: key, rev: obj.etag, size: obj.size });
      },
    );
    app.get(`${BLOB_PREFIX}*`, async (c) => {
      const r = await readObject(bucket, blobKey(c.req.path), c.req.header("range"));
      return r ?? c.json({ error: "見つかりません。" }, 404);
    });
  }
  app.get("/internal/entities", async (c) => c.json(await repo.list()));
  app.get("/internal/entities/:id", async (c) => {
    const e = await repo.get(c.req.param("id"));
    return e ? c.json(e) : c.json({ error: "見つかりません。" }, 404);
  });
  app.get("/internal/shares/:slug", async (c) => {
    const e = await repo.bySlug(c.req.param("slug"));
    return e ? c.json(e) : c.json({ error: "見つかりません。" }, 404);
  });
  app.put("/internal/entities/:id", async (c) => {
    const { entity, expected } = z
      .object({
        entity: entitySchema,
        expected: z.number().int().nonnegative(),
      })
      .parse(await c.req.json());
    if (entity.id !== c.req.param("id") || entity.revision !== expected + 1)
      throw new DomainError("更新番号が不正です。");
    const old = await repo.get(entity.id);
    if (entity.kind === "asset") {
      if (entity.versions.some((v) => !v.dropbox))
        throw new DomainError("保管先（Dropbox等）への保存が済んでいない版があります。");
      // 新しく加わる版は、今の保管先に保存済みかを保管先ごとの方法で確かめる（R2はキー・大きさ・SHA-256まで照合する）。
      const known = new Set(old?.kind === "asset" ? old.versions.map((v) => v.id) : []);
      for (const v of entity.versions)
        if (!known.has(v.id)) await reader.verify?.(v);
      if (
        entity.versions.filter((v) => v.kind === "original").length !== 1 ||
        entity.versions[0].kind !== "original"
      )
        throw new DomainError("原本が不正です。");
      if (
        entity.status === "published" &&
        !entity.versions.some(
          (v) =>
            v.kind === "published" && v.id === entity.currentPublishedVersionId,
        )
      )
        throw new DomainError("公開版が不正です。");
    }
    if (old && (old.slug !== entity.slug || old.kind !== entity.kind))
      throw new DomainError("IDと共有URLは変更できません。");
    if (old?.kind === "asset" && entity.kind === "asset")
      for (const v of old.versions)
        if (
          JSON.stringify(v) !==
          JSON.stringify(entity.versions.find((n) => n.id === v.id))
        )
          throw new DomainError("保存済みの版は変更・削除できません。");
    await repo.save(entity, expected);
    return c.json({ ok: true });
  });
  app.notFound((c) => c.text("ページが見つかりません。", 404));
  return app;
}
export default {
  fetch(request: Request, env: Env) {
    const storage = createWorkerStorage(env);
    if (storage.error !== undefined)
      return Response.json(
        { error: storage.error },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    return createWorker(
      new D1Repository(env.DB),
      storage.reader,
      env.ADMIN_TOKEN,
      env.APP_NAME,
      { bucket: storage.bucket },
    ).fetch(request);
  },
};
