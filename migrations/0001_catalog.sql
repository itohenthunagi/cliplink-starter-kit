CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  body TEXT NOT NULL CHECK(json_valid(body))
);
