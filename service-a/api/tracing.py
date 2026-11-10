"""Durable observations, written inside the caller's battle transaction."""
def initialize_trace(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS battle_trace (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            battle_id TEXT NOT NULL REFERENCES battles(id),
            event_key TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            event_id TEXT, worker_id TEXT, attempt_id TEXT,
            occurred_at TEXT NOT NULL, observed_at TEXT NOT NULL,
            applied INTEGER NOT NULL, reason TEXT,
            deliveries INTEGER NOT NULL DEFAULT 1,
            last_received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS trace_battle ON battle_trace(battle_id,id);
    """)


def record_trace(db, battle_id, event_key, event_type, occurred_at, observed_at,
                 *, event_id=None, worker_id=None, attempt_id=None, applied=True, reason=None):
    db.execute("""INSERT INTO battle_trace
        (battle_id,event_key,event_type,event_id,worker_id,attempt_id,occurred_at,
         observed_at,applied,reason,last_received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (str(battle_id), event_key, event_type, event_id, worker_id, attempt_id,
         occurred_at, observed_at, int(applied), reason, observed_at))


def read_trace(db, battle_id, limit, offset):
    row = db.execute("""SELECT b.id AS battle_id,b.request_id,b.batch_id,b.status,
        b.created_at,b.updated_at,o.published_at FROM battles b
        JOIN outbox o ON o.battle_id=b.id WHERE b.id=?""", (str(battle_id),)).fetchone()
    if row is None:
        raise KeyError("Battle not found")
    result = dict(row)
    coverage = db.execute("SELECT 1 FROM battle_trace WHERE battle_id=? AND event_type='accepted'",
                          (str(battle_id),)).fetchone()
    result['coverage'] = 'from_creation' if coverage else 'legacy_partial'
    result['total'] = db.execute('SELECT COUNT(*) FROM battle_trace WHERE battle_id=?',
                                 (str(battle_id),)).fetchone()[0]
    rows = db.execute("""SELECT id,event_type,event_id,worker_id,attempt_id,occurred_at,
        observed_at,applied,reason,deliveries,last_received_at FROM battle_trace
        WHERE battle_id=? ORDER BY id LIMIT ? OFFSET ?""", (str(battle_id),limit,offset))
    result['items'] = [dict(item) | {'applied': bool(item['applied'])} for item in rows]
    return result | {'limit': limit, 'offset': offset}
