import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { conflict, DomainError } from "../core/library";
import { entitySchema, type Entity, type Repository } from "../core/model";
export const schema =
  "CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL)";
export class SqliteRepository implements Repository {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(schema);
  }
  private parse(row: unknown): Entity | null {
    return row
      ? entitySchema.parse(JSON.parse((row as { body: string }).body))
      : null;
  }
  async get(id: string) {
    return this.parse(
      this.db.prepare("SELECT body FROM entities WHERE id=?").get(id),
    );
  }
  async bySlug(slug: string) {
    return this.parse(
      this.db.prepare("SELECT body FROM entities WHERE slug=?").get(slug),
    );
  }
  async list() {
    return this.db
      .prepare("SELECT body FROM entities")
      .all()
      .map((row) => this.parse(row)!);
  }
  async save(e: Entity, expected: number) {
    if (expected === 0) {
      const r = this.db
        .prepare(
          "INSERT OR IGNORE INTO entities(id,slug,revision,body) VALUES(?,?,?,?)",
        )
        .run(e.id, e.slug, e.revision, JSON.stringify(e));
      if (!r.changes) throw conflict();
    } else {
      const r = this.db
        .prepare(
          "UPDATE entities SET body=?, revision=? WHERE id=? AND revision=? AND slug=?",
        )
        .run(JSON.stringify(e), e.revision, e.id, expected, e.slug);
      if (!r.changes) throw conflict();
    }
  }
}
export class RemoteRepository implements Repository {
  constructor(
    private url: string,
    private token: string,
  ) {}
  private async request(path: string, body?: unknown) {
    const r = await fetch(`${this.url}/internal${path}`, {
      method: body ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 409) throw conflict();
    if (r.status === 404) return null;
    if (!r.ok)
      throw new DomainError(
        "共有サーバーに接続できません。変更は確定していません。",
        503,
      );
    return r.json();
  }
  async get(id: string) {
    const e = await this.request(`/entities/${encodeURIComponent(id)}`);
    return e ? entitySchema.parse(e) : null;
  }
  async bySlug(slug: string) {
    const e = await this.request(`/shares/${encodeURIComponent(slug)}`);
    return e ? entitySchema.parse(e) : null;
  }
  async list() {
    return entitySchema.array().parse(await this.request("/entities"));
  }
  async save(entity: Entity, expected: number) {
    await this.request(`/entities/${entity.id}`, { entity, expected });
  }
}
