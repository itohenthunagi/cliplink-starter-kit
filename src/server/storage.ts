import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { BlobStore, RemoteBlobStore, Version } from "../core/model";
import { extensions, versionSchema } from "../core/model";
import { DomainError } from "../core/library";
import { storageLabel } from "../core/storage-provider";
export const hash = (b: Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
export function dropboxHash(bytes: Uint8Array) {
  const hashes = [];
  for (let i = 0; i < bytes.length; i += 4 * 1024 * 1024)
    hashes.push(
      createHash("sha256")
        .update(bytes.subarray(i, i + 4 * 1024 * 1024))
        .digest(),
    );
  return createHash("sha256").update(Buffer.concat(hashes)).digest("hex");
}
export function detectMime(bytes: Uint8Array): Version["mime"] {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return "video/webm";
  if (b.subarray(4, 8).toString() === "ftyp")
    return b.subarray(8, 12).toString() === "qt  "
      ? "video/quicktime"
      : "video/mp4";
  throw new DomainError(
    "PNG・JPEG・WebP・GIF・MP4・WebM・MOVのファイルを選んでください。",
  );
}
export class FileStore implements BlobStore {
  constructor(
    public root: string,
    // 外部保管先（src/server/remote-store.ts が作る）。無ければローカルだけに保存する。
    private remote?: RemoteBlobStore,
    public dropboxRoot = "/ScreenShare",
  ) {}
  get provider() {
    return this.remote ? (this.remote.provider ?? "dropbox") : undefined;
  }
  // 外部保管先での置き場所。保管先が決めない時（Dropbox）は dropboxRoot 配下。
  remotePath(v: Version) {
    return (
      this.remote?.keyFor?.(v.relativePath) ??
      `${this.dropboxRoot}/${v.relativePath}`
    );
  }
  path(version: Version) {
    versionSchema.parse(version);
    const path = resolve(this.root, version.relativePath);
    if (!path.startsWith(resolve(this.root) + sep))
      throw new DomainError("保存先が不正です。");
    return path;
  }
  async put(
    assetId: string,
    kind: Version["kind"],
    bytes: Uint8Array,
    mime: Version["mime"],
    createdBy: Version["createdBy"] = "user",
  ) {
    if (!bytes.length || bytes.length > 100 * 1024 * 1024)
      throw new DomainError("ファイルは100MB以下にしてください。", 413);
    const id = crypto.randomUUID();
    const v: Version = {
      id,
      kind,
      relativePath: `assets/${assetId}/${kind}/${id}.${extensions[mime]}`,
      mime,
      size: bytes.length,
      sha256: hash(bytes),
      createdAt: new Date().toISOString(),
      createdBy,
    };
    const path = this.path(v);
    await mkdir(dirname(path), { recursive: true });
    const root = await realpath(this.root);
    const parent = await realpath(dirname(path));
    if (!parent.startsWith(root + sep))
      throw new DomainError("保存先に外部フォルダへのリンクがあります。");
    await writeFile(path, bytes, { flag: "wx" });
    if (this.remote) {
      const expectedHash = dropboxHash(bytes);
      v.dropbox = await this.remote.upload(
        this.remotePath(v),
        bytes,
        expectedHash,
      );
      if (v.dropbox.contentHash !== expectedHash)
        throw new DomainError(
          `${storageLabel(this.provider!)}のファイル整合確認に失敗しました。`,
          503,
        );
    }
    return v;
  }
  async read(v: Version, range?: string) {
    let bytes: Buffer;
    try {
      const path = this.path(v);
      const root = await realpath(this.root);
      if (!(await realpath(path)).startsWith(root + sep))
        throw new Error("outside root");
      bytes = await readFile(path);
      if (hash(bytes) !== v.sha256) throw new Error("modified");
    } catch {
      if (this.remote) return this.remote.download(v, range);
      throw new DomainError(
        "ファイルが見つからないか変更されています。保存先・同期状態を確認してください。",
        503,
      );
    }
    const headers: Record<string, string> = {
      "Content-Type": v.mime,
      "Accept-Ranges": "bytes",
    };
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0,
        end = bytes.length - 1;
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.length}` },
        });
      if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (start > end || start >= bytes.length)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.length}` },
        });
      headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
      headers["Content-Length"] = String(end - start + 1);
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
        status: 206,
        headers,
      });
    }
    headers["Content-Length"] = String(bytes.length);
    return new Response(new Uint8Array(bytes), { headers });
  }
  async materialize(v: Version) {
    const path = this.path(v);
    try {
      const bytes = await readFile(path);
      if (hash(bytes) !== v.sha256)
        throw new DomainError(
          "ローカルの版が変更されています。上書きを避けるため、別の保存先を指定してください。",
          409,
        );
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.remote)
      throw new DomainError("対象の実ファイルが見つかりません。", 503);
    const response = await this.remote.download(v);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hash(bytes) !== v.sha256)
      throw new DomainError("取得したファイルの整合確認に失敗しました。", 503);
    await mkdir(dirname(path), { recursive: true });
    const root = await realpath(this.root);
    if (!(await realpath(dirname(path))).startsWith(root + sep))
      throw new DomainError("保存先が不正です。");
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        hash(await readFile(path)) !== v.sha256
      )
        throw error;
    }
    return path;
  }
}
