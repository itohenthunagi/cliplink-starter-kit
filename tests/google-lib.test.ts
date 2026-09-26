import { describe, expect, it, vi } from "vitest";
import {
  callbackProblem,
  createDriveFolder,
  driveFolderName,
  exchangeGoogleCode,
  fetchGoogleEmail,
  googleAuthUrl,
  googleRedirectUri,
  parseGoogleClientJson,
  stateMatches,
} from "../scripts/google-lib";
import { STORAGE_PROVIDER_INFO, parseStorageProvider } from "../src/core/storage-provider";

const installed = {
  installed: {
    client_id: "1234-abc.apps.googleusercontent.com",
    project_id: "demo",
    client_secret: "GOCSPX-testsecret",
    redirect_uris: ["http://localhost"],
  },
};

describe("setup:google の純関数", () => {
  it("デスクトップ アプリのJSONからクライアントIDとシークレットを取り出す", () => {
    expect(parseGoogleClientJson(JSON.stringify(installed))).toEqual({
      clientId: "1234-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-testsecret",
    });
  });

  it("ウェブ用・壊れたJSON・項目欠けは日本語で案内する", () => {
    expect(() => parseGoogleClientJson(JSON.stringify({ web: installed.installed }))).toThrow("『デスクトップ アプリ』で作り直して");
    expect(() => parseGoogleClientJson("{")).toThrow("JSONとして読めません");
    expect(() => parseGoogleClientJson(JSON.stringify({ type: "service_account" }))).toThrow("OAuthクライアントのJSONではありません");
    expect(() =>
      parseGoogleClientJson(JSON.stringify({ installed: { ...installed.installed, client_secret: "" } })),
    ).toThrow("見つかりません");
    expect(() =>
      parseGoogleClientJson(JSON.stringify({ installed: { ...installed.installed, client_id: "evil.example.com" } })),
    ).toThrow("見つかりません");
  });

  it("許可画面のURLに drive.file・offline・consent・PKCE(S256)・state・127.0.0.1の戻り先を付ける", () => {
    const url = new URL(
      googleAuthUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: googleRedirectUri(53683), challenge: "ch", state: "st" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid.apps.googleusercontent.com",
      redirect_uri: "http://127.0.0.1:53683/callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
    });
  });

  it("stateは完全一致だけを通し、戻りの誤り・拒否・コード欠けを文にする", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "ab")).toBe(false);
    expect(stateMatches("", "")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    const q = (o: Record<string, string>) => new URLSearchParams(o);
    expect(callbackProblem(q({ state: "st", code: "4/0AbCdEfGhIjK" }), "st")).toBeNull();
    expect(callbackProblem(q({ state: "st", code: "4/0AbCdEfGhIjK" }), "")).toContain("先に");
    expect(callbackProblem(q({ state: "other", code: "4/0AbCdEfGhIjK" }), "st")).toContain("確認できません");
    expect(callbackProblem(q({ state: "st", error: "access_denied" }), "st")).toContain("許可されませんでした");
    expect(callbackProblem(q({ state: "st" }), "st")).toContain("受け取れません");
  });

  it("許可コードをclient secret・code_verifier・戻り先付きで交換し、refresh tokenが無ければ止める", async () => {
    const fetcher = vi.fn(async () => Response.json({ access_token: "a", refresh_token: "r" }));
    const p = {
      clientId: "cid",
      clientSecret: "sec",
      code: "code",
      verifier: "ver",
      redirectUri: "http://127.0.0.1:53683/callback",
    };
    expect(await exchangeGoogleCode(p, fetcher as unknown as typeof fetch)).toEqual({ accessToken: "a", refreshToken: "r" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "code",
      client_id: "cid",
      client_secret: "sec",
      code_verifier: "ver",
      redirect_uri: "http://127.0.0.1:53683/callback",
    });
    const noRefresh = (async () => Response.json({ access_token: "a" })) as typeof fetch;
    await expect(exchangeGoogleCode(p, noRefresh)).rejects.toThrow("長期利用のトークン");
    const rejected = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
    await expect(exchangeGoogleCode(p, rejected)).rejects.toThrow("許可コードを確認できません");
  });

  it("アカウント表示は取れなければ空、フォルダ作成は名前とフォルダ種別で送る", async () => {
    expect(await fetchGoogleEmail("a", (async () => Response.json({ user: { emailAddress: "me@example.com" } })) as typeof fetch)).toBe(
      "me@example.com",
    );
    expect(await fetchGoogleEmail("a", (async () => new Response(null, { status: 403 })) as typeof fetch)).toBe("");
    const fetcher = vi.fn(async () => Response.json({ id: "folder_ABC-123456" }));
    expect(await createDriveFolder("a", driveFolderName("MyBrand"), fetcher as unknown as typeof fetch)).toBe("folder_ABC-123456");
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: "MyBrand images", mimeType: "application/vnd.google-apps.folder" });
    await expect(
      createDriveFolder("a", "x", (async () => new Response(null, { status: 403 })) as typeof fetch),
    ).rejects.toThrow("Google Drive API");
    expect(driveFolderName("  ")).toBe("Cliplink images");
  });

  it("保管先の表にgdriveがあり、setup:cloudflareが送る秘密値と案内がそろっている", () => {
    expect(parseStorageProvider("GDrive")).toBe("gdrive");
    const info = STORAGE_PROVIDER_INFO.gdrive;
    expect(info.label).toBe("Googleドライブ");
    expect(info.pagesSecrets).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID"]);
    expect(info.localEnv).toEqual(info.pagesSecrets);
    expect(info.setupHint).toContain("npm run setup:google");
  });
});
