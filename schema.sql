-- Inknote sync database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- notes and folders (metadata only; note bodies live in blobs)
CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  data TEXT,
  body_key TEXT,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS items_seq ON items(user_id, seq);

-- binary data split into chunks (gzipped note bodies, images, PDF pages, audio)
CREATE TABLE IF NOT EXISTS blobs (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  part INTEGER NOT NULL,
  parts INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (user_id, key, part)
);

CREATE TABLE IF NOT EXISTS attempts (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
