// 共有モードの画像の保管先（外部保管先）の一覧と、保管先ごとの設定の表。
// 保管先を増やす時は STORAGE_PROVIDERS に名前を足し、下の表（Record なので足りないと型エラーになる）と、
// src/server/remote-store.ts・src/worker/storage.ts の工場関数に1件ずつ足す。
export const STORAGE_PROVIDERS = ["dropbox", "r2", "gdrive"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];
export const DEFAULT_STORAGE_PROVIDER: StorageProvider = "dropbox";

// .env の CLIPLINK_STORAGE_PROVIDER / Pagesの vars.STORAGE_PROVIDER を解釈する。未設定は既定（dropbox）、知らない値は null。
export function parseStorageProvider(value: string | undefined): StorageProvider | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return DEFAULT_STORAGE_PROVIDER;
  return (STORAGE_PROVIDERS as readonly string[]).includes(v) ? (v as StorageProvider) : null;
}

export interface StorageProviderInfo {
  // 画面・案内に出す名前。
  label: string;
  // 管理クライアント（ローカルサーバー）が共有モードで必要とする .env のキー（ゲートウェイURL・管理用の合言葉は共通なので除く）。
  localEnv: readonly string[];
  // setup:cloudflare が Pages の secret へ送る .env のキー（同じ名前で送る。値の無い任意項目は飛ばす）。
  pagesSecrets: readonly string[];
  // localEnv が足りない時の案内。
  setupHint: string;
}

export const STORAGE_PROVIDER_INFO: Record<StorageProvider, StorageProviderInfo> = {
  dropbox: {
    label: "Dropbox",
    localEnv: ["DROPBOX_APP_KEY", "DROPBOX_REFRESH_TOKEN"],
    pagesSecrets: ["DROPBOX_APP_KEY", "DROPBOX_REFRESH_TOKEN", "DROPBOX_APP_SECRET"],
    setupHint: "Dropboxの接続情報がありません。先に npm run setup:dropbox を実行してください。",
  },
  r2: {
    // Cloudflareだけで完結する。バケットはPagesの binding（BUCKET）で渡すため秘密値は要らない。
    label: "Cloudflare R2",
    localEnv: [],
    pagesSecrets: [],
    setupHint: "",
  },
  gdrive: {
    // 利用者自身のGoogle Cloudで作った「デスクトップ アプリ」のOAuthクライアントでつなぐ（権限は drive.file）。
    label: "Googleドライブ",
    localEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID"],
    pagesSecrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID"],
    setupHint: "Googleドライブの接続情報がありません。先に npm run setup:google を実行してください。",
  },
};

export const storageLabel = (p: StorageProvider) => STORAGE_PROVIDER_INFO[p].label;

export function unknownStorageProvider(p: never): never {
  throw new Error(`未対応の保管先です: ${String(p)}`);
}
