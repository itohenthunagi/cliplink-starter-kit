// setup:google（Googleドライブ接続）の純関数とGoogleとのやり取り。fetch は差し替えてテストする。
// 値（client secret・refresh token）は戻り値で返すだけで、画面・端末には出さない。
import { timingSafeEqual } from "node:crypto";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

// Google Cloud Console でダウンロードした OAuthクライアントのJSON（client_secret_….json）を読む。
export function parseGoogleClientJson(text: string): GoogleClient {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSONとして読めませんでした。Google Cloud でダウンロードした client_secret_….json を選んでください。");
  }
  const root = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (root.web && !root.installed)
    throw new Error(
      "このJSONは「ウェブ アプリケーション」用です。Google Cloud でクライアントの種類を『デスクトップ アプリ』で作り直してください。",
    );
  const installed = root.installed as Record<string, unknown> | undefined;
  if (!installed || typeof installed !== "object")
    throw new Error(
      "OAuthクライアントのJSONではありません。Google Cloud の「認証情報」で作った『デスクトップ アプリ』のJSONを選んでください。",
    );
  const clientId = String(installed.client_id ?? "").trim();
  const clientSecret = String(installed.client_secret ?? "").trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || !/^[\w-]{8,200}$/.test(clientSecret))
    throw new Error("JSONにクライアントIDかシークレットが見つかりません。ダウンロードし直したJSONを選んでください。");
  return { clientId, clientSecret };
}

export function googleRedirectUri(port: number) {
  return `http://127.0.0.1:${port}/callback`;
}

// 許可画面のURL。offline + consent で refresh token を必ず受け取り、PKCE（S256）と state で取り違えを防ぐ。
export function googleAuthUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return url.href;
}

// /callback の state を照合する（空・長さ違いは不一致）。
export function stateMatches(expected: string, actual: string | null | undefined) {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

// /callback の結果を、画面に出す文に直す。問題なければ null。
export function callbackProblem(q: URLSearchParams, expectedState: string) {
  if (!expectedState) return "先に「Googleの許可画面を開く」を押してください。";
  if (!stateMatches(expectedState, q.get("state")))
    return "許可画面からの戻りを確認できませんでした。もう一度「Googleの許可画面を開く」を押してください。";
  if (q.get("error") === "access_denied")
    return "許可されませんでした。もう一度「Googleの許可画面を開く」を押し、「続行」を選んでください。";
  if (q.get("error")) return "Googleの許可画面でエラーになりました。もう一度やり直してください。";
  if (!/^[\w./-]{10,512}$/.test(q.get("code") ?? "")) return "許可コードが受け取れませんでした。もう一度やり直してください。";
  return null;
}

type Fetcher = typeof fetch;
const defaultFetch: Fetcher = (input, init) => fetch(input, init);

// 許可コードを refresh token へ交換する（デスクトップ アプリはPKCEでもclient secretが要る）。
export async function exchangeGoogleCode(
  p: GoogleClient & { code: string; verifier: string; redirectUri: string },
  fetcher: Fetcher = defaultFetch,
) {
  const r = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
    }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  if (!r?.ok)
    throw new Error("許可コードを確認できませんでした。JSONが正しいか確かめて、もう一度「Googleの許可画面を開く」からやり直してください。");
  const t = (await r.json()) as { access_token?: string; refresh_token?: string };
  if (!t.refresh_token || !t.access_token)
    throw new Error(
      "長期利用のトークンが返りませんでした。https://myaccount.google.com/connections でこのアプリへのアクセスを削除してから、もう一度やり直してください。",
    );
  return { accessToken: t.access_token, refreshToken: t.refresh_token };
}

// つないだアカウントのメールアドレス。取れなければ空文字（表示を省くだけ）。
export async function fetchGoogleEmail(accessToken: string, fetcher: Fetcher = defaultFetch) {
  try {
    const r = await fetcher("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return "";
    const m = (await r.json()) as { user?: { emailAddress?: string } };
    return m.user?.emailAddress ?? "";
  } catch {
    return "";
  }
}

export const driveFolderName = (appName: string) => `${appName.trim() || "Cliplink"} images`;

// 画像の保存用フォルダをマイドライブ直下に作り、file id を返す。
export async function createDriveFolder(accessToken: string, name: string, fetcher: Fetcher = defaultFetch) {
  const r = await fetcher("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  const id = r?.ok ? ((await r.json()) as { id?: string }).id : undefined;
  if (!id || !/^[A-Za-z0-9_-]{10,}$/.test(id))
    throw new Error(
      "Googleドライブに保存用フォルダを作れませんでした。Google Cloud で「Google Drive API」を有効にしてから、もう一度やり直してください。",
    );
  return id;
}
