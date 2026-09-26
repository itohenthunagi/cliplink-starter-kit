import { z } from "zod";
export const uuid = z.string().uuid();
// 版の実ファイルの相対パス。Cloudflare R2ではこのままオブジェクトキーになる。
export const relativePathPattern =
  /^assets\/[a-f0-9-]+\/(original|working|published)\/[a-f0-9-]+\.[a-z0-9]+$/;
export const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
} as const;
export type { StorageProvider } from "./storage-provider";
import type { StorageProvider } from "./storage-provider";
export const versionSchema = z.object({
  id: uuid,
  kind: z.enum(["original", "working", "published"]),
  relativePath: z.string().regex(relativePathPattern),
  mime: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ]),
  size: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  createdBy: z.enum(["user", "ai", "system"]),
  // 外部保管先のメタデータ。フィールド名はスキーマ互換のため dropbox のまま使う。
  // Dropbox: id=file id（"id:…"）, rev=Dropboxのrev, contentHash=Dropboxのcontent_hash。
  // Cloudflare R2: id=オブジェクトキー（relativePathと同じ）, rev=etag, contentHash=同じ算法で求めた値。
  // Googleドライブ: id="gdrive:<file id>", rev=ファイルのversion, contentHash=同じ算法で求めた値。
  dropbox: z
    .object({
      id: z.union([
        z.string().startsWith("id:"),
        z.string().regex(relativePathPattern),
        z.string().regex(/^gdrive:[A-Za-z0-9_-]{10,}$/),
      ]),
      rev: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  annotationMeta: z.string().max(20000).optional(),
});
const common = {
  id: uuid,
  slug: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
export const assetSchema = z.object({
  ...common,
  kind: z.literal("asset"),
  type: z.enum(["image", "video"]),
  captureAt: z.string().datetime(),
  sourceTitle: z.string().max(500),
  sourceUrl: z.string().max(2048),
  tags: z.array(z.string().max(80)).max(30),
  notes: z.string().max(5000),
  protected: z.boolean(),
  status: z.enum(["draft", "published", "revoked", "archived"]),
  currentPublishedVersionId: uuid.nullable(),
  versions: z.array(versionSchema).min(1).max(1000),
});
export const collectionSchema = z.object({
  ...common,
  kind: z.literal("collection"),
  description: z.string().max(5000),
  orderedAssetIds: z.array(uuid).min(1).max(100),
  active: z.boolean(),
});
export const entitySchema = z.discriminatedUnion("kind", [
  assetSchema,
  collectionSchema,
]);
export type Version = z.infer<typeof versionSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Collection = z.infer<typeof collectionSchema>;
export type Entity = Asset | Collection;
export interface Repository {
  get(id: string): Promise<Entity | null>;
  bySlug(slug: string): Promise<Entity | null>;
  list(): Promise<Entity[]>;
  save(entity: Entity, expected: number): Promise<void>;
}
export interface BlobStore {
  put(
    assetId: string,
    kind: Version["kind"],
    data: Uint8Array,
    mime: Version["mime"],
    createdBy?: Version["createdBy"],
  ): Promise<Version>;
  read(version: Version, range?: string): Promise<Response>;
}
// 外部保管先（Dropbox / Cloudflare R2 / Googleドライブ）。upload の結果は Version.dropbox に入る。
export interface RemoteBlobStore {
  readonly provider?: StorageProvider;
  // 版の相対パス（assets/…）から、この保管先での置き場所を決める。無ければ FileStore の dropboxRoot 配下にする。
  keyFor?(relativePath: string): string;
  upload(
    path: string,
    bytes: Uint8Array,
    expectedHash: string,
  ): Promise<NonNullable<Version["dropbox"]>>;
  download(version: Version, range?: string): Promise<Response>;
}
