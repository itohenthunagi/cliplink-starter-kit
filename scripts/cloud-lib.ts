import { createHash, randomBytes } from "node:crypto";

export const randomToken = (bytes: number) => randomBytes(bytes).toString("base64url");

// RFC 7636 S256: challenge = BASE64URL(SHA256(verifier))。verifierは43〜128文字。
export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// 接続ページ(127.0.0.1限定)への要求を検査する。戻り値はエラー文。問題なければnull。
// ページ表示はターミナルに出したURLのsだけ、POSTは同一オリジンかつ同じsだけを受け付ける。
export function checkConnectRequest(
  req: { host?: string; origin?: string; method?: string; path: string; s?: string | null },
  port: number,
  session: string,
) {
  if (req.host !== `127.0.0.1:${port}`) return "接続先が不正です。";
  if (req.method === "GET" && req.path === "/")
    return req.s === session ? null : "ターミナルに表示されたURLを開いてください。";
  if (req.method !== "POST" || (req.origin && req.origin !== `http://127.0.0.1:${port}`))
    return "外部からの操作はできません。";
  return req.s === session ? null : "ページを開き直してください。";
}

// Dropboxの許可コード（PKCE）をrefresh tokenへ交換し、つないだアカウントのメールを返す。
export async function exchangeDropboxCode(appKey: string, verifier: string, code: string) {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: appKey,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok)
    throw new Error("許可コードを確認できませんでした。1からやり直してください（コードは1回しか使えません）。");
  const t = (await r.json()) as { access_token: string; refresh_token?: string };
  if (!t.refresh_token)
    throw new Error("長期利用のトークンが返りませんでした。1からやり直してください。");
  const who = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { Authorization: `Bearer ${t.access_token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!who.ok) throw new Error("Dropboxのアカウントを確認できませんでした。");
  const account = (await who.json()) as { email: string };
  return { refreshToken: t.refresh_token, email: account.email };
}
