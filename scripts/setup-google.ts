// Googleドライブとつなぎ、接続情報をこのフォルダの .env へ保存する（npm run setup:google）。
// 事前に Google Cloud Console で「デスクトップ アプリ」のOAuthクライアントを作り、JSONをダウンロードしておく。
// このPCの127.0.0.1だけで動く接続ページを開き、JSONはそのページで選んでもらう（ブラウザ内で読んでこのPCへ送る）。
// 秘密値（client secret・refresh token・管理トークン）は画面・端末出力・コマンド引数に出さない。認可はPKCE + state。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkConnectRequest, pkcePair, randomToken } from "./cloud-lib";
import { readEnvFile, updateEnvFile } from "./env-file";
import {
  callbackProblem,
  createDriveFolder,
  driveFolderName,
  exchangeGoogleCode,
  fetchGoogleEmail,
  googleAuthUrl,
  googleRedirectUri,
  parseGoogleClientJson,
  type GoogleClient,
} from "./google-lib";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "53683" },
    "no-open": { type: "boolean", default: false },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ポートが不正です。");
const envPath = resolve(".env");
const env = { ...(await readEnvFile(envPath)), ...process.env };
const appName = (env.CLIPLINK_APP_NAME || "").trim() || "Cliplink";
const origin = `http://127.0.0.1:${port}`;
const redirectUri = googleRedirectUri(port);
const session = randomToken(16);
let client: GoogleClient | null = null;
let pending: { state: string; verifier: string } | null = null;
let linked: { refreshToken: string; folderId: string; email: string } | null = null;
let notice = "";
let saved = false;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const style = `body{margin:0;background:#f7f8f4;color:#263b31;font:15px/1.8 system-ui,"Yu Gothic UI","Hiragino Sans",sans-serif}main{max-width:620px;margin:40px auto;padding:0 20px}section{background:#fff;border:1px solid #dce2d8;border-radius:10px;padding:20px 22px;margin:18px 0}h1{font-size:22px}h2{font-size:15px;margin:0 0 8px}label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #dce2d8;border-radius:6px;font:inherit}button{margin-top:12px;background:#254f3c;color:#fff;border:0;border-radius:7px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.4}p.note{font-size:12px;color:#6f7b69}#msg,#who{white-space:pre-wrap}.ok{color:#2f6b3f}.err{color:#a7563e}`;
const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(appName)} · Googleドライブ接続</title>
<style>${style}</style>
<main><h1>${esc(appName)}とGoogleドライブをつなぐ</h1><p class="note">このページはこのPCの中だけで動いています。選んだJSONと接続情報はGoogleとこのフォルダの .env にだけ送られ、画面やチャットには残りません。</p>
<section><h2>1. ダウンロードしたJSONを選ぶ</h2><p class="note">Google Cloud Console の「認証情報」で作った『デスクトップ アプリ』のクライアントのJSON（client_secret_….json）です。</p><label for="f">JSONファイル</label><input id="f" type="file" accept=".json,application/json"></section>
<section><h2>2. Googleで許可する</h2><p class="note">Googleの画面に切り替わります。画像を保存したいGoogleアカウントを選び、「続行」を押してください。「このアプリは確認されていません」と出たら「続行」で進めます。終わるとこのページに戻ります。</p><button id="start" disabled>Googleの許可画面を開く</button></section>
<section><h2>3. 保存</h2><p id="who" class="note">許可が済むと、つないだGoogleアカウントと保存用フォルダ（${esc(driveFolderName(appName))}）をここに表示します。</p><button id="save" disabled>このアカウントで保存</button></section>
<p id="msg"></p></main>
<script>
const s=${JSON.stringify(session)};const $=(i)=>document.getElementById(i);const msg=(t,ok)=>{$("msg").textContent=t;$("msg").className=ok?"ok":"err"};
const post=async(p,b)=>{const r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...b,s})});const d=await r.json();if(!r.ok)throw new Error(d.error);return d};
const show=(d)=>{$("start").disabled=!d.client;if(d.linked){$("who").textContent="接続したGoogleアカウント: "+(d.email||"（表示できませんでした）")+"\\n保存用フォルダ「"+d.folder+"」をマイドライブに作りました。（違うアカウントなら保存せずにこのタブを閉じてください）";$("save").disabled=d.saved}if(d.saved)msg("保存しました。このタブは閉じてかまいません。Claude Codeに「保存した」と伝えてください。",true);else if(d.notice)msg(d.notice,!!d.linked)};
$("f").onchange=async()=>{const file=$("f").files[0];if(!file)return;try{if(file.size>20000)throw new Error("ファイルが大きすぎます。ダウンロードしたJSONを選んでください。");show(await post("/client",{json:await file.text()}));msg("JSONを読み込みました。2に進んでください。",true)}catch(e){msg(e.message)}finally{$("f").value=""}};
$("start").onclick=async()=>{$("start").disabled=true;try{const d=await post("/start",{});location.href=d.url}catch(e){$("start").disabled=false;msg(e.message)}};
$("save").onclick=async()=>{$("save").disabled=true;try{show(await post("/save",{}))}catch(e){$("save").disabled=false;msg(e.message)}};
post("/status",{}).then(show).catch((e)=>msg(e.message));
</script></html>`;

async function readJson(req: import("node:http").IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 50_000) throw new Error("送られた内容が大きすぎます。");
  }
  return JSON.parse(body || "{}") as Record<string, string>;
}

const status = () => ({
  client: !!client,
  linked: !!linked,
  email: linked?.email ?? "",
  folder: driveFolderName(appName),
  notice,
  saved,
});

async function finishLink(code: string) {
  const { accessToken, refreshToken } = await exchangeGoogleCode({ ...client!, code, verifier: pending!.verifier, redirectUri });
  const email = await fetchGoogleEmail(accessToken);
  const folderId = await createDriveFolder(accessToken, driveFolderName(appName));
  linked = { refreshToken, folderId, email };
}

const server = createServer(async (req, res) => {
  const headers = (type: string) => ({
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, headers(type));
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  try {
    const url = new URL(req.url || "/", origin);
    // Googleの許可画面からの戻り（GETのトップレベル遷移）。セッションの代わりに state で照合し、元のページへ戻す。
    if (req.method === "GET" && url.pathname === "/callback") {
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: "接続先が不正です。" });
      const problem = callbackProblem(url.searchParams, pending?.state ?? "");
      if (!problem && client && pending) {
        try {
          await finishLink(url.searchParams.get("code")!);
          notice = "Googleドライブに接続しました。内容を確かめて3の「保存」を押してください。";
        } catch (e) {
          notice = (e as Error).message;
        }
      } else notice = problem ?? "最初からやり直してください。";
      pending = null; // state と verifier は1回限り
      res.writeHead(303, { ...headers("text/plain"), Location: `/?s=${session}` });
      return res.end();
    }
    const isPage = req.method === "GET" && url.pathname === "/";
    const body = isPage || req.method !== "POST" ? {} : await readJson(req);
    const denied = checkConnectRequest(
      {
        host: req.headers.host,
        origin: req.headers.origin,
        method: req.method,
        path: url.pathname,
        s: isPage ? url.searchParams.get("s") : body.s,
      },
      port,
      session,
    );
    if (denied) return send(403, { error: denied });
    if (isPage) return send(200, page, "text/html");
    if (url.pathname === "/status") return send(200, status());
    if (url.pathname === "/client") {
      client = parseGoogleClientJson(body.json || "");
      linked = null;
      notice = "";
      return send(200, status());
    }
    if (url.pathname === "/start") {
      if (!client) return send(400, { error: "先に1でJSONを選んでください。" });
      const pkce = pkcePair();
      pending = { state: randomToken(24), verifier: pkce.verifier };
      linked = null;
      notice = "";
      return send(200, {
        url: googleAuthUrl({ clientId: client.clientId, redirectUri, challenge: pkce.challenge, state: pending.state }),
      });
    }
    if (url.pathname === "/save") {
      if (!client || !linked) return send(400, { error: "先に2を行ってください。" });
      const current = await readEnvFile(envPath);
      const updates: Record<string, string> = {
        GOOGLE_CLIENT_ID: client.clientId,
        GOOGLE_CLIENT_SECRET: client.clientSecret,
        GOOGLE_REFRESH_TOKEN: linked.refreshToken,
        GOOGLE_DRIVE_FOLDER_ID: linked.folderId,
        CLIPLINK_STORAGE_PROVIDER: "gdrive",
      };
      if ((current.CLIPLINK_ADMIN_TOKEN || "").length < 32) updates.CLIPLINK_ADMIN_TOKEN = randomToken(32);
      await updateEnvFile(envPath, updates);
      saved = true;
      console.log(`.env に保存しました（${Object.keys(updates).join(", ")}）。値は表示しません。`);
      console.log("続けて npm run setup:cloudflare を実行すると、共有ページもGoogleドライブを使うようになります。");
      send(200, status());
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    send(404, { error: "見つかりません。" });
  } catch (e) {
    send(400, { error: (e as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  const url = `${origin}/?s=${session}`;
  console.log(`Googleドライブ接続ページ: ${url}\n（ブラウザで開きます。15分で自動終了します）`);
  if (values["no-open"]) return;
  const opener =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  // 開けない場合は、上に表示したURLを手で開いてもらう。
  spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true })
    .on("error", () => console.log("ブラウザを自動で開けませんでした。上のURLを開いてください。"))
    .unref();
});
server.on("error", (e) => {
  console.error(
    (e as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `ポート ${port} が使用中です。前の接続ページを閉じるか、npm run setup:google -- --port 53690 のように別の番号で実行してください。`
      : (e as Error).message,
  );
  process.exit(1);
});
setTimeout(() => {
  console.log("時間切れで終了しました。もう一度実行してください。");
  process.exit(1);
}, 15 * 60 * 1000).unref();
