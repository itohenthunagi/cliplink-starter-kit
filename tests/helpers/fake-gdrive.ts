// テスト用のGoogleドライブ（トークン更新・再開可能アップロード・alt=media・メタデータ取得だけ）。実際のGoogleへはつながない。
import { createHash } from "node:crypto";

interface Stored {
  bytes: Uint8Array;
  name: string;
  parents: string[];
  appProperties: Record<string, string>;
  mimeType: string;
  trashed: boolean;
}

export class FakeGoogleDrive {
  files = new Map<string, Stored>();
  calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  tokenError?: string;
  // 返す sha256Checksum を書き換える（改ざん・途中欠損の再現）。
  checksumOverride?: string;
  // sha256Checksum を応答に含めない（Googleが未計算の場合の再現）。
  omitChecksum = false;
  private n = 0;
  private sessions = new Map<string, { meta: Record<string, unknown> }>();

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({ url: url.href, method, headers, body: init.body });
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (this.tokenError) return Response.json({ error: this.tokenError }, { status: 400 });
      return Response.json({ access_token: "test-access", expires_in: 3600 });
    }
    if (headers.Authorization !== "Bearer test-access") return new Response(null, { status: 401 });
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const id = `session-${++this.n}`;
      this.sessions.set(id, { meta: JSON.parse(String(init.body)) });
      return new Response(null, { headers: { Location: `https://upload.example.test/${id}` } });
    }
    if (url.host === "upload.example.test" && method === "PUT") {
      const s = this.sessions.get(url.pathname.slice(1));
      if (!s) return new Response(null, { status: 404 });
      const bytes = new Uint8Array(init.body as Uint8Array);
      const fileId = `file${String(++this.n).padStart(12, "0")}`;
      this.files.set(fileId, {
        bytes,
        name: String(s.meta.name),
        parents: s.meta.parents as string[],
        appProperties: s.meta.appProperties as Record<string, string>,
        mimeType: String(s.meta.mimeType),
        trashed: false,
      });
      return Response.json({
        id: fileId,
        size: String(bytes.length),
        sha256Checksum: this.omitChecksum ? undefined : (this.checksumOverride ?? createHash("sha256").update(bytes).digest("hex")),
        version: "1",
      });
    }
    const m = /^\/drive\/v3\/files\/([\w-]+)$/.exec(url.pathname);
    if (m && method === "GET") {
      const f = this.files.get(m[1]);
      if (!f) return Response.json({ error: { code: 404 } }, { status: 404 });
      if (url.searchParams.get("alt") === "media") {
        const base = {
          "Content-Type": f.mimeType,
          "X-GUploader-UploadID": "internal",
          "Content-Disposition": "attachment; filename=secret-name.png",
        };
        const range = headers.Range;
        if (range) {
          const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(range)!;
          const size = f.bytes.length;
          const start = a ? Number(a) : Math.max(0, size - Number(b));
          const end = a && b ? Math.min(size - 1, Number(b)) : size - 1;
          if (start >= size) return new Response(null, { status: 416 });
          return new Response(f.bytes.slice(start, end + 1), {
            status: 206,
            headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
          });
        }
        return new Response(f.bytes.slice(), { headers: { ...base, "Content-Length": String(f.bytes.length) } });
      }
      return Response.json({
        size: String(f.bytes.length),
        sha256Checksum: this.omitChecksum ? undefined : createHash("sha256").update(f.bytes).digest("hex"),
        version: "1",
        trashed: f.trashed,
      });
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;

  count(pred: (c: FakeGoogleDrive["calls"][number]) => boolean) {
    return this.calls.filter(pred).length;
  }
}
