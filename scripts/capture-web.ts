import { chromium } from "@playwright/test";
import { parseArgs } from "node:util";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "4317" },
    width: { type: "string", default: "1440" },
  },
});
if (positionals.length !== 1)
  throw new Error(
    "Usage: npm run capture:web -- https://example.com [--port 4317]",
  );
const target = new URL(positionals[0]);
if (
  !["https:", "http:"].includes(target.protocol) ||
  target.username ||
  target.password
)
  throw new Error("HTTP/HTTPSのURLを指定してください。");
const width = Number(values.width),
  port = Number(values.port);
if (
  !Number.isInteger(width) ||
  width < 320 ||
  width > 3840 ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error("幅またはポートが不正です。");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto(target.href, { waitUntil: "networkidle", timeout: 45000 });
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  if (height * width > 40_000_000)
    throw new Error("ページが長すぎます。40,000,000画素以内にしてください。");
  const title = ((await page.title()) || target.hostname).slice(0, 200);
  const finalUrl = page.url();
  const screenshot = await page.screenshot({ fullPage: true, type: "png" });
  const origin = `http://127.0.0.1:${port}`;
  const sessionResponse = await fetch(`${origin}/api/session`);
  if (!sessionResponse.ok)
    throw new Error("Cliplink管理画面を起動してください。");
  const session = (await sessionResponse.json()) as { token: string };
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(screenshot)], { type: "image/png" }),
    "web-capture.png",
  );
  form.set("title", title);
  form.set("sourceTitle", title);
  form.set("sourceUrl", finalUrl);
  form.set("captureAt", new Date().toISOString());
  form.set("publishNow", "true");
  const r = await fetch(`${origin}/api/assets`, {
    method: "POST",
    headers: { "x-cliplink-token": session.token },
    body: form,
  });
  if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
  console.log(
    `ページ全体を登録しました。\n共有URL: ${r.headers.get("x-cliplink-share-url")}`,
  );
} finally {
  await browser.close();
}
