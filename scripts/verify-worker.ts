import assert from "node:assert/strict";
import { RemoteRepository } from "../src/server/repository";
import { Library } from "../src/core/library";
import type { Version } from "../src/core/model";
const base = "http://127.0.0.1:8789";
const repo = new RemoteRepository(
  base,
  "cliplink-local-runtime-test-token-00000000",
);
const lib = new Library(repo);
const version = (kind: Version["kind"]): Version => ({
  id: crypto.randomUUID(),
  kind,
  relativePath: `assets/${crypto.randomUUID()}/${kind}/${crypto.randomUUID()}.png`,
  mime: "image/png",
  size: 10,
  sha256: "a".repeat(64),
  createdAt: new Date().toISOString(),
  createdBy: "user",
  dropbox: {
    id: "id:test-fixture",
    rev: "test-revision",
    contentHash: "b".repeat(64),
  },
});
assert.equal((await fetch(`${base}/internal/entities`)).status, 401);
let a = await lib.createAsset({
  title: "Worker D1 runtime fixture",
  notes: "private-runtime-note",
  version: version("original"),
});
const first = await repo.get(a.id);
assert.equal(first?.revision, 1);
a = await lib.publish(a.id, a.revision, version("published"));
const share = `${base}/s/${a.slug}`;
const page = await fetch(share);
assert.equal(page.status, 200);
assert.ok(!(await page.text()).includes("private-runtime-note"));
await assert.rejects(() => lib.updateAsset(a.id, 1, { title: "stale" }), {
  status: 409,
});
await lib.revoke(a.id, a.revision);
assert.equal((await fetch(share)).status, 404);
assert.equal((await fetch(`${share}/media/${a.id}`)).status, 404);
assert.equal((await repo.get(a.id))?.kind, "asset");
console.log(
  "PASS: real local Workers/D1 runtime — authentication, persistence, CAS conflict, public redaction, revocation. Dropbox content is not contacted.",
);
