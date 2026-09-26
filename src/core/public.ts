import { Hono } from "hono";
import type { BlobStore } from "./model";
import { Library, DomainError, notFound } from "./library";
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const publicHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
export const formatBytes = (n: number) =>
  n < 1024 * 1024
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
// 共有ページの補助スクリプト。画素数は読み込み後に実寸から埋め、画像コピーはPNGへ揃えてクリップボードへ書く
// （クリップボードが確実に受け付ける画像形式はPNGのみ）。ClipboardItemにPromiseを渡し、押した操作の中で書き込む。
const pageScript = `
for (const m of document.querySelectorAll("img[data-media],video[data-media]")) {
  const show = () => {
    const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight;
    if (w) m.closest("figure").querySelector("[data-dim]").textContent = w + " × " + h;
  };
  m.complete || m.readyState > 0 ? show() : m.addEventListener(m.tagName === "IMG" ? "load" : "loadedmetadata", show);
}
const toPng = async (url) => {
  const blob = await (await fetch(url)).blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return new Promise((ok, ng) => canvas.toBlob((b) => b ? ok(b) : ng(new Error("png")), "image/png"));
};
for (const b of document.querySelectorAll("button[data-copy]")) {
  b.addEventListener("click", async () => {
    const label = b.textContent;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": toPng(b.dataset.copy) })]);
      b.textContent = "コピーしました";
    } catch { b.textContent = "コピーできませんでした"; }
    setTimeout(() => (b.textContent = label), 2000);
  });
}`;
export function publicApp(
  library: Library,
  blobs: Pick<BlobStore, "read">,
  options: { appName?: string } = {},
) {
  const appName = options.appName?.trim() || "Cliplink";
  const appSlug =
    appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cliplink";
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(publicHeaders)) c.header(k, v);
    await next();
  });
  app.onError((err, c) =>
    c.text(
      err instanceof DomainError
        ? err.message
        : "現在表示できません。しばらくしてから開き直してください。",
      err instanceof DomainError ? (err.status as 400) : 503,
    ),
  );
  app.get("/:slug", async (c) => {
    const share = await library.resolveShare(c.req.param("slug"));
    const content = share.assets
      .map((a) => {
        const url = `/s/${c.req.param("slug")}/media/${a.id}`;
        // 単体共有は見出しと同じ題名を繰り返さない。コレクションでは各画像の題名を添える。
        const media =
          a.type === "image"
            ? `<img data-media src="${url}" alt="${escapeHtml(a.title)}" loading="lazy">`
            : `<video data-media controls playsinline preload="metadata" src="${url}"></video>`;
        const actions =
          a.type === "image"
            ? `<button type="button" data-copy="${url}">画像をコピー</button>`
            : `<a href="${url}?download=1">動画をダウンロード</a>`;
        return `<figure>${media}${share.kind === "collection" ? `<figcaption>${escapeHtml(a.title)}</figcaption>` : ""}<div class="meta"><span><span data-dim>—</span> · ${formatBytes(a.version.size)}</span>${actions}</div></figure>`;
      })
      .join("");
    // スクリプトはこの応答だけのnonceで許可する。外部読込・インライン属性は引き続き禁止。
    const nonce = crypto.randomUUID().replaceAll("-", "");
    c.header(
      "Content-Security-Policy",
      `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    return c.html(
      `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(share.title)} · ${escapeHtml(appName)}</title><style>body{margin:0;background:#f5f4ef;color:#262b27;font:16px/1.8 sans-serif}main{max-width:1060px;margin:auto;padding:40px 24px}header{border-bottom:1px solid #d9ddd5;margin-bottom:32px}small{letter-spacing:.18em;color:#487461}h1{font-size:28px}figure{margin:0 0 32px;padding:16px;background:white;border-radius:12px}img,video{display:block;max-width:100%;height:auto;margin:auto}video{width:100%;max-height:80vh;background:#151a16}figcaption{margin-top:12px;color:#647067}.meta{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;font-size:13px;color:#6b776e}.meta button{font:inherit;font-weight:600;color:#254f3c;background:#fff;border:1px solid #cfd8cc;border-radius:8px;padding:8px 16px;cursor:pointer}.meta button:hover{background:#eef3ea}p{white-space:pre-wrap}a{color:#235a45}</style><main><header><small>${escapeHtml(appName)}</small><h1>${escapeHtml(share.title)}</h1><p>${escapeHtml(share.description)}</p></header>${content || "<p>現在表示できる画像はありません。</p>"}</main><script nonce="${nonce}">${pageScript}</script></html>`,
    );
  });
  app.get("/:slug/media/:assetId", async (c) => {
    const share = await library.resolveShare(c.req.param("slug"));
    const a = share.assets.find((a) => a.id === c.req.param("assetId"));
    if (!a) throw notFound();
    const response = await blobs.read(a.version, c.req.header("range"));
    const headers = new Headers(publicHeaders);
    for (const k of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
      const value = response.headers.get(k);
      if (value) headers.set(k, value);
    }
    headers.set("Content-Type", a.version.mime);
    if (c.req.query("download") === "1")
      headers.set(
        "Content-Disposition",
        `attachment; filename="${appSlug}-${a.id}.${a.version.relativePath.split(".").at(-1)}"`,
      );
    return new Response(response.body, { status: response.status, headers });
  });
  return app;
}
