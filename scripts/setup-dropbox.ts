// Dropboxとつなぎ、接続情報をこのフォルダの .env へ保存する（npm run setup:dropbox）。
// このPCの127.0.0.1だけで動く接続ページを開き、App keyと許可コードはそのページに入力してもらう。
// 秘密値（refresh token・管理トークン）は画面・端末出力・コマンド引数に出さない。認可はPKCE（App secret不要）。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkConnectRequest, exchangeDropboxCode, pkcePair, randomToken } from "./cloud-lib";
import { readEnvFile, updateEnvFile } from "./env-file";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "53682" },
    "no-open": { type: "boolean", default: false },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ポートが不正です。");
const envPath = resolve(".env");
const env = { ...(await readEnvFile(envPath)), ...process.env };
const appName = (env.CLIPLINK_APP_NAME || "").trim() || "Cliplink";
const origin = `http://127.0.0.1:${port}`;
const session = randomToken(16);
const pkce = pkcePair();
let appKey = "";
let linked: { refreshToken: string; email: string } | null = null;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(appName)} · Dropbox接続</title>
<style>body{margin:0;background:#f7f8f4;color:#263b31;font:15px/1.8 system-ui,"Yu Gothic UI","Hiragino Sans",sans-serif}main{max-width:620px;margin:40px auto;padding:0 20px}section{background:#fff;border:1px solid #dce2d8;border-radius:10px;padding:20px 22px;margin:18px 0}h1{font-size:22px}h2{font-size:15px;margin:0 0 8px}label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #dce2d8;border-radius:6px;font:inherit}button{margin-top:12px;background:#254f3c;color:#fff;border:0;border-radius:7px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.4}p.note{font-size:12px;color:#6f7b69}#msg{white-space:pre-wrap}.ok{color:#2f6b3f}.err{color:#a7563e}</style>
<main><h1>${esc(appName)}とDropboxをつなぐ</h1><p class="note">このページはこのPCの中だけで動いています。入力した値はDropboxとこのフォルダの .env にだけ送られ、画面やチャットには残りません。</p>
<section><h2>1. Dropboxアプリの App key</h2><label for="k">App key（Dropbox App Console の Settings タブ）</label><input id="k" autocomplete="off" spellcheck="false"><button id="start">Dropboxの許可画面を開く</button></section>
<section><h2>2. 許可コード</h2><p class="note">別タブで「許可」を押すと、コードが表示されます。コピーしてここに貼り付けてください。</p><label for="c">許可コード</label><input id="c" type="password" autocomplete="off"><button id="link" disabled>Dropboxに接続</button></section>
<section><h2>3. 保存</h2><p id="who" class="note">接続後、つないだDropboxアカウントをここに表示します。</p><button id="save" disabled>このアカウントで保存</button></section>
<p id="msg"></p></main>
<script>
const s=${JSON.stringify(session)};const $=(i)=>document.getElementById(i);const msg=(t,ok)=>{$("msg").textContent=t;$("msg").className=ok?"ok":"err"};
const post=async(p,b)=>{const r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...b,s})});const d=await r.json();if(!r.ok)throw new Error(d.error);return d};
$("start").onclick=async()=>{try{const d=await post("/start",{appKey:$("k").value.trim()});window.open(d.url,"_blank","noopener");$("link").disabled=false;msg("許可画面を開きました。許可後に表示されるコードを2に貼り付けてください。",true)}catch(e){msg(e.message)}};
$("link").onclick=async()=>{$("link").disabled=true;try{const d=await post("/link",{code:$("c").value.trim()});$("c").value="";$("who").textContent="接続したDropbox: "+d.email+"（違うアカウントなら保存せずにこのタブを閉じてください）";$("save").disabled=false;msg("",true)}catch(e){$("link").disabled=false;msg(e.message)}};
$("save").onclick=async()=>{$("save").disabled=true;try{await post("/save",{});msg("保存しました。このタブは閉じてかまいません。Claude Codeに「保存した」と伝えてください。",true)}catch(e){$("save").disabled=false;msg(e.message)}};
</script></html>`;

async function readJson(req: import("node:http").IncomingMessage) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error("too large");
  }
  return JSON.parse(body || "{}") as Record<string, string>;
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  try {
    const url = new URL(req.url || "/", origin);
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
    if (url.pathname === "/start") {
      if (!/^[a-z0-9]{8,32}$/i.test(body.appKey || ""))
        return send(400, { error: "App keyを確認してください（英数字）。" });
      appKey = body.appKey;
      const auth = new URL("https://www.dropbox.com/oauth2/authorize");
      auth.search = new URLSearchParams({
        client_id: appKey,
        response_type: "code",
        token_access_type: "offline",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      }).toString();
      return send(200, { url: auth.href });
    }
    if (url.pathname === "/link") {
      if (!appKey) return send(400, { error: "先に1を行ってください。" });
      if (!/^[\w-]{10,200}$/.test(body.code || ""))
        return send(400, { error: "許可コードを確認してください。" });
      linked = await exchangeDropboxCode(appKey, pkce.verifier, body.code);
      return send(200, { email: linked.email });
    }
    if (url.pathname === "/save") {
      if (!linked) return send(400, { error: "先に2を行ってください。" });
      const current = await readEnvFile(envPath);
      const updates: Record<string, string> = {
        DROPBOX_APP_KEY: appKey,
        DROPBOX_REFRESH_TOKEN: linked.refreshToken,
      };
      if ((current.CLIPLINK_ADMIN_TOKEN || "").length < 32) updates.CLIPLINK_ADMIN_TOKEN = randomToken(32);
      if (!current.DROPBOX_ROOT) updates.DROPBOX_ROOT = "/ScreenShare";
      await updateEnvFile(envPath, updates);
      console.log(`.env に保存しました（${Object.keys(updates).join(", ")}）。値は表示しません。`);
      send(200, { ok: true });
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
  console.log(`Dropbox接続ページ: ${url}\n（ブラウザで開きます。15分で自動終了します）`);
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
setTimeout(() => {
  console.log("時間切れで終了しました。もう一度実行してください。");
  process.exit(1);
}, 15 * 60 * 1000).unref();
