import { describe, it, expect } from "vitest";
import { Library, MemoryRepository, DomainError } from "../src/core/library";
import type { Version } from "../src/core/model";
const version = (kind: Version["kind"] = "original"): Version => ({
  id: crypto.randomUUID(),
  kind,
  relativePath: `assets/${crypto.randomUUID()}/${kind}/${crypto.randomUUID()}.png`,
  mime: "image/png",
  size: 8,
  sha256: "a".repeat(64),
  createdAt: new Date().toISOString(),
  createdBy: "user",
});
const setup = () => new Library(new MemoryRepository());
describe("資産と公開状態", () => {
  it("原本・作業版・公開版を分離し、公開更新してもURLが変わらない", async () => {
    const lib = setup();
    const original = version();
    let a = await lib.createAsset({ title: "説明", version: original });
    const slug = a.slug;
    const work = version("working");
    a = await lib.addVersion(a.id, a.revision, work);
    expect(a.currentPublishedVersionId).toBeNull();
    a = await lib.publish(a.id, a.revision, version("published"));
    const first = a.currentPublishedVersionId;
    a = await lib.publish(a.id, a.revision, version("published"));
    expect(a.slug).toBe(slug);
    expect(a.versions[0]).toEqual(original);
    expect(a.versions.some((v) => v.id === first)).toBe(true);
    expect((await lib.resolveShare(slug)).assets[0].version.id).toBe(
      a.currentPublishedVersionId,
    );
  });
  it("共有停止はコレクション経由の参照も遮断し、原本を残す", async () => {
    const lib = setup();
    let a = await lib.createAsset({
      title: "非公開メモ",
      notes: "秘密",
      version: version(),
    });
    a = await lib.publish(a.id, a.revision, version("published"));
    const c = await lib.createCollection("手順", [a.id], "公開説明");
    expect((await lib.resolveShare(c.slug)).assets).toHaveLength(1);
    await lib.revoke(a.id, a.revision);
    a = await lib.asset(a.id);
    await expect(lib.resolveShare(a.slug)).rejects.toMatchObject({
      status: 404,
    });
    expect((await lib.resolveShare(c.slug)).assets).toHaveLength(0);
    expect(a.versions).toHaveLength(2);
  });
  it("古い画面からの更新を拒否する", async () => {
    const lib = setup();
    const a = await lib.createAsset({ title: "競合", version: version() });
    await lib.updateAsset(a.id, a.revision, { title: "先の編集" });
    await expect(
      lib.updateAsset(a.id, a.revision, { title: "後の編集" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await lib.asset(a.id)).title).toBe("先の編集");
  });
  it("公開中・保護中・公開コレクション利用中は保管済みへ移せない", async () => {
    const lib = setup();
    let a = await lib.createAsset({ title: "保護", version: version() });
    a = await lib.updateAsset(a.id, a.revision, { protected: true });
    await expect(lib.archive(a.id, a.revision)).rejects.toBeInstanceOf(
      DomainError,
    );
    a = await lib.updateAsset(a.id, a.revision, { protected: false });
    a = await lib.publish(a.id, a.revision, version("published"));
    await expect(lib.archive(a.id, a.revision)).rejects.toMatchObject({
      status: 409,
    });
    const c = await lib.createCollection("利用中", [a.id], "");
    await lib.revoke(a.id, a.revision);
    a = await lib.asset(a.id);
    await expect(lib.archive(a.id, a.revision)).rejects.toMatchObject({
      status: 409,
    });
    await lib.revoke(c.id, c.revision);
    expect((await lib.archive(a.id, a.revision)).status).toBe("archived");
  });
  it("コレクションの順序を保持し、非公開の資産は登録できない", async () => {
    const lib = setup();
    let a = await lib.createAsset({ title: "A", version: version() });
    let b = await lib.createAsset({ title: "B", version: version() });
    await expect(
      lib.createCollection("下書き", [a.id], ""),
    ).rejects.toMatchObject({ status: 400 });
    a = await lib.publish(a.id, a.revision, version("published"));
    b = await lib.publish(b.id, b.revision, version("published"));
    const c = await lib.createCollection("順番", [b.id, a.id], "");
    expect((await lib.resolveShare(c.slug)).assets.map((a) => a.title)).toEqual(
      ["B", "A"],
    );
    await expect(
      lib.createCollection("重複", [a.id, a.id], ""),
    ).rejects.toMatchObject({ status: 400 });
  });
});
