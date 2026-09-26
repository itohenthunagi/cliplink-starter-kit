import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, dropboxHash } from "../src/server/storage";
import type { Dropbox } from "../src/core/dropbox";
it("別端末の保存先に同じfile idのファイルを実体化し、AIへ渡せる", async () => {
  const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const upload = vi.fn(async () => ({
    id: "id:unchanged",
    rev: "revision-1",
    contentHash: dropboxHash(data),
  }));
  const download = vi.fn(async () => new Response(data));
  const cloud = { upload, download } as unknown as Dropbox;
  const first = new FileStore(
    await mkdtemp(join(tmpdir(), "cliplink-device-a-")),
    cloud,
  );
  const second = new FileStore(
    await mkdtemp(join(tmpdir(), "cliplink-device-b-")),
    cloud,
  );
  const version = await first.put(
    crypto.randomUUID(),
    "original",
    data,
    "image/png",
  );
  expect(version.dropbox!.id).toBe("id:unchanged");
  const path = await second.materialize(version);
  expect(new Uint8Array(await readFile(path))).toEqual(data);
  expect(download).toHaveBeenCalledWith(version);
  expect(upload).toHaveBeenCalledTimes(1);
  await writeFile(path, "external edits");
  await expect(second.materialize(version)).rejects.toMatchObject({
    status: 409,
  });
  expect(await readFile(path, "utf8")).toBe("external edits");
});
it("Dropboxへの保存失敗でもローカル原本が残る", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliplink-offline-"));
  const upload = vi.fn(
    async (_path: string, _data: Uint8Array, _hash: string) => {
      throw new Error("offline");
    },
  );
  const store = new FileStore(root, { upload } as unknown as Dropbox);
  await expect(
    store.put(
      crypto.randomUUID(),
      "original",
      new Uint8Array([1, 2, 3]),
      "image/png",
    ),
  ).rejects.toThrow("offline");
  const relative = String(upload.mock.calls[0]?.[0] || "");
  expect(relative).toContain("/original/");
  expect(
    new Uint8Array(
      await readFile(join(root, relative.replace("/ScreenShare/", ""))),
    ),
  ).toEqual(new Uint8Array([1, 2, 3]));
});
