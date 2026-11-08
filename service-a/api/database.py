"""SQLite persistence, transactional outbox and idempotent event application."""
import json
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from battle_contracts.models import BattleEvent, BattleTask, Character, CharacterCreate, utcnow
from .adventures import initialize_schema, apply_result
from .persistence import insert_battle

class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS characters (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS battles (
                    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, status TEXT NOT NULL,
                    request_id TEXT NOT NULL, task_json TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    worker_id TEXT, result_json TEXT, error TEXT, processing_ms REAL
                );
                CREATE TABLE IF NOT EXISTS outbox (
                    battle_id TEXT PRIMARY KEY REFERENCES battles(id),
                    payload TEXT NOT NULL, published_at TEXT
                );
                CREATE TABLE IF NOT EXISTS battle_events (
                    event_id TEXT PRIMARY KEY, battle_id TEXT NOT NULL REFERENCES battles(id)
                );
                CREATE INDEX IF NOT EXISTS battles_batch ON battles(batch_id);
                CREATE INDEX IF NOT EXISTS battles_status ON battles(status);
                CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox(published_at);
            """)
            initialize_schema(db)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(str(self.path), timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def ping(self):
        with self.connection() as db:
            return db.execute("SELECT 1").fetchone()[0] == 1

    def create_character(self, data: CharacterCreate, character_id=None):
        character = Character(id=character_id or uuid4(), **data.model_dump())
        with self.connection() as db:
            db.execute("INSERT INTO characters VALUES (?, ?, ?)",
                       (str(character.id), character.model_dump_json(), utcnow().isoformat()))
        return character.model_dump(mode="json")

    def get_character(self, character_id):
        with self.connection() as db:
            row = db.execute("SELECT payload FROM characters WHERE id=?", (str(character_id),)).fetchone()
        if row is None:
            raise KeyError("Character not found")
        return json.loads(row["payload"])

    def list_characters(self, limit=50, offset=0):
        with self.connection() as db:
            total = db.execute("SELECT COUNT(*) FROM characters").fetchone()[0]
            rows = db.execute("SELECT payload FROM characters ORDER BY created_at, id LIMIT ? OFFSET ?",
                              (limit, offset)).fetchall()
        return {"items": [json.loads(x["payload"]) for x in rows], "total": total, "limit": limit, "offset": offset}

    def create_battles(self, character_a_id, character_b_id, count: int, request_id: str):
        if character_a_id == character_b_id:
            raise ValueError("Choose two different characters")
        if type(count) is not int or not 1 <= count <= 1000:
            raise ValueError("Batch must contain between 1 and 1000 battles")
        batch_id = str(uuid4())
        battle_ids = []
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            characters = []
            for cid in (character_a_id, character_b_id):
                row = db.execute("SELECT payload FROM characters WHERE id=?", (str(cid),)).fetchone()
                if row is None:
                    raise KeyError("Character not found")
                characters.append(Character.model_validate_json(row["payload"]))
            for _ in range(count):
                task = BattleTask(battle_id=uuid4(), participants=tuple(characters), seed=secrets.randbits(63),
                                  request_id=request_id)
                bid = insert_battle(db, task, batch_id)
                battle_ids.append(bid)
        return {"batch_id": batch_id, "battle_ids": battle_ids, "count": count, "status": "pending"}

    def pending_outbox(self, limit=100):
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT battle_id,payload FROM outbox WHERE published_at IS NULL ORDER BY rowid LIMIT ?",(limit,))]

    def mark_published(self, battle_id):
        with self.connection() as db:
            db.execute("UPDATE outbox SET published_at=? WHERE battle_id=? AND published_at IS NULL",
                       (utcnow().isoformat(), str(battle_id)))

    @staticmethod
    def battle_from_row(row, detail=True):
        item = dict(row)
        task = json.loads(item.pop("task_json"))
        item["participants"] = task["participants"]
        item["seed"] = task["seed"]
        item["published"] = bool(item.pop("published_at"))
        result = item.pop("result_json")
        item["result"] = json.loads(result) if result and detail else None
        if not detail and result:
            parsed = json.loads(result)
            item["result"] = {k: parsed[k] for k in ("outcome","winner_id","turns","total_damage","final_hp")}
        return item

    def get_battle(self, battle_id):
        with self.connection() as db:
            row = db.execute("""SELECT b.*,o.published_at FROM battles b JOIN outbox o ON o.battle_id=b.id
                               WHERE b.id=?""", (str(battle_id),)).fetchone()
            adventure = db.execute('SELECT adventure_id AS id,stage,hero_id,hero_level FROM adventure_battles WHERE battle_id=?',
                                   (str(battle_id),)).fetchone()
        if row is None:
            raise KeyError("Battle not found")
        battle = self.battle_from_row(row)
        if adventure:
            battle['adventure'] = dict(adventure)
        return battle

    def list_battles(self, limit=20, offset=0, status=None, batch_id=None):
        filters, values = [], []
        for field, value in (("status", status), ("batch_id", batch_id)):
            if value is not None:
                filters.append("b." + field + "=?")
                values.append(str(value))
        where = " WHERE " + " AND ".join(filters) if filters else ""
        with self.connection() as db:
            total = db.execute("SELECT COUNT(*) FROM battles b" + where, values).fetchone()[0]
            rows = db.execute("""SELECT b.*,o.published_at FROM battles b JOIN outbox o ON o.battle_id=b.id""" +
                              where + " ORDER BY b.created_at DESC,b.rowid DESC LIMIT ? OFFSET ?",
                              [*values,limit,offset]).fetchall()
        return {"items":[self.battle_from_row(x,detail=False) for x in rows],"total":total,"limit":limit,"offset":offset}

    def apply_event(self, event: BattleEvent) -> bool:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM battles WHERE id=?", (str(event.battle_id),)).fetchone()
            if row is None or row["status"] in ("completed", "failed"):
                return False
            inserted = db.execute("INSERT OR IGNORE INTO battle_events VALUES (?,?)",
                                  (str(event.event_id),str(event.battle_id)))
            if inserted.rowcount == 0:
                return False
            db.execute("""UPDATE battles SET status=?,updated_at=?,worker_id=?,result_json=?,error=?,processing_ms=?
                          WHERE id=?""", (event.status,utcnow().isoformat(),event.worker_id,
                          event.result.model_dump_json() if event.result else None,
                          event.error,event.processing_ms,str(event.battle_id)))
            apply_result(db, event)
        return True

    def stats(self):
        with self.connection() as db:
            counts = {row["status"]:row["n"] for row in db.execute(
                "SELECT status,COUNT(*) n FROM battles GROUP BY status")}
            unpublished = db.execute("SELECT COUNT(*) FROM outbox WHERE published_at IS NULL").fetchone()[0]
            avg = db.execute("SELECT AVG(processing_ms) FROM battles WHERE status='completed'").fetchone()[0]
            workers = [dict(row) for row in db.execute("""
                SELECT worker_id,
                       SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
                       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
                FROM battles WHERE status IN ('completed','failed') GROUP BY worker_id ORDER BY worker_id
            """)]
        return {"total":sum(counts.values()),**{k:counts.get(k,0) for k in ("pending","processing","completed","failed")},
                "unpublished":unpublished,"average_processing_ms":round(avg or 0,2),"workers":workers}
