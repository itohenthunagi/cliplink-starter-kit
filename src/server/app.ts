import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { resolve, isAbsolute } from "node:path";
import { mkdir, access, writeFile, rename } from "node:fs/promises";
import { Library, DomainError, conflict, notFound } from "../core/library";
import { publicApp } from "../core/public";
import { uuid, type Asset, type Version } from "../core/model";
import { FileStore, detectMime, hash } from "./storage";
import { storageLabel } from "../core/storage-provider";
const revisionSchema = z.number().int().positive();
const text = (value: FormDataEntryValue | null, max = 200) =>
  z
    .string()
    .max(max)
    .parse(typeof value === "string" ? value : "");
const sourceUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (v) => !v || /^https?:\/\//i.test(v),
    "HTTP/HTTPSのURLを入力してください。",
  );
export interface AppOptions {
  library: Library;
  store: FileStore;
  origin: string;
  mode: "local" | "cloud";
  shareBase: string;
  appName?: string;
  configPath?: string;
  token?: string;
  shortcutStatus?: () => string;
  // 常駐プログラムに設定されたショートカット（画面の案内用）。
  shortcutKeys?: () => Promise<{ image: string; video: string; open: string }>;
  onActivity?: () => void;
}
export function createApp(options: AppOptions) {
  const { library, store, origin, mode, shareBase } = options;
  const appName = options.appName?.trim() || "Cliplink";
  const app = new Hono();
  const token = options.token || crypto.randomUUID();
  app.use("*", async (c, next) => {
    options.onActivity?.();
    if (c.req.header("host") !== new URL(origin).host)
      return c.text("接続先が不正です。", 403);
    // ここが全ルートの前で必ず通る最初のmiddlewareなので既定CSPをここに置く。
    // /api/* と /s/* はこの後で自分の用途に絞ったCSPへ上書きする。
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof DomainError)
      return c.json({ error: error.message }, error.status as 400);
    if (error instanceof ZodError)
      return c.json(
        {
          error:
            "入力内容が正しくありません。文字数・URL・選択内容を確認してください。",
        },
        400,
      );
    return c.json(
      {
        error:
          "処理できませんでした。保存先の権限、空き容量、接続状態を確認してください。",
      },
      500,
    );
  });
  app.route("/s", publicApp(library, store, { appName }));
  app.use("/api/*", async (c, next) => {
    const requestOrigin = c.req.header("origin");
    if (
      (requestOrigin && requestOrigin !== origin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      return c.json({ error: "外部サイトからの操作はできません。" }, 403);
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("x-cliplink-token") !== token
    )
      return c.json({ error: "画面を再読み込みしてください。" }, 403);
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 101 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: "ファイルは100MB以下にしてください。" }, 413),
    }),
  );
  app.get("/api/session", async (c) =>
    c.json({
      token,
      mode,
      storage: store.provider ?? "local",
      storageLabel: store.provider ? storageLabel(store.provider) : null,
      shareBase,
      appName,
      root: store.root,
      maxBytes: 100 * 1024 * 1024,
      shortcut: options.shortcutStatus?.() || "off",
      shortcutKeys: (await options.shortcutKeys?.()) ?? null,
    }),
  );
  app.get("/api/entities", async (c) =>
    c.json(
      (await library.repo.list()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    ),
  );
  app.post("/api/settings", async (c) => {
    const { root } = z
      .object({ root: z.string().min(1).max(4096) })
      .parse(await c.req.json());
    if (!isAbsolute(root))
      throw new DomainError("保存先は絶対パスで入力してください。");
    if (mode === "local")
      for (const e of await library.repo.list())
        if (e.kind === "asset")
          for (const v of e.versions) {
            try {
              await access(resolve(root, v.relativePath));
            } catch {
              throw new DomainError(
                "既存ファイルが新しい保存先に見つかりません。assetsフォルダを複製してから変更してください。",
                409,
              );
            }
          }
    await mkdir(root, { recursive: true });
    if (options.configPath) {
      const temp = options.configPath + "." + crypto.randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify({ root: resolve(root) }, null, 2), {
        flag: "wx",
      });
      await rename(temp, options.configPath);
    }
    store.root = resolve(root);
    return c.json({ root: store.root });
  });
  async function upload(
    form: FormData,
    assetId: string,
    kind: Version["kind"],
  ) {
    const file = form.get("file");
    if (!(file instanceof File))
      throw new DomainError("ファイルを選択してください。");
    if (!file.size || file.size > 100 * 1024 * 1024)
      throw new DomainError(
        "ファイルは空でない100MB以下のものを選択してください。",
        413,
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = detectMime(bytes);
    const createdBy = z
      .enum(["user", "ai"])
      .parse(form.get("createdBy") || "user");
    return store.put(assetId, kind, bytes, mime, createdBy);
  }
  async function publishVersion(a: Asset, v: Version) {
    const r = await store.read(v);
    if (!r.ok) throw new DomainError("公開するファイルを読み取れません。", 503);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (hash(bytes) !== v.sha256)
      throw new DomainError("公開する版の整合確認に失敗しました。", 503);
    const published = await store.put(a.id, "published", bytes, v.mime, "user");
    return library.publish(a.id, a.revision, published);
  }
  app.post("/api/assets", async (c) => {
    const form = await c.req.formData();
    const id = crypto.randomUUID();
    const title =
      text(form.get("title")) ||
      (form.get("file") as File)?.name ||
      "名称未設定";
    const sourceUrl = sourceUrlSchema.parse(text(form.get("sourceUrl"), 2048));
    const sourceTitle = text(form.get("sourceTitle"), 500);
    const captureAt = z
      .string()
      .datetime()
      .parse(text(form.get("captureAt")) || new Date().toISOString());
    const version = await upload(form, id, "original");
    const asset = await library.createAsset({
        id,
        title,
        sourceUrl,
        sourceTitle,
        captureAt,
        version,
      });
    if (form.get("publishNow") !== "true") return c.json(asset, 201);
    const published = await publishVersion(asset, version);
    c.header(
      "X-Cliplink-Share-Url",
      `${shareBase.replace(/\/+$/, "")}/s/${encodeURIComponent(published.slug)}`,
    );
    return c.json(published, 201);
  });
  app.post("/api/assets/:id/versions", async (c) => {
    const a = await library.asset(uuid.parse(c.req.param("id")));
    const form = await c.req.formData();
    const revision = revisionSchema.parse(Number(form.get("revision")));
    if (a.revision !== revision) throw conflict();
    if (a.status === "archived")
      throw new DomainError("保管済みから戻して登録してください。");
    const file = form.get("file");
    if (!(file instanceof File))
      throw new DomainError("ファイルを選択してください。");
    const mime = detectMime(
      new Uint8Array(await file.slice(0, 32).arrayBuffer()),
    );
    if (!mime.startsWith(a.type + "/"))
      throw new DomainError("原本と同じ種類のファイルを選んでください。");
    const v = await upload(form, a.id, "working");
    const meta = form.get("annotationMeta");
    if (meta) v.annotationMeta = text(meta, 20000);
    return c.json(await library.addVersion(a.id, revision, v));
  });
  app.post("/api/assets/:id/publish", async (c) => {
    const a = await library.asset(uuid.parse(c.req.param("id")));
    const body = z
      .object({ revision: revisionSchema, versionId: uuid })
      .parse(await c.req.json());
    if (a.revision !== body.revision) throw conflict();
    if (a.status === "archived")
      throw new DomainError("保管済みから戻してください。");
    const v = a.versions.find((v) => v.id === body.versionId);
    if (!v) throw notFound();
    return c.json(await publishVersion(a, v));
  });
  app.patch("/api/assets/:id", async (c) => {
    const body = z
      .object({
        revision: revisionSchema,
        title: z.string().min(1).max(200).optional(),
        notes: z.string().max(5000).optional(),
        tags: z.array(z.string().max(80)).max(30).optional(),
        sourceTitle: z.string().max(500).optional(),
        sourceUrl: sourceUrlSchema.optional(),
        protected: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { revision, ...changes } = body;
    return c.json(
      await library.updateAsset(
        uuid.parse(c.req.param("id")),
        revision,
        changes,
      ),
    );
  });
  for (const action of ["archive", "restore", "revoke"] as const)
    app.post(`/api/entities/:id/${action}`, async (c) => {
      const { revision } = z
        .object({ revision: revisionSchema })
        .parse(await c.req.json());
      return c.json(
        await library[action](uuid.parse(c.req.param("id")), revision),
      );
    });
  const collectionInput = z.object({
    title: z.string().min(1).max(200),
    orderedAssetIds: z.array(uuid).min(1).max(100),
    description: z.string().max(5000),
  });
  app.post("/api/collections", async (c) => {
    const b = collectionInput.parse(await c.req.json());
    return c.json(
      await library.createCollection(b.title, b.orderedAssetIds, b.description),
      201,
    );
  });
  app.put("/api/collections/:id", async (c) => {
    const b = collectionInput
      .extend({ revision: revisionSchema })
      .parse(await c.req.json());
    return c.json(
      await library.updateCollection(
        uuid.parse(c.req.param("id")),
        b.revision,
        b.title,
        b.orderedAssetIds,
        b.description,
      ),
    );
  });
  app.get("/api/assets/:id/versions/:versionId", async (c) => {
    const a = await library.asset(uuid.parse(c.req.param("id")));
    const v = a.versions.find((v) => v.id === c.req.param("versionId"));
    if (!v) throw notFound();
    const r = await store.read(v, c.req.header("range"));
    const headers = new Headers(r.headers);
    // 版IDごとに内容が固定された不変ファイルなので、管理画面の再描画で毎回読み直さない。
    // 公開ページ側(/s/*)は共有停止を即時に効かせるためno-storeのまま。
    headers.set(
      "Cache-Control",
      r.ok ? "private, max-age=31536000, immutable" : "no-store",
    );
    headers.set("Content-Type", v.mime);
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    return new Response(r.body, { status: r.status, headers });
  });
  app.get("/api/assets/:id/ai", async (c) => {
    const a = await library.asset(uuid.parse(c.req.param("id")));
    const v =
      a.versions.find((v) => v.id === c.req.query("versionId")) ??
      a.versions.filter((v) => v.kind !== "published").at(-1)!;
    return c.json({
      asset_id: a.id,
      version_id: v.id,
      local_path: await store.materialize(v),
      // Dropbox（とローカル確認モード）は従来の項目名。他の保管先は保管先名とその保管先での識別子を渡す。
      ...(!store.provider || store.provider === "dropbox"
        ? {
            dropbox_relative_path: `${store.dropboxRoot}/${v.relativePath}`,
            dropbox_file_id: v.dropbox?.id,
            dropbox_rev: v.dropbox?.rev,
          }
        : {
            storage_provider: store.provider,
            storage_key: v.dropbox?.id ?? store.remotePath(v),
            storage_rev: v.dropbox?.rev,
          }),
      source_url: a.sourceUrl,
      instructions:
        `編集結果は別ファイルへ保存し、${appName}で作業版として登録してください。公開版の切り替えは利用者が確認して行います。`,
    });
  });
  return app;
}
