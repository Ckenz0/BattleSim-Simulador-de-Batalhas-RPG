"""Campaign progress and rewards committed with battle events in SQLite."""
import json
import secrets
from uuid import uuid4

from battle_contracts.models import BattleTask, Character, utcnow
from .adventure_catalog import BASES, INITIAL_GAINS, UPGRADES, CAPS, STAGES
from .persistence import insert_battle

class AdventureConflict(Exception):
    pass

def initialize_schema(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS adventures (
            id TEXT PRIMARY KEY, character_id TEXT NOT NULL UNIQUE REFERENCES characters(id),
            stage INTEGER NOT NULL, level INTEGER NOT NULL, status TEXT NOT NULL,
            last_battle_id TEXT REFERENCES battles(id), last_outcome TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS adventure_battles (
            battle_id TEXT PRIMARY KEY REFERENCES battles(id),
            adventure_id TEXT NOT NULL REFERENCES adventures(id), stage INTEGER NOT NULL,
            hero_id TEXT NOT NULL, hero_level INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS adventure_rewards (
            battle_id TEXT PRIMARY KEY REFERENCES adventure_battles(battle_id),
            attribute TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS adventure_attempts ON adventure_battles(adventure_id);
    ''')

def apply_result(db, event):
    if event.status == 'processing':
        return
    run = db.execute('''SELECT a.*, ab.hero_id FROM adventures a JOIN adventure_battles ab
        ON ab.adventure_id=a.id WHERE ab.battle_id=? AND a.last_battle_id=ab.battle_id
        AND a.status='pending' ''', (str(event.battle_id),)).fetchone()
    if run is None:
        return
    won = event.status == 'completed' and str(event.result.winner_id) == run['hero_id']
    outcome = 'victory' if won else ('failed' if event.status == 'failed' else
              'draw' if event.result.outcome == 'draw' else 'defeat')
    db.execute('UPDATE adventures SET status=?,level=level+?,last_outcome=?,updated_at=? WHERE id=?',
               ('reward' if won else 'ready', int(won), outcome, utcnow().isoformat(), run['id']))

class AdventureStore:
    def __init__(self, database):
        self.database = database

    @staticmethod
    def _row(db, adventure_id):
        row = db.execute('SELECT * FROM adventures WHERE id=?', (str(adventure_id),)).fetchone()
        if row is None:
            raise KeyError('Aventura não encontrada')
        return row

    def get(self, adventure_id):
        with self.database.connection() as db:
            db.execute('BEGIN')  # Run and hero belong to the same read snapshot during upgrades.
            run = dict(self._row(db, adventure_id))
            run['hero'] = json.loads(db.execute('SELECT payload FROM characters WHERE id=?',
                                    (run['character_id'],)).fetchone()[0])
        run['total_stages'] = len(STAGES)
        run['current_stage'] = STAGES[run['stage'] - 1] if run['stage'] <= len(STAGES) else None
        run['upgrades'] = {key: gain for key, gain in UPGRADES.items() if run['hero'][key] < CAPS[key]}
        return run

    def list(self, limit=50, offset=0):
        with self.database.connection() as db:
            total = db.execute('SELECT COUNT(*) FROM adventures').fetchone()[0]
            ids = [row[0] for row in db.execute('SELECT id FROM adventures ORDER BY created_at DESC LIMIT ? OFFSET ?',
                                               (limit, offset))]
        return dict(items=[self.get(aid) for aid in ids], total=total, limit=limit, offset=offset)

    def create(self, data):
        aid, now = str(uuid4()), utcnow().isoformat()
        stats = {key: value + data.allocation.model_dump()[key] * INITIAL_GAINS[key]
                 for key, value in BASES[data.class_name.value].items()}
        hero = Character(id=uuid4(), name=data.name, class_name=data.class_name, **stats)
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO characters VALUES (?,?,?)', (str(hero.id), hero.model_dump_json(), now))
            db.execute('''INSERT INTO adventures
                (id,character_id,stage,level,status,created_at,updated_at) VALUES (?,?,1,1,'ready',?,?)''',
                (aid, str(hero.id), now, now))
        return self.get(aid)

    def start(self, adventure_id, request_id):
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            run = self._row(db, adventure_id)
            if run['status'] == 'pending':
                bid = run['last_battle_id']
            elif run['status'] != 'ready':
                raise AdventureConflict('Escolha sua melhoria antes de avançar' if run['status'] == 'reward'
                                        else 'Esta aventura já foi concluída')
            else:
                hero = Character.model_validate_json(db.execute('SELECT payload FROM characters WHERE id=?',
                                                     (run['character_id'],)).fetchone()[0])
                stage = STAGES[run['stage'] - 1]
                rival = Character(id=uuid4(), **{key: value for key, value in stage.items() if key != 'number'})
                task = BattleTask(battle_id=uuid4(), participants=(hero, rival), seed=secrets.randbits(63),
                                  request_id=request_id)
                bid = insert_battle(db, task)
                db.execute('INSERT INTO adventure_battles VALUES (?,?,?,?,?)',
                           (bid, str(adventure_id), run['stage'], str(hero.id), run['level']))
                db.execute("UPDATE adventures SET status='pending',last_battle_id=?,updated_at=? WHERE id=?",
                           (bid, utcnow().isoformat(), str(adventure_id)))
        return self.database.get_battle(bid)

    def upgrade(self, adventure_id, claim):
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            run = self._row(db, adventure_id)
            old = db.execute('''SELECT r.attribute,ab.adventure_id FROM adventure_rewards r
                JOIN adventure_battles ab ON ab.battle_id=r.battle_id WHERE r.battle_id=?''',
                (str(claim.battle_id),)).fetchone()
            if old:
                if old['adventure_id'] != str(adventure_id) or old['attribute'] != claim.attribute:
                    raise AdventureConflict('Essa recompensa já foi escolhida')
            else:
                if run['status'] != 'reward' or run['last_battle_id'] != str(claim.battle_id):
                    raise AdventureConflict('Não há recompensa disponível para essa batalha')
                hero = json.loads(db.execute('SELECT payload FROM characters WHERE id=?',
                                            (run['character_id'],)).fetchone()[0])
                key = claim.attribute
                if hero[key] >= CAPS[key]:
                    raise AdventureConflict('Esse atributo já atingiu o limite')
                hero[key] = min(CAPS[key], hero[key] + UPGRADES[key])
                validated = Character.model_validate(hero)
                db.execute('UPDATE characters SET payload=? WHERE id=?', (validated.model_dump_json(), run['character_id']))
                db.execute('INSERT INTO adventure_rewards VALUES (?,?)', (str(claim.battle_id), key))
                db.execute('UPDATE adventures SET stage=stage+1,status=?,updated_at=? WHERE id=?',
                           ('completed' if run['stage'] == len(STAGES) else 'ready', utcnow().isoformat(), str(adventure_id)))
        return self.get(adventure_id)
