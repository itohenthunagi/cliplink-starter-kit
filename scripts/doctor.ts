// 環境と設定の点検（npm run kit:doctor）。何も変更しない。秘密値は「設定済み/未設定」だけを表示する。
import { access, constants, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readEnvFile } from "./env-file";
import {
  D1_PLACEHOLDER,
  STORAGE_PROVIDER_INFO,
  STORAGE_PROVIDERS,
  parseStorageProvider,
  readD1Id,
  readR2BucketName,
  storageLabel,
} from "./setup-lib";

const ok = (t: string) => console.log(`  ✓ ${t}`);
const warn = (t: string) => console.log(`  ! ${t}`);
const ng = (t: string) => console.log(`  × ${t}`);
let failures = 0;
const fail = (t: string) => {
  failures++;
  ng(t);
};
const exists = (p: string) => access(p).then(() => true, () => false);
const syncPattern = /[\\/](Dropbox[^\\/]*|OneDrive[^\\/]*|Google ?Drive|マイドライブ|My Drive|iCloud ?Drive|Mobile Documents|CloudStorage)([\\/]|$)/i;

const fileEnv = await readEnvFile(".env");
const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };

console.log("■ 実行環境");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node}（22.13以上が必要です）`);
ok(`OS: ${process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform}`);
if (await exists("node_modules")) ok("部品（node_modules）: インストール済み");
else fail("部品が未インストールです。npm ci を実行してください。");
if (await exists("dist/index.html")) ok("画面（dist）: 組み立て済み");
else warn("画面が未組み立てです。npm run build を実行してください。");
if (syncPattern.test(process.cwd()))
  warn("このフォルダが同期フォルダ（Dropbox/OneDrive/Google Drive/iCloud）の中にあります。同期の外へ移すことをおすすめします。");
else ok("このフォルダは同期フォルダの外にあります");

console.log("■ 設定");
console.log(`  .env: ${Object.keys(fileEnv).length ? "あり" : "なし（既定値で動きます）"}`);
console.log(`  表示名: ${(env.CLIPLINK_APP_NAME || "").trim() || "Cliplink（既定）"}`);
const port = Number(env.PORT || 4317);
console.log(`  管理画面: http://127.0.0.1:${port}`);
const stateDir = resolve(env.CLIPLINK_STATE_DIR || ".cliplink");
if (syncPattern.test(stateDir)) fail(`台帳の場所が同期フォルダの中です（CLIPLINK_STATE_DIR）。同期の外にしてください。`);
else ok(`台帳の場所: ${stateDir}`);
let savedRoot = "";
try {
  savedRoot = (JSON.parse(await readFile(resolve(stateDir, "settings.json"), "utf8")) as { root?: string }).root ?? "";
} catch {
  /* 画面での設定なし */
}
const root = resolve(savedRoot || env.CLIPLINK_STORAGE_ROOT || resolve(stateDir, "library"));
const rootFrom = savedRoot ? "管理画面の設定" : env.CLIPLINK_STORAGE_ROOT ? ".env・環境変数" : "既定";
try {
  if (!(await stat(root)).isDirectory()) throw new Error();
  await access(root, constants.W_OK);
  ok(`画像の保存先（${rootFrom}）: ${root}`);
} catch {
  (rootFrom === "既定" ? warn : fail)(`画像の保存先（${rootFrom}）が無いか書き込めません: ${root}${rootFrom === "既定" ? "（初回起動時に作られます）" : ""}`);
}

console.log("■ 共有モード");
const cloud = env.CLIPLINK_MODE === "cloud";
const provider = parseStorageProvider(env.CLIPLINK_STORAGE_PROVIDER);
const label = provider ? storageLabel(provider) : "不明";
console.log(`  モード: ${cloud ? `共有モード（${label} + Cloudflare）` : "自分用（ローカル確認モード）"}`);
if (provider) console.log(`  画像の保管先（CLIPLINK_STORAGE_PROVIDER）: ${label}`);
else fail(`CLIPLINK_STORAGE_PROVIDER は ${STORAGE_PROVIDERS.join(" / ")} のどれかにしてください（今の値: ${env.CLIPLINK_STORAGE_PROVIDER}）。`);
// 選んだ保管先が使う接続情報だけを求める（R2はCloudflareだけで完結するため、Dropboxのキーは要らない）。
const secretKeys = [...(provider ? STORAGE_PROVIDER_INFO[provider].localEnv : []), "CLIPLINK_ADMIN_TOKEN"];
for (const k of secretKeys) console.log(`  ${k}: ${env[k] ? "設定済み" : "未設定"}`);
console.log(`  CLIPLINK_CLOUDFLARE_PROJECT: ${env.CLIPLINK_CLOUDFLARE_PROJECT || "未設定"}`);
console.log(`  CLIPLINK_GATEWAY_URL: ${env.CLIPLINK_GATEWAY_URL || "未設定"}`);
const rootConfig = await readFile("wrangler.jsonc", "utf8");
const d1 = readD1Id(rootConfig);
console.log(`  台帳（D1）: ${!d1 || d1 === D1_PLACEHOLDER ? "未作成" : "作成済み"}`);
if (provider === "r2") {
  const bucket = readR2BucketName(rootConfig);
  console.log(`  R2バケット: ${bucket ? `設定済み（${bucket}）` : "未作成（npm run setup:cloudflare で作成します）"}`);
  if (cloud && !bucket) fail("保管先がR2ですが、wrangler.jsonc に R2バケットがありません。npm run setup:cloudflare を実行してください。");
}
if (cloud) {
  for (const k of [...secretKeys, "CLIPLINK_GATEWAY_URL"]) if (!env[k]) fail(`共有モードには ${k} が必要です。`);
  if (env.CLIPLINK_GATEWAY_URL && !/^https:\/\/[^/]+$/.test(env.CLIPLINK_GATEWAY_URL))
    fail("CLIPLINK_GATEWAY_URL は https:// で始まる末尾パスなしのURLにしてください。");
}

console.log("■ ショートカット");
if (process.platform === "win32") {
  const trigger = resolve(process.env.LOCALAPPDATA || "", "Cliplink", "Trigger", "CliplinkTrigger.exe");
  console.log(
    (await exists(trigger))
      ? "  Windows常駐ショートカット: 導入済み"
      : "  Windows常駐ショートカット: 未導入（scripts\\windows-install-trigger.ps1 で導入できます）",
  );
} else {
  console.log("  管理画面を開いている時は ⌘+Shift+S で撮影、⌘+V で貼り付け登録ができます。");
}

console.log(failures ? `\n要対応が ${failures} 件あります（× の行）。` : "\n問題は見つかりませんでした。");
process.exitCode = failures ? 1 : 0;
