"""Local response history: generated answers and safe error responses, never credentials."""
from contextlib import contextmanager
import copy
import json
import os
import re
import sqlite3


class ResponseHistory:
    def __init__(self, path):
        self.path = path
        self.owner_id = None
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS responses (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, question TEXT NOT NULL,
                status TEXT NOT NULL, record TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS response_date ON responses(created_at DESC,id)")
            if 'owner_id' not in {row[1] for row in db.execute('PRAGMA table_info(responses)')}:
                db.execute('ALTER TABLE responses ADD COLUMN owner_id TEXT')
            db.execute('CREATE INDEX IF NOT EXISTS response_owner_date ON responses(owner_id,created_at DESC,id)')

    def for_owner(self, owner_id):
        if not isinstance(owner_id, str) or not owner_id or len(owner_id) > 200:
            raise ValueError('A signed-in account is required.')
        scoped = copy.copy(self)
        scoped.owner_id = owner_id
        return scoped

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def save(self, record):
        # Defense in depth if a credential is pasted into a question or echoed by a model.
        encoded = json.dumps(record, ensure_ascii=False)
        for name in ("OPENAI_API_KEY", "GROQ_API_KEY", "SUPERMEMORY_API_KEY", "DEEPGRAM_API_KEY", "HF_TOKEN", "GOOGLE_CLIENT_SECRET", "FRONTEND_PROXY_SECRET"):
            value = os.getenv(name)
            if value:
                encoded = encoded.replace(json.dumps(value, ensure_ascii=False)[1:-1], "[redacted]")
        safe = json.loads(encoded)
        with self.connect() as db:
            db.execute("INSERT INTO responses(id,created_at,question,status,record,owner_id) VALUES(?,?,?,?,?,?)", (
                safe["id"], safe["created_at"], safe["question"], safe["status"], encoded, self.owner_id))

    def list(self, offset=0, limit=20):
        if not 0 <= offset <= 1_000_000:
            raise ValueError("Invalid history offset.")
        with self.connect() as db:
            rows = db.execute("SELECT id,created_at,question,status FROM responses WHERE owner_id IS ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (self.owner_id, limit, offset))
            items = [dict(row) for row in rows]
            total = db.execute("SELECT count(*) FROM responses WHERE owner_id IS ?", (self.owner_id,)).fetchone()[0]
        return {"items": items, "total": total, "offset": offset}

    def get(self, record_id):
        if not re.fullmatch(r"[a-f0-9]{32}", record_id):
            raise ValueError("Invalid response ID.")
        with self.connect() as db:
            row = db.execute("SELECT record FROM responses WHERE id=? AND owner_id IS ?", (record_id, self.owner_id)).fetchone()
        return json.loads(row["record"]) if row else None
