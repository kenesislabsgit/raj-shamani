"""Persistent browser sessions, account-owned collections and atomic usage limits.

Passwords and provider access/refresh tokens are never stored here. Cognito owns
the user directory. Browser session tokens are random and stored only as hashes.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import secrets
import sqlite3
import time

GUEST_SESSION_SECONDS = 30 * 24 * 60 * 60


class CollectionConflict(ValueError):
    pass


class UsageLimit(ValueError):
    pass


def token_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Accounts:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, email TEXT NOT NULL,
                    csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    token_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
                    expires REAL NOT NULL, return_to TEXT NOT NULL DEFAULT '/');
                CREATE TABLE IF NOT EXISTS collections (
                    owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS usage (
                    owner_id TEXT NOT NULL, period TEXT NOT NULL, count INTEGER NOT NULL,
                    PRIMARY KEY(owner_id,period));
            ''')
            db.execute('BEGIN IMMEDIATE')
            if 'return_to' not in {row['name'] for row in db.execute('PRAGMA table_info(login_attempts)')}:
                db.execute("ALTER TABLE login_attempts ADD COLUMN return_to TEXT NOT NULL DEFAULT '/'")
            if 'public_origin' not in {row['name'] for row in db.execute('PRAGMA table_info(login_attempts)')}:
                db.execute("ALTER TABLE login_attempts ADD COLUMN public_origin TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def begin_login(self, return_to='/', *, public_origin=''):
        state, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
        with self.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE expires<=?', (time.time(),))
            # Bound storage even if an unauthenticated caller repeatedly opens login.
            if db.execute('SELECT count(*) FROM login_attempts').fetchone()[0] >= 1000:
                raise UsageLimit('Sign-in is busy. Please try again shortly.')
            db.execute('INSERT INTO login_attempts(token_hash,verifier,nonce,expires,return_to,public_origin) VALUES(?,?,?,?,?,?)',
                       (token_hash(state), verifier, nonce, time.time() + 600, return_to, public_origin))
        return state, verifier, nonce

    def consume_login(self, state):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM login_attempts WHERE token_hash=?', (token_hash(state),)).fetchone()
            db.execute('DELETE FROM login_attempts WHERE token_hash=?', (token_hash(state),))
        return dict(row) if row and row['expires'] > time.time() else None

    def create_session(self, owner_id, email, seconds=3600):
        return self._create_session(owner_id, email, min(seconds, 3600))

    def create_guest_session(self):
        return self._create_session('guest-' + secrets.token_urlsafe(32), '', GUEST_SESSION_SECONDS, guest=True)

    def _create_session(self, owner_id, email, seconds, *, guest=False):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            if guest and db.execute("SELECT count(*) FROM sessions WHERE owner_id LIKE 'guest-%'").fetchone()[0] >= 10000:
                raise UsageLimit('The archive is busy. Please try again later.')
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',
                       (token_hash(token), owner_id, email, csrf, time.time() + seconds))
        return token

    def session(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 200:
            return None
        with self.connect() as db:
            row = db.execute('SELECT owner_id,email,csrf,expires FROM sessions WHERE token_hash=? AND expires>?',
                             (token_hash(token), time.time())).fetchone()
        return dict(row) if row else None

    def logout(self, token):
        with self.connect() as db:
            db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(token),))

    def collections(self, owner_id):
        with self.connect() as db:
            row = db.execute('SELECT revision,document FROM collections WHERE owner_id=?', (owner_id,)).fetchone()
        return {'revision': row['revision'], 'items': json.loads(row['document'])} if row else {
            'revision': 0, 'items': [{'id': 'watch-later', 'name': 'Watch later', 'items': []}]}

    def save_collections(self, owner_id, revision, items):
        if type(revision) is not int or revision < 0 or not isinstance(items, list) or len(items) > 100:
            raise ValueError('Invalid collection update.')
        ids = set()
        for collection in items:
            if (not isinstance(collection, dict) or set(collection) != {'id', 'name', 'items'} or
                    not isinstance(collection['id'], str) or not 1 <= len(collection['id']) <= 80 or
                    collection['id'] in ids or not isinstance(collection['name'], str) or
                    not 1 <= len(collection['name'].strip()) <= 60 or
                    not isinstance(collection['items'], list) or len(collection['items']) > 200):
                raise ValueError('Invalid collection.')
            ids.add(collection['id'])
            for item in collection['items']:
                if (not isinstance(item, dict) or not isinstance(item.get('id'), str) or
                        not re.fullmatch(r'[A-Za-z0-9_-]{11}', item['id']) or
                        not isinstance(item.get('title'), str) or len(item['title']) > 700 or
                        item.get('kind') not in {'episode', 'moment'} or
                        set(item) - {'id', 'title', 'kind', 'start', 'end', 'quote', 'clip_title', 'summary'}):
                    raise ValueError('Invalid saved moment.')
                for field, maximum in [('clip_title', 80), ('summary', 400)]:
                    if field in item and (not isinstance(item[field], str) or len(item[field]) > maximum):
                        raise ValueError('Invalid saved clip description.')
                if item['kind'] == 'moment':
                    if (not isinstance(item.get('quote'), str) or len(item['quote']) > 30000 or
                            type(item.get('start')) not in (int, float) or type(item.get('end')) not in (int, float) or
                            not 0 <= item['start'] <= item['end'] <= 604800):
                        raise ValueError('Invalid saved timestamp or excerpt.')
        encoded = json.dumps(items, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > 2_000_000:
            raise ValueError('Your saved collections are full. Remove some moments before saving more.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision FROM collections WHERE owner_id=?', (owner_id,)).fetchone()
            if (row['revision'] if row else 0) != revision:
                raise CollectionConflict('Your collections changed in another tab. Reload them before saving again.')
            db.execute('INSERT INTO collections VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,document=excluded.document',
                       (owner_id, revision + 1, encoded))
        return {'revision': revision + 1, 'items': items}

    def reserve_question(self, owner_id, per_day=20, global_per_day=200, *, network_id=None):
        period = time.strftime('%Y-%m-%d', time.gmtime())
        limits = {owner_id: per_day, '*': global_per_day}
        if network_id:
            limits['network-' + network_id] = per_day
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM usage WHERE period<?', (period,))
            for key, limit in limits.items():
                row = db.execute('SELECT count FROM usage WHERE owner_id=? AND period=?', (key, period)).fetchone()
                if row and row['count'] >= limit:
                    raise UsageLimit('The daily question limit has been reached. Please try again tomorrow.')
            for key in limits:
                db.execute('INSERT INTO usage VALUES(?,?,1) ON CONFLICT(owner_id,period) DO UPDATE SET count=count+1',
                           (key, period))
