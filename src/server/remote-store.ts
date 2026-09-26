// 管理クライアント（ローカルサーバー）の外部保管先を、保管先の名前から作る工場関数。
// 保管先を増やす時は src/core/storage-provider.ts の一覧・表に足してから、ここの switch に1件足す。
import { Dropbox } from "../core/dropbox";
import { GoogleDrive } from "../core/gdrive";
import type { RemoteBlobStore } from "../core/model";
import {
  STORAGE_PROVIDER_INFO,
  unknownStorageProvider,
  type StorageProvider,
} from "../core/storage-provider";
import { R2Gateway } from "./r2-gateway";

export interface RemoteStoreConfig {
  // 共有ゲートウェイのURL（https://…、末尾の / なし）と管理用の合言葉。どの保管先でも必須。
  gateway: string;
  adminToken: string;
  env: Record<string, string | undefined>;
}

// 共有モードに足りない .env のキー（共通の CLIPLINK_GATEWAY_URL / CLIPLINK_ADMIN_TOKEN は呼び出し側で確かめる）。
export function missingRemoteEnv(
  provider: StorageProvider,
  env: Record<string, string | undefined>,
) {
  return STORAGE_PROVIDER_INFO[provider].localEnv.filter((k) => !env[k]);
}

export function createRemoteStore(
  provider: StorageProvider,
  { gateway, adminToken, env }: RemoteStoreConfig,
): RemoteBlobStore {
  switch (provider) {
    case "dropbox":
      return new Dropbox({
        appKey: env.DROPBOX_APP_KEY!,
        appSecret: env.DROPBOX_APP_SECRET,
        refreshToken: env.DROPBOX_REFRESH_TOKEN!,
      });
    case "r2":
      return new R2Gateway(gateway, adminToken);
    case "gdrive":
      return new GoogleDrive({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        refreshToken: env.GOOGLE_REFRESH_TOKEN!,
        folderId: env.GOOGLE_DRIVE_FOLDER_ID!,
      });
    default:
      return unknownStorageProvider(provider);
  }
}
