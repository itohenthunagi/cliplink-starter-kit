// テスト用のR2バケット（Map実装）。Workerが使う head / get / put だけを持つ。
import type { BlobBucket } from "../../src/worker/r2";

interface Stored {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
  contentType?: string;
  sha256?: ArrayBuffer;
}
const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16))).buffer;

export class FakeBucket {
  objects = new Map<string, Stored>();
  calls = { head: 0, get: 0, put: 0 };
  private n = 0;
  private meta(key: string, o: Stored) {
    return {
      key,
      size: o.bytes.length,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      checksums: { sha256: o.sha256 },
      httpMetadata: { contentType: o.contentType },
    };
  }
  async head(key: string) {
    this.calls.head++;
    const o = this.objects.get(key);
    return o ? this.meta(key, o) : null;
  }
  async get(key: string, options?: { range?: { offset?: number; length?: number } }) {
    this.calls.get++;
    const o = this.objects.get(key);
    if (!o) return null;
    const r = options?.range;
    const start = r?.offset ?? 0;
    const bytes = o.bytes.subarray(start, r?.length === undefined ? undefined : start + r.length);
    return { ...this.meta(key, o), body: new Blob([bytes]).stream() };
  }
  async put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string }; sha256?: string },
  ) {
    this.calls.put++;
    const o: Stored = {
      bytes: new Uint8Array(value.slice(0)),
      etag: `etag-${++this.n}`,
      contentType: options?.httpMetadata?.contentType,
      sha256: options?.sha256 ? fromHex(options.sha256) : undefined,
    };
    this.objects.set(key, o);
    return this.meta(key, o);
  }
  asBucket() {
    return this as unknown as BlobBucket;
  }
}
