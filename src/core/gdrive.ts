// 共有モードの画像の保管先を Google ドライブにした時の窓口。Dropboxクラスと同じ upload / download の形にそろえる。
// fetch と Web Crypto（crypto.subtle）だけで書くため、管理クライアント（Node）と共有ゲートウェイ（Worker）の両方で使える。
// 権限は drive.file（このアプリが作ったファイルだけ）。版は保存時の file id で固定し、Googleの直リンクへはリダイレクトしない。
import { DomainError } from "./library";
import {
  extensions,
  relativePathPattern,
  type RemoteBlobStore,
  type Version,
} from "./model";

export interface GoogleDriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  // 画像を置くフォルダの file id（setup:google が作る）。読み出しだけの Worker では使わない。
  folderId: string;
}

// Version.dropbox.id に入る形（"gdrive:<fileId>"）。
export const gdriveIdPattern = /^gdrive:([A-Za-z0-9_-]{10,})$/;
export const RECONNECT_MESSAGE =
  "Googleとの接続が切れました。npm run setup:google をやり直してください（Google Cloud のアプリが『テスト中』のままだと7日で切れます）。";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,sha256Checksum,version";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

const mimeByExtension = Object.fromEntries(
  Object.entries(extensions).map(([mime, ext]) => [ext, mime]),
) as Record<string, Version["mime"]>;

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));

export async function sha256Hex(bytes: Uint8Array) {
  return hex(await sha256(bytes));
}

// src/server/storage.ts の dropboxHash と同じ算法（4MBごとのSHA-256を連結してもう一度SHA-256）。Web Crypto版。
export async function contentHashOf(bytes: Uint8Array) {
  const block = 4 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += block)
    parts.push(await sha256(bytes.subarray(i, i + block)));
  const joined = new Uint8Array(parts.length * 32);
  parts.forEach((p, i) => joined.set(p, i * 32));
  return hex(await sha256(joined));
}

// 版のメタデータから Google ドライブの file id を取り出す。形が違えば null。
export function gdriveFileId(version: Version) {
  return gdriveIdPattern.exec(version.dropbox?.id ?? "")?.[1] ?? null;
}

export class GoogleDrive implements RemoteBlobStore {
  readonly provider = "gdrive" as const;
  private accessToken = "";
  private expiresAt = 0;
  constructor(
    private credentials: GoogleDriveCredentials,
    // fetchをそのまま保持して this.fetcher() で呼ぶと、Workersでは Illegal invocation になる。
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  // 版の相対パス（assets/…）をそのままキーにし、ファイル名とappPropertiesに残す。
  keyFor(relativePath: string) {
    return relativePath;
  }
  private async call(url: string, init: RequestInit, timeout = 30000) {
    try {
      return await this.fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      return null;
    }
  }
  private async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const r = await this.call(TOKEN_URL, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.credentials.refreshToken,
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }),
    });
    if (!r?.ok) {
      const error = r ? ((await r.json().catch(() => ({}))) as { error?: string }).error : undefined;
      throw new DomainError(
        error === "invalid_grant"
          ? RECONNECT_MESSAGE
          : "Googleドライブの認証を更新できません。通信と接続設定を確認してください。",
        503,
      );
    }
    const t = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!t.access_token)
      throw new DomainError("Googleドライブの認証を更新できません。接続設定を確認してください。", 503);
    this.accessToken = t.access_token;
    this.expiresAt = Date.now() + ((t.expires_in ?? 3600) - 120) * 1000;
    return this.accessToken;
  }
  // key は FileStore.remotePath() が keyFor で決めたキー（=版の相対パス）。
  async upload(
    key: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<NonNullable<Version["dropbox"]>> {
    const mime = mimeByExtension[key.split(".").at(-1)!];
    if (!relativePathPattern.test(key) || !mime)
      throw new DomainError("Googleドライブの保存先キーが不正です。");
    const failed = () =>
      new DomainError(
        "Googleドライブへの保存が完了しませんでした。通信・容量を確認して再試行してください。",
        503,
      );
    const [digest, contentHash] = await Promise.all([sha256Hex(bytes), contentHashOf(bytes)]);
    if (contentHash !== expectedHash)
      throw new DomainError("Googleドライブへ送る内容の整合確認に失敗しました。", 503);
    const token = await this.token();
    // 1) 再開可能アップロードの受付（メタデータだけ送り、送り先URLを受け取る）。
    const start = await this.call(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        "X-Upload-Content-Length": String(bytes.length),
      },
      body: JSON.stringify({
        name: key.replaceAll("/", "__"),
        parents: [this.credentials.folderId],
        appProperties: { cliplinkKey: key },
        mimeType: mime,
      }),
    });
    if (start?.status === 404)
      throw new DomainError(
        "Googleドライブの保存用フォルダが見つかりません。npm run setup:google をやり直してください。",
        503,
      );
    const location = start?.ok ? start.headers.get("Location") : null;
    if (!location?.startsWith("https://")) throw failed();
    // 2) 本体を送る。
    const done = await this.call(
      location,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
        body: bytes as BodyInit,
      },
      180000,
    );
    if (!done?.ok) throw failed();
    type Meta = { id?: string; size?: string; sha256Checksum?: string; version?: string };
    let m = (await done.json()) as Meta;
    const id = `gdrive:${m.id ?? ""}`;
    const mismatch = () => new DomainError("Googleドライブのファイル整合確認に失敗しました。", 503);
    if (!gdriveIdPattern.test(id)) throw mismatch();
    // 完了応答にSHA-256や版番号が載らない場合に備え、少し待ってメタデータを取り直す。
    for (let i = 0; i < 3 && (!m.sha256Checksum || !m.version); i++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      const again = await this.call(`${FILES_URL}/${m.id}?fields=id,size,sha256Checksum,version`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (again?.ok) m = { ...m, ...((await again.json()) as Meta) };
    }
    if (Number(m.size) !== bytes.length || !m.version) throw mismatch();
    if (m.sha256Checksum) {
      if (m.sha256Checksum.toLowerCase() !== digest) throw mismatch();
    } else {
      // それでもSHA-256が返らない時は、保存された中身を読み戻して照合する。
      const back = await this.call(`${FILES_URL}/${m.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } }, 180000);
      if (!back?.ok || (await sha256Hex(new Uint8Array(await back.arrayBuffer()))) !== digest) throw mismatch();
    }
    return { id, rev: String(m.version), contentHash };
  }
  async download(version: Version, range?: string) {
    const fileId = gdriveFileId(version);
    if (!fileId) throw new DomainError("Googleドライブへの保存が完了していません。", 503);
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range)) throw new DomainError("範囲指定が不正です。", 416);
      headers.Range = range;
    }
    const r = await this.call(`${FILES_URL}/${fileId}?alt=media`, { headers }, 180000);
    if (r?.status === 416)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${version.size}` },
      });
    if (r?.status === 404 || r?.status === 403)
      throw new DomainError(
        "Googleドライブにファイルが見つからないか、読む権限がありません。ごみ箱・共有設定を確認してください。",
        503,
      );
    if (!r?.ok)
      throw new DomainError(
        "Googleドライブから取得できません。通信・接続の状態を確認してください。",
        503,
      );
    // Googleの応答ヘッダーはそのまま渡さず、公開に要るものだけで作り直す。
    const out: Record<string, string> = { "Content-Type": version.mime, "Accept-Ranges": "bytes" };
    for (const k of ["Content-Length", "Content-Range"]) {
      const value = r.headers.get(k);
      if (value) out[k] = value;
    }
    return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers: out });
  }
  // 台帳に加わる版が、Googleドライブに存在し（ごみ箱でなく）、大きさ・SHA-256が一致するか確かめる。
  async verify(version: Version) {
    const fileId = gdriveFileId(version);
    if (!fileId) throw new DomainError("保管先の種類が一致しない版があります。");
    const r = await this.call(`${FILES_URL}/${fileId}?fields=size,sha256Checksum,trashed`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (!r?.ok) throw new DomainError("Googleドライブ保存未完了の版があります。");
    const m = (await r.json()) as { size?: string; sha256Checksum?: string; trashed?: boolean };
    // SHA-256が返らない場合は、アップロード時に読み戻して照合済みなので、存在と大きさで確かめる。
    if (
      m.trashed !== false ||
      Number(m.size) !== version.size ||
      (m.sha256Checksum !== undefined && m.sha256Checksum.toLowerCase() !== version.sha256)
    )
      throw new DomainError("Googleドライブ保存未完了の版があります。");
  }
}
