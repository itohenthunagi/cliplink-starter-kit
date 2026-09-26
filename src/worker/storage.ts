// 共有ゲートウェイ（Worker）の保管先を、vars.STORAGE_PROVIDER から作る工場関数。
// 保管先を増やす時は src/core/storage-provider.ts の一覧・表に足してから、ここの switch に1件足す。
import { Dropbox } from "../core/dropbox";
import { GoogleDrive } from "../core/gdrive";
import { DomainError } from "../core/library";
import type { RemoteBlobStore, Version } from "../core/model";
import {
  STORAGE_PROVIDERS,
  parseStorageProvider,
  unknownStorageProvider,
} from "../core/storage-provider";
import type { Env } from "./index";
import { R2Blobs, type BlobBucket } from "./r2";

// 公開ページが版の実体を読み出す口。verify は台帳に新しく加わる版が、この保管先に保存済みかを確かめる。
export interface MediaReader extends Pick<RemoteBlobStore, "download"> {
  verify?(version: Version): Promise<void>;
}

export type WorkerStorage =
  | { reader: MediaReader; bucket?: BlobBucket; error?: undefined }
  | { error: string };

// fetcher はテスト用（既定は実際のfetch）。
export function createWorkerStorage(
  env: Env,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): WorkerStorage {
  const provider = parseStorageProvider(env.STORAGE_PROVIDER);
  if (!provider)
    return {
      error: `保管先の設定（STORAGE_PROVIDER）が不正です。${STORAGE_PROVIDERS.join(" / ")} のどれかにしてください。`,
    };
  switch (provider) {
    case "dropbox": {
      const dropbox = new Dropbox({
        appKey: env.DROPBOX_APP_KEY ?? "",
        appSecret: env.DROPBOX_APP_SECRET,
        refreshToken: env.DROPBOX_REFRESH_TOKEN ?? "",
      }, fetcher);
      return {
        reader: {
          download: (v, range) => dropbox.download(v, range),
          // Dropboxの版は file id（"id:…"）を持つ。別の保管先の版が混ざるのを防ぐ。
          verify: async (v) => {
            if (!v.dropbox?.id.startsWith("id:"))
              throw new DomainError("保管先の種類が一致しない版があります。");
          },
        },
      };
    }
    case "r2":
      if (!env.BUCKET) return { error: "保管先（R2バケット）が接続されていません。" };
      // R2だけは管理API /internal/blobs/* でゲートウェイ自身が保存を受け持つため、bucket も渡す。
      return { reader: new R2Blobs(env.BUCKET as BlobBucket), bucket: env.BUCKET as BlobBucket };
    case "gdrive": {
      // 読み出しと保存済みの確認だけなので、フォルダID（GOOGLE_DRIVE_FOLDER_ID）は使わない。
      const drive = new GoogleDrive(
        {
          clientId: env.GOOGLE_CLIENT_ID ?? "",
          clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
          refreshToken: env.GOOGLE_REFRESH_TOKEN ?? "",
          folderId: env.GOOGLE_DRIVE_FOLDER_ID ?? "",
        },
        fetcher,
      );
      return {
        reader: {
          download: (v, range) => drive.download(v, range),
          verify: (v) => drive.verify(v),
        },
      };
    }
    default:
      return unknownStorageProvider(provider);
  }
}
