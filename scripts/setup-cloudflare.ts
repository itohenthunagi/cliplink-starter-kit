// 共有モードの公開を一度に行う（npm run setup:cloudflare）。
// D1（台帳）とPages（共有ページ）を作り、接続情報をPagesへ設定して公開し、応答を確かめてから .env を共有モードにする。
// 画像の保管先は .env の CLIPLINK_STORAGE_PROVIDER（dropbox＝既定 / r2 / gdrive）。r2 ならR2バケットも作り、Dropboxは使わない。
// 途中で失敗したらその段で止まる。やり直すと、済んだ段（D1・Pagesプロジェクト）は再利用する。
// --check は何も変更せず準備状況だけを表示する。秘密値は画面・引数に出さず、wranglerの標準入力へ渡す。
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomToken } from "./cloud-lib";
import { readEnvFile, updateEnvFile } from "./env-file";
import {
  D1_PLACEHOLDER,
  parseD1Id,
  parsePagesHost,
  parseStorageProvider,
  r2BucketExists,
  r2BucketName,
  r2NotEnabled,
  readD1Id,
  readD1Name,
  readR2BucketName,
  setAppNameVar,
  setD1,
  setR2Bucket,
  setVar,
  STORAGE_PROVIDER_INFO,
  STORAGE_PROVIDERS,
  storageLabel,
  validProjectName,
} from "./setup-lib";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const envPath = resolve(".env");
const rootConfig = resolve("wrangler.jsonc");
const pagesDir = resolve("pages");
const pagesConfig = resolve(pagesDir, "wrangler.jsonc");
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");

const run = (args: string[], opts: { cwd?: string; input?: string } = {}) => {
  const r = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    timeout: 600000,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};
const stop = (step: string, detail = "", hint = "上の表示をAIに伝えてください。"): never => {
  if (detail) console.error(detail.trim().slice(-1500));
  console.error(`\n${step}で止まりました。${hint}`);
  process.exit(1);
};

const env = { ...(await readEnvFile(envPath)), ...pick(process.env) };
function pick(e: NodeJS.ProcessEnv) {
  const keys = ["CLIPLINK_CLOUDFLARE_PROJECT", "CLIPLINK_APP_NAME", "CLIPLINK_STORAGE_PROVIDER"];
  return Object.fromEntries(keys.filter((k) => e[k]).map((k) => [k, e[k]!]));
}
const project = (env.CLIPLINK_CLOUDFLARE_PROJECT || "").trim();
const appName = (env.CLIPLINK_APP_NAME || "").trim() || "Cliplink";
const provider = parseStorageProvider(env.CLIPLINK_STORAGE_PROVIDER);
const info = provider ? STORAGE_PROVIDER_INFO[provider] : undefined;
const missingLocal = info ? info.localEnv.filter((k) => !env[k]) : [];
const r2 = provider === "r2";
const R2_HINT =
  "CloudflareのダッシュボードでR2の利用を開始（支払い方法の登録が必要。月10GBまで無料）してから、もう一度実行してください。";
const TOTAL = 10;
const step = (n: number, text: string) => console.log(`${n}/${TOTAL} ${text}`);

// ---- 0. 事前確認 ----
step(0, "事前確認をしています…");
const problems: string[] = [];
if (!provider)
  problems.push(
    `.env の CLIPLINK_STORAGE_PROVIDER は ${STORAGE_PROVIDERS.join(" / ")} のどれかにしてください（空欄なら dropbox）。`,
  );
if (info && missingLocal.length)
  problems.push(info.setupHint || `${info.label}の接続情報（${missingLocal.join(", ")}）がありません。`);
if (!validProjectName(project))
  problems.push(
    ".env の CLIPLINK_CLOUDFLARE_PROJECT に、共有URLの名前（英小文字・数字・ハイフン、2〜58文字）を書いてください。",
  );
const who = run(["whoami"]);
const loggedIn = who.ok && !/not authenticated|You are not logged in/i.test(who.out);
if (!loggedIn) problems.push("Cloudflareにログインしていません。npx wrangler login を実行し、ブラウザで Allow を押してください。");
const rootText = await readFile(rootConfig, "utf8");
const pagesText = await readFile(pagesConfig, "utf8");
if (!/"APP_NAME"\s*:/.test(pagesText)) problems.push("pages/wrangler.jsonc に vars.APP_NAME がありません。");
const d1Id = readD1Id(rootText);
const d1Ready = !!d1Id && d1Id !== D1_PLACEHOLDER;
// R2はダッシュボードでの利用開始が要る。一覧を読むだけで確かめる（何も作らない）。
let r2Enabled: boolean | undefined;
if (r2 && loggedIn) {
  const listed = run(["r2", "bucket", "list"]);
  r2Enabled = listed.ok || !r2NotEnabled(listed.out);
  if (!r2Enabled) problems.push(`R2の利用がまだ始まっていません。${R2_HINT}`);
}
const configuredBucket = readR2BucketName(rootText);
const bucketName = r2 ? configuredBucket || r2BucketName(project) : "";

console.log(`  画像の保管先: ${provider ? storageLabel(provider) : `不正な値（${env.CLIPLINK_STORAGE_PROVIDER}）`}`);
if (info?.localEnv.length) console.log(`  ${info.label}の接続情報: ${missingLocal.length ? "なし" : "あり"}`);
if (r2) {
  console.log(`  R2の利用開始: ${r2Enabled === undefined ? "（ログイン後に確認します）" : r2Enabled ? "済み" : "未"}`);
  console.log(
    `  R2バケット: ${configuredBucket ? `設定済み（${bucketName}、再利用します）` : validProjectName(project) ? `これから作成します（${bucketName}）` : "（共有URLの名前が決まってから作成します）"}`,
  );
}
console.log(`  Cloudflareログイン: ${loggedIn ? "済み" : "未"}`);
console.log(`  共有URLの名前: ${project || "(未設定)"}${project && !validProjectName(project) ? "（形式が不正）" : ""}`);
console.log(`  台帳（D1）: ${d1Ready ? "作成済み（再利用します）" : "これから作成します"}`);
console.log(`  表示名: ${appName}`);
if (problems.length) {
  for (const p of problems) console.error(`  × ${p}`);
  stop("事前確認", "", "上の × を解決してから、もう一度実行してください。");
}
if (values.check) {
  console.log(`\n準備はできています（画像の保管先: ${storageLabel(provider!)}）。npm run setup:cloudflare で https://${project}.pages.dev（使用中なら末尾にランダムな文字が付きます）に公開します。`);
  process.exit(0);
}

// ---- 1. 管理用の合言葉 ----
step(1, "管理用の合言葉を確認しています…");
if ((env.CLIPLINK_ADMIN_TOKEN || "").length < 32) {
  await updateEnvFile(envPath, { CLIPLINK_ADMIN_TOKEN: randomToken(32) });
  console.log("  新しく作成して .env に保存しました（値は表示しません）。");
}
const secrets = await readEnvFile(envPath);

// ---- 2. D1 ----
step(2, "台帳（D1データベース）を用意しています…");
let dbName = readD1Name(rootText) || project;
let dbId = d1Ready ? d1Id! : "";
if (!dbId) {
  dbName = project;
  const created = run(["d1", "create", dbName]);
  dbId = parseD1Id(created.out) ?? "";
  if (!dbId && /already exists/i.test(created.out)) {
    const list = run(["d1", "list", "--json"]);
    try {
      const rows = JSON.parse(list.out.slice(list.out.indexOf("["))) as { name: string; uuid: string }[];
      dbId = rows.find((r) => r.name === dbName)?.uuid ?? "";
    } catch {
      /* 下で止める */
    }
  }
  if (!dbId) stop("D1の作成", created.out);
  await writeFile(rootConfig, setD1(rootText, dbId, dbName));
  await writeFile(pagesConfig, setD1(await readFile(pagesConfig, "utf8"), dbId, dbName));
  console.log(`  D1「${dbName}」を作成し、設定ファイルに書きました。`);
}

// ---- 3. マイグレーション ----
step(3, "台帳の表を作っています…");
const migrated = run(["d1", "migrations", "apply", dbName, "--remote"]);
if (!migrated.ok) stop("台帳の表の作成", migrated.out);

// ---- 4. R2（保管先がR2の時だけ） ----
step(4, r2 ? "画像の保管場所（R2バケット）を用意しています…" : `画像の保管先は${storageLabel(provider!)}です（R2の用意は省きます）。`);
if (r2) {
  const made = run(["r2", "bucket", "create", bucketName]);
  if (!made.ok) {
    if (r2NotEnabled(made.out)) stop("R2バケットの作成", made.out, R2_HINT);
    if (!r2BucketExists(made.out)) stop("R2バケットの作成", made.out);
    console.log(`  R2バケット「${bucketName}」は作成済みのため再利用します。`);
  } else console.log(`  R2バケット「${bucketName}」を作成しました。`);
  await writeFile(rootConfig, setR2Bucket(await readFile(rootConfig, "utf8"), bucketName));
  await writeFile(pagesConfig, setR2Bucket(await readFile(pagesConfig, "utf8"), bucketName));
  console.log("  設定ファイルにR2バケットを書きました。");
}

// ---- 4. Pagesプロジェクト ----
step(5, "共有ページの置き場所（Pagesプロジェクト）を用意しています…");
// --force: 新しいwranglerが別方式（Workers側）へ委譲してURLがpages.devにならないのを避け、従来のPagesで作る。
const created = run(["pages", "project", "create", project, "--production-branch", "main", "--force"], { cwd: pagesDir });
if (!created.ok && !/already exists|8000002/i.test(created.out)) stop("Pagesプロジェクトの作成", created.out);
let host = parsePagesHost(created.out);
if (!host) host = parsePagesHost(run(["pages", "project", "list"], { cwd: pagesDir }).out, project);
if (!host) stop("公開URLの読み取り", created.out);
const url = `https://${host}`;
console.log(`  公開URLは ${url} です。`);

// ---- 5. 接続情報 ----
step(6, "接続情報を共有ページ側に設定しています…");
// 送るのは合言葉と、選んだ保管先が使う接続情報だけ（R2はbindingで渡すため秘密値なし）。
const pairs: [string, string | undefined][] = [
  ["ADMIN_TOKEN", secrets.CLIPLINK_ADMIN_TOKEN],
  ...info!.pagesSecrets.map((k): [string, string | undefined] => [k, secrets[k]]),
];
for (const [name, value] of pairs) {
  if (!value) continue;
  const r = run(["pages", "secret", "put", name, "--project-name", project], { cwd: pagesDir, input: value });
  if (!r.ok) stop(`${name} の設定`, r.out.replaceAll(value, "***"));
  console.log(`  ${name} を設定しました。`);
}

// ---- 6. 表示名 ----
step(7, "表示名と画像の保管先を設定しています…");
await writeFile(
  pagesConfig,
  setVar(setAppNameVar(await readFile(pagesConfig, "utf8"), appName), "STORAGE_PROVIDER", provider!),
);

// ---- 7. 組み立てと公開 ----
step(8, "プログラムを組み立てて公開しています…");
const build = run(["deploy", "--dry-run", "--outdir", "pages/dist/_worker.js"]);
if (!build.ok) stop("組み立て", build.out);
const deploy = run(
  ["pages", "deploy", "./dist", "--project-name", project, "--branch", "main", "--commit-dirty=true"],
  { cwd: pagesDir },
);
if (!deploy.ok) stop("公開", deploy.out);

// ---- 8. 応答確認 ----
step(9, "公開したURLが応答するのを待っています（最大3分）…");
let live = false;
for (let i = 0; i < 36 && !live; i++) {
  try {
    const r = await fetch(`${url}/s/${"0".repeat(32)}`, { signal: AbortSignal.timeout(10000) });
    live = r.status === 404 && (await r.text()).includes("共有が停止");
  } catch {
    /* 反映待ち */
  }
  if (!live) await new Promise((ok) => setTimeout(ok, 5000));
}
if (!live) stop("公開URLの応答確認", "", "数分おいてから、もう一度実行してください（済んだ段は再利用されます）。");

// ---- 9. このPCを共有モードに ----
step(10, "このPCの設定（.env）を共有モードに切り替えています…");
await updateEnvFile(envPath, {
  CLIPLINK_MODE: "cloud",
  CLIPLINK_GATEWAY_URL: url,
  CLIPLINK_STORAGE_PROVIDER: provider!,
});
console.log(`\n完了しました。共有URLは ${url}/s/… の形になります。`);
console.log(`管理画面のサーバーを再起動すると、共有モード（${storageLabel(provider!)} + Cloudflare）で動きます。`);
