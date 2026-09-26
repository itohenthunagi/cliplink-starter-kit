// 共有モードで画像の保管先を Cloudflare R2 にした時の管理クライアント側の窓口。
// R2へは直接つながず、共有ゲートウェイ（Pagesの _worker.js）の管理API /internal/blobs/* を
// 管理用の合言葉（ADMIN_TOKEN）で呼ぶ。Dropboxクラスと同じ upload / download の形にそろえる。
import { createHash } from "node:crypto";
import { DomainError } from "../core/library";
import {
  extensions,
  relativePathPattern,
  type RemoteBlobStore,
  type Version,
} from "../core/model";
import { dropboxHash } from "./storage";

const mimeByExtension = Object.fromEntries(
  Object.entries(extensions).map(([mime, ext]) => [ext, mime]),
) as Record<string, Version["mime"]>;

export class R2Gateway implements RemoteBlobStore {
  readonly provider = "r2" as const;
  constructor(
    private gateway: string,
    private adminToken: string,
    // fetchをそのまま保持して this.fetcher() で呼ぶと Illegal invocation になる環境があるため包む。
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.gateway = gateway.replace(/\/$/, "");
  }
  // R2は版の相対パス（assets/…）をそのままキーにする。
  keyFor(relativePath: string) {
    return relativePath;
  }
  private url(key: string) {
    if (!relativePathPattern.test(key))
      throw new DomainError("R2の保存先キーが不正です。");
    return `${this.gateway}/internal/blobs/${key}`;
  }
  // path は FileStore.remotePath() が keyFor で決めたキー（=版の相対パス）。
  async upload(
    path: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<NonNullable<Version["dropbox"]>> {
    const url = this.url(path);
    const mime = mimeByExtension[path.split(".").at(-1)!];
    if (!mime) throw new DomainError("R2の保存先キーが不正です。");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let r: Response;
    try {
      r = await this.fetcher(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
          "Content-Type": mime,
          "x-content-sha256": sha256,
        },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new DomainError(
        "Cloudflare R2への保存が完了しませんでした。通信を確認して再試行してください。",
        503,
      );
    }
    if (r.status === 409)
      throw new DomainError(
        "Cloudflare R2の同じ場所に別の内容があります。上書きはしません。",
        409,
      );
    if (!r.ok)
      throw new DomainError(
        "Cloudflare R2への保存が完了しませんでした。通信・容量・共有ゲートウェイの設定を確認して再試行してください。",
        503,
      );
    const m = (await r.json()) as { id?: string; rev?: string; size?: number };
    if (m.id !== path || !m.rev || m.size !== bytes.length)
      throw new DomainError("Cloudflare R2のファイル整合確認に失敗しました。", 503);
    // R2側はSHA-256を照合済み。contentHashはDropboxと同じ算法の値を入れ、FileStoreの照合にそろえる。
    const contentHash = dropboxHash(bytes);
    if (contentHash !== expectedHash)
      throw new DomainError("Cloudflare R2のファイル整合確認に失敗しました。", 503);
    return { id: path, rev: m.rev, contentHash };
  }
  async download(version: Version, range?: string) {
    if (!version.dropbox)
      throw new DomainError("Cloudflare R2への保存が完了していません。", 503);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.adminToken}`,
    };
    if (range) {
      if (!/^bytes=\d*-\d*$/.test(range))
        throw new DomainError("範囲指定が不正です。", 416);
      headers.Range = range;
    }
    let r: Response;
    try {
      r = await this.fetcher(this.url(version.dropbox.id), {
        headers,
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      r = new Response(null, { status: 503 });
    }
    if (r.status === 416)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${version.size}` },
      });
    if (!r.ok)
      throw new DomainError(
        "Cloudflare R2から取得できません。通信・共有ゲートウェイの状態を確認してください。",
        503,
      );
    return r;
  }
}
