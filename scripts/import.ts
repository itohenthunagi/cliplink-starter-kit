import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "asset-id": { type: "string" },
    title: { type: "string" },
    "source-url": { type: "string" },
    "source-title": { type: "string" },
    port: { type: "string", default: "4317" },
    ai: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1)
  throw new Error(
    "Usage: npm run import -- <absolute-file-path> [--asset-id UUID] [--ai] [--title title]",
  );
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid port");
const base = `http://127.0.0.1:${port}/api`;
let shareUrl = "";
const request = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init);
  const data = await r.json();
  if (!r.ok) throw new Error((data as { error: string }).error);
  shareUrl = r.headers.get("x-cliplink-share-url") || shareUrl;
  return data;
};
const session = (await request("/session")) as { token: string };
const path = positionals[0];
const info = await stat(path);
if (info.size > 100 * 1024 * 1024)
  throw new Error("100MB以下のファイルを選んでください。");
const form = new FormData();
form.set(
  "file",
  new Blob([new Uint8Array(await readFile(path))]),
  basename(path),
);
form.set("title", values.title || basename(path));
form.set("captureAt", info.mtime.toISOString());
form.set("sourceUrl", values["source-url"] || "");
form.set("sourceTitle", values["source-title"] || "");
form.set("createdBy", values.ai ? "ai" : "user");
if (values["asset-id"]) {
  const entities = (await request("/entities")) as {
    id: string;
    revision: number;
  }[];
  const a = entities.find((a) => a.id === values["asset-id"]);
  if (!a) throw new Error("Asset not found");
  form.set("revision", String(a.revision));
} else if (!values.ai) {
  // 新規登録は撮影系の入口と同じく、登録と同時に共有URLを付ける。
  // AIの出力（--ai）と既存資産への作業版（--asset-id）は、利用者が確認するまで公開しない（SPEC R-06）。
  form.set("publishNow", "true");
}
const result = (await request(
  values["asset-id"]
    ? `/assets/${encodeURIComponent(values["asset-id"])}/versions`
    : "/assets",
  {
    method: "POST",
    headers: { "x-cliplink-token": session.token },
    body: form,
  },
)) as { id: string };
console.log(
  values["asset-id"]
    ? `作業版を登録しました: ${result.id}\n管理画面で確認し、「この版を共有URLに反映」で公開内容を切り替えます。`
    : shareUrl
      ? `登録しました: ${result.id}\n共有URL: ${shareUrl}`
      : `未共有で登録しました: ${result.id}\n管理画面で確認し、「共有URLを発行」で共有できます。`,
);
