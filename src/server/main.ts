import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Library } from "../core/library";
import {
  STORAGE_PROVIDERS,
  STORAGE_PROVIDER_INFO,
  parseStorageProvider,
} from "../core/storage-provider";
import { SqliteRepository, RemoteRepository } from "./repository";
import { FileStore } from "./storage";
import { createRemoteStore, missingRemoteEnv } from "./remote-store";
import { createApp } from "./app";
import { startWindowsHotkey } from "./windows-hotkey";
import { createIdleTimer } from "./idle-timer";
import { ondemandShortcutsInstalled, readTriggerHotkeys, windowsTriggerInstalled } from "./shortcut-detection";
const stateDir = resolve(process.env.CLIPLINK_STATE_DIR || ".cliplink");
await mkdir(stateDir, { recursive: true });
const configPath = resolve(stateDir, "settings.json");
let saved: { root?: string } = {};
try {
  saved = JSON.parse(await readFile(configPath, "utf8"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error("settings.jsonを読み取れません。");
}
const root = resolve(
  saved.root ||
    process.env.CLIPLINK_STORAGE_ROOT ||
    resolve(stateDir, "library"),
);
const appName = process.env.CLIPLINK_APP_NAME?.trim() || "Cliplink";
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT is invalid");
const origin = `http://127.0.0.1:${port}`;
const cloud = process.env.CLIPLINK_MODE === "cloud";
const gateway = (process.env.CLIPLINK_GATEWAY_URL || "").replace(/\/$/, "");
// 共有モードでの画像の保管先。未設定は従来どおりDropbox。r2 はCloudflareだけで完結する（Dropbox不要）。
const provider = parseStorageProvider(process.env.CLIPLINK_STORAGE_PROVIDER);
if (!provider)
  throw new Error(
    `CLIPLINK_STORAGE_PROVIDER must be one of: ${STORAGE_PROVIDERS.join(", ")}.`,
  );
if (
  cloud &&
  (!/^https:\/\//.test(gateway) ||
    !process.env.CLIPLINK_ADMIN_TOKEN ||
    missingRemoteEnv(provider, process.env).length)
)
  throw new Error(
    provider === "dropbox"
      ? "Cloud mode requires HTTPS gateway, admin token, Dropbox app key and refresh token."
      : `Cloud mode (${provider}) requires HTTPS gateway, admin token${STORAGE_PROVIDER_INFO[provider].localEnv.map((k) => `, ${k}`).join("")}.`,
  );
const repo = cloud
  ? new RemoteRepository(gateway, process.env.CLIPLINK_ADMIN_TOKEN!)
  : new SqliteRepository(resolve(stateDir, "catalog.sqlite"));
const remote = cloud
  ? createRemoteStore(provider, {
      gateway,
      adminToken: process.env.CLIPLINK_ADMIN_TOKEN!,
      env: process.env,
    })
  : undefined;
const dropboxRoot = process.env.DROPBOX_ROOT || "/ScreenShare";
if (!/^\/(?:[^/]+\/)*[^/]+$/.test(dropboxRoot) || dropboxRoot.includes(".."))
  throw new Error("DROPBOX_ROOT is invalid");
const store = new FileStore(root, remote, dropboxRoot);
const token = crypto.randomUUID();
const shareBase = cloud ? gateway : origin;
// windows-ondemand-capture.cs はCLIPLINK_HOTKEY=offを渡し常駐版のlegacy RegisterHotKeyと
// .lnk(Ctrl+Alt+S/R)が競合しないようにしているが、.lnkインストール後に手動でnpm startした場合は
// その環境変数が付かない。.lnkや新トリガー(windows-install-trigger.ps1)の実在を見て同じホットキーの
// 重複登録を避ける(いずれも未導入時は従来通りNode常駐版を使う)。
const triggerInstalled = await windowsTriggerInstalled(process.platform, process.env.LOCALAPPDATA);
const hotkey = process.platform === "win32" &&
  process.env.CLIPLINK_HOTKEY !== "off" &&
  !(await ondemandShortcutsInstalled(process.platform, process.env.APPDATA)) &&
  !triggerInstalled
  ? startWindowsHotkey(origin, token, shareBase)
  : undefined;
let idleTimer: ReturnType<typeof createIdleTimer> | undefined;
const app = createApp({
  library: new Library(repo),
  store,
  origin,
  mode: cloud ? "cloud" : "local",
  shareBase,
  appName,
  configPath,
  token,
  // 常駐トリガー導入済みならCtrl+Alt+S/Rはトリガー側が受け持つ。画面の案内に使う。
  shortcutStatus: hotkey?.status ?? (triggerInstalled ? () => "trigger" : undefined),
  shortcutKeys: triggerInstalled ? () => readTriggerHotkeys(process.env.LOCALAPPDATA) : undefined,
  onActivity: () => idleTimer?.touch(),
});
app.use("*", serveStatic({ root: "./dist" }));
app.notFound((c) => c.text("ページが見つかりません。", 404));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.log(`${appName}: ${origin} (${cloud ? "cloud" : "local preview"})`),
);
// オンデマンド起動時のみ有効化。未設定時は常駐時と同じ挙動を保つ。
const idleTimeoutMs = Number(process.env.CLIPLINK_IDLE_TIMEOUT_MS || 0);
if (idleTimeoutMs > 0) {
  idleTimer = createIdleTimer(idleTimeoutMs, () => {
    hotkey?.stop();
    server.close(() => process.exit(0));
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    idleTimer?.stop();
    hotkey?.stop();
    server.close(() => process.exit(0));
  });
