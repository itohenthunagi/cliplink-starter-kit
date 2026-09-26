// 共有ゲートウェイ側で Cloudflare R2 のバケット（binding: BUCKET）から媒体を読み出す。
// 公開ページは必ずこのWorkerを通して返す（期限付き直リンクへはリダイレクトしない）ため、共有停止が媒体URLにも効く。
import type { R2Bucket } from "@cloudflare/workers-types";
import { DomainError } from "../core/library";
import { relativePathPattern, type Version } from "../core/model";

export type BlobBucket = Pick<R2Bucket, "get" | "head" | "put">;

export const toHex = (b: ArrayBuffer | ArrayBufferView) =>
  [
    ...new Uint8Array(
      ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b,
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// "bytes=a-b" / "bytes=a-" / "bytes=-n" を解釈する（FileStore.read と同じ規則）。満たせない時は null。
export function parseByteRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  let start = 0,
    end = size - 1;
  if (!match[1]) start = Math.max(0, size - Number(match[2]));
  else {
    start = Number(match[1]);
    if (match[2]) end = Math.min(end, Number(match[2]));
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

const unsatisfiable = (size: number) =>
  new Response(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${size}` },
  });

// キーの実体を返す。無ければ null。size が分からない時（管理APIのGET）はheadで確かめる。
export async function readObject(
  bucket: BlobBucket,
  key: string,
  range?: string,
  knownSize?: number,
) {
  let size = knownSize;
  if (range && size === undefined) {
    const head = await bucket.head(key);
    if (!head) return null;
    size = head.size;
  }
  const parsed = range ? parseByteRange(range, size!) : undefined;
  if (range && !parsed) return unsatisfiable(size!);
  const obj = await bucket.get(
    key,
    parsed
      ? { range: { offset: parsed.start, length: parsed.end - parsed.start + 1 } }
      : undefined,
  );
  if (!obj || !("body" in obj)) return null;
  const headers: Record<string, string> = { "Accept-Ranges": "bytes" };
  const type = obj.httpMetadata?.contentType;
  if (type) headers["Content-Type"] = type;
  if (parsed) {
    headers["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${obj.size}`;
    headers["Content-Length"] = String(parsed.end - parsed.start + 1);
    return new Response(obj.body as unknown as BodyInit, { status: 206, headers });
  }
  headers["Content-Length"] = String(obj.size);
  return new Response(obj.body as unknown as BodyInit, { headers });
}

// createWorker に渡す読み出し器（Dropboxクラスの download と同じ形）。
export class R2Blobs {
  constructor(private bucket: BlobBucket) {}
  async download(version: Version, range?: string) {
    const key = version.dropbox?.id;
    if (!key || key !== version.relativePath || !relativePathPattern.test(key))
      throw new DomainError("Cloudflare R2への保存が完了していません。", 503);
    const r = await readObject(this.bucket, key, range, version.size);
    if (!r)
      throw new DomainError(
        "Cloudflare R2から取得できません。保管先の状態を確認してください。",
        503,
      );
    return r;
  }
  // 台帳に加わる版が、キー（=相対パス）・大きさ・SHA-256の一致するR2の実体を持つか確かめる。
  async verify(version: Version) {
    const key = version.dropbox?.id;
    if (key !== version.relativePath)
      throw new DomainError("保管先の種類が一致しない版があります。");
    const head = await this.bucket.head(key);
    const saved = head?.checksums?.sha256;
    if (!head || head.size !== version.size || !saved || toHex(saved) !== version.sha256)
      throw new DomainError("R2保存未完了の版があります。");
  }
}
