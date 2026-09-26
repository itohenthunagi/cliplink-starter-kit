import {
  entitySchema,
  type Asset,
  type Collection,
  type Entity,
  type Repository,
  type Version,
} from "./model";
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const notFound = () =>
  new DomainError("対象が見つからないか、共有が停止されています。", 404);
export const conflict = () =>
  new DomainError(
    "別の操作で更新されました。再読み込みしてからやり直してください。",
    409,
  );
const stamp = () => new Date().toISOString();
const base = (title: string) => ({
  id: crypto.randomUUID(),
  slug: crypto.randomUUID().replaceAll("-", ""),
  revision: 1,
  title,
  createdAt: stamp(),
  updatedAt: stamp(),
});
export class MemoryRepository implements Repository {
  private records = new Map<string, Entity>();
  async get(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async bySlug(slug: string) {
    return structuredClone(
      [...this.records.values()].find((e) => e.slug === slug) ?? null,
    );
  }
  async list() {
    return structuredClone([...this.records.values()]);
  }
  async save(e: Entity, expected: number) {
    if ((this.records.get(e.id)?.revision ?? 0) !== expected) throw conflict();
    this.records.set(e.id, structuredClone(e));
  }
}
export class Library {
  constructor(public repo: Repository) {}
  async asset(id: string): Promise<Asset> {
    const e = await this.repo.get(id);
    if (e?.kind !== "asset") throw notFound();
    return e;
  }
  async createAsset(input: {
    title: string;
    version: Version;
    id?: string;
    captureAt?: string;
    sourceTitle?: string;
    sourceUrl?: string;
    notes?: string;
    tags?: string[];
  }) {
    if (input.version.kind !== "original")
      throw new DomainError("最初の版は原本にしてください。");
    const a: Asset = {
      ...base(input.title),
      ...(input.id ? { id: input.id } : {}),
      kind: "asset",
      type: input.version.mime.startsWith("image/") ? "image" : "video",
      captureAt: input.captureAt ?? stamp(),
      sourceTitle: input.sourceTitle ?? "",
      sourceUrl: input.sourceUrl ?? "",
      tags: input.tags ?? [],
      notes: input.notes ?? "",
      protected: false,
      status: "draft",
      currentPublishedVersionId: null,
      versions: [input.version],
    };
    entitySchema.parse(a);
    await this.repo.save(a, 0);
    return a;
  }
  private async change<T extends Entity>(e: T, revision: number): Promise<T> {
    if (e.revision !== revision) throw conflict();
    e.updatedAt = stamp();
    e.revision++;
    entitySchema.parse(e);
    await this.repo.save(e, revision);
    return e;
  }
  async addVersion(id: string, revision: number, version: Version) {
    const a = await this.asset(id);
    if (version.kind !== "working" || a.status === "archived")
      throw new DomainError("作業版を登録できません。");
    this.checkVersion(a, version);
    a.versions.push(version);
    return this.change(a, revision);
  }
  private checkVersion(a: Asset, v: Version) {
    if (
      !v.mime.startsWith(`${a.type}/`) ||
      a.versions.some((x) => x.id === v.id)
    )
      throw new DomainError("版の種類またはIDが不正です。");
  }
  async publish(id: string, revision: number, version: Version) {
    const a = await this.asset(id);
    if (version.kind !== "published" || a.status === "archived")
      throw new DomainError("公開版を選択してください。");
    this.checkVersion(a, version);
    a.versions.push(version);
    a.currentPublishedVersionId = version.id;
    a.status = "published";
    return this.change(a, revision);
  }
  async updateAsset(
    id: string,
    revision: number,
    changes: Partial<
      Pick<
        Asset,
        "title" | "notes" | "tags" | "sourceTitle" | "sourceUrl" | "protected"
      >
    >,
  ) {
    const a = await this.asset(id);
    Object.assign(a, changes);
    return this.change(a, revision);
  }
  async revoke(id: string, revision: number) {
    const e = await this.repo.get(id);
    if (!e) throw notFound();
    if (e.kind === "asset") e.status = "revoked";
    else e.active = false;
    return this.change(e, revision);
  }
  async archive(id: string, revision: number) {
    const a = await this.asset(id);
    const used = (await this.repo.list()).some(
      (e) =>
        e.kind === "collection" && e.active && e.orderedAssetIds.includes(id),
    );
    if (a.protected || a.status === "published" || used)
      throw new DomainError(
        "公開中・削除保護中、または公開コレクションで使用中です。先に共有停止と保護解除を行ってください。",
        409,
      );
    a.status = "archived";
    return this.change(a, revision);
  }
  async restore(id: string, revision: number) {
    const a = await this.asset(id);
    if (a.status !== "archived")
      throw new DomainError("保管済みではありません。");
    a.status = "draft";
    return this.change(a, revision);
  }
  private async checkCollection(ids: string[]) {
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new DomainError("公開済み画像を重複なく選んでください。");
    for (const id of ids) {
      const a = await this.asset(id);
      if (a.type !== "image" || a.status !== "published")
        throw new DomainError(
          "コレクションには公開済みの画像を選んでください。",
        );
    }
  }
  async createCollection(title: string, ids: string[], description: string) {
    await this.checkCollection(ids);
    const c: Collection = {
      ...base(title),
      kind: "collection",
      description,
      orderedAssetIds: ids,
      active: true,
    };
    entitySchema.parse(c);
    await this.repo.save(c, 0);
    return c;
  }
  async updateCollection(
    id: string,
    revision: number,
    title: string,
    ids: string[],
    description: string,
  ) {
    const c = await this.repo.get(id);
    if (c?.kind !== "collection") throw notFound();
    await this.checkCollection(ids);
    c.title = title;
    c.description = description;
    c.orderedAssetIds = ids;
    c.active = true;
    return this.change(c, revision);
  }
  async resolveShare(slug: string) {
    const e = await this.repo.bySlug(slug);
    if (!e || (e.kind === "asset" ? e.status !== "published" : !e.active))
      throw notFound();
    const assets: {
      id: string;
      title: string;
      type: Asset["type"];
      version: Version;
    }[] = [];
    for (const id of e.kind === "asset" ? [e.id] : e.orderedAssetIds) {
      const a = await this.repo.get(id);
      if (a?.kind !== "asset" || a.status !== "published") continue;
      const v = a.versions.find(
        (v) => v.id === a.currentPublishedVersionId && v.kind === "published",
      );
      if (v)
        assets.push({ id: a.id, title: a.title, type: a.type, version: v });
    }
    return {
      kind: e.kind,
      title: e.title,
      description: e.kind === "collection" ? e.description : "",
      assets,
    };
  }
}
