from uuid import uuid4
import pytest
from api.database import Database
from battle_contracts.models import BattleEvent, BattleTask, CharacterCreate
from worker.engine import simulate

@pytest.fixture
def traced(tmp_path, fighters):
    db = Database(tmp_path / 'trace.db')
    for c in fighters:
        db.create_character(CharacterCreate(**c.model_dump(exclude={'id'})), character_id=c.id)
    bid = db.create_battles(fighters[0].id, fighters[1].id, 1, 'trace-request')['battle_ids'][0]
    task = BattleTask.model_validate_json(db.pending_outbox()[0]['payload'])
    return db, bid, task

def test_trace_survives_reopen_and_publication_is_once(traced):
    db, bid, task = traced
    first = db.battle_trace(bid)
    assert first['coverage'] == 'from_creation'
    assert first['request_id'] == 'trace-request'
    assert [e['event_type'] for e in first['items']] == ['accepted']
    db.mark_published(bid)
    db.mark_published(bid)
    trace = Database(db.path).battle_trace(bid)
    assert [e['event_type'] for e in trace['items']] == ['accepted', 'published']
    assert trace['published_at'] == trace['items'][1]['occurred_at']

def test_trace_records_retry_and_duplicate_deliveries_without_recounting(traced):
    db, bid, task = traced
    a = BattleEvent(battle_id=bid, worker_id='worker-a', attempt_id='attempt-a', status='processing')
    b = BattleEvent(battle_id=bid, worker_id='worker-b', attempt_id='attempt-b', status='processing')
    done = BattleEvent(battle_id=bid, worker_id='worker-b', attempt_id='attempt-b', status='completed', result=simulate(task), processing_ms=42)
    for event in (a, b, done):
        assert db.apply_event(event)
    assert not db.apply_event(done)
    late = a.model_copy(update={'event_id': uuid4()})
    assert not db.apply_event(late)
    trace = db.battle_trace(bid)
    assert trace['total'] == 5
    assert trace['items'][3]['deliveries'] == 2
    assert trace['items'][3]['applied'] is True
    assert trace['items'][4]['applied'] is False
    assert trace['items'][4]['reason'] == 'already_terminal'
    assert db.stats()['completed'] == 1
    assert db.get_battle(bid)['worker_id'] == 'worker-b'
    assert db.battle_trace(bid, limit=2, offset=2)['items'] == trace['items'][2:4]
    assert db.battle_trace(bid, limit=2, offset=99)['items'] == []

def test_unknown_battle_and_legacy_coverage_are_explicit(traced):
    db, bid, task = traced
    with pytest.raises(KeyError):
        db.battle_trace(uuid4())
    with db.connection() as conn:
        conn.execute('DELETE FROM battle_trace WHERE battle_id=?', (bid,))
    trace = db.battle_trace(bid)
    assert trace['coverage'] == 'legacy_partial'
    assert trace['items'] == []
    db.mark_published(bid)
    assert db.battle_trace(bid)['coverage'] == 'legacy_partial'

def test_trace_and_state_roll_back_together(traced):
    db, bid, task = traced
    with db.connection() as conn:
        conn.execute("CREATE TRIGGER reject_trace BEFORE INSERT ON battle_trace WHEN NEW.event_type='processing' BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
    event = BattleEvent(battle_id=bid, worker_id='worker', attempt_id='attempt', status='processing')
    with pytest.raises(Exception, match='test rollback'):
        db.apply_event(event)
    assert db.get_battle(bid)['status'] == 'pending'
    assert db.battle_trace(bid)['total'] == 1
    with db.connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM battle_events').fetchone()[0] == 0

def test_publication_confirmation_can_be_observed_after_worker_event(traced):
    db, bid, task = traced
    event = BattleEvent(battle_id=bid, worker_id='fast-worker', attempt_id='fast-attempt', status='processing')
    db.apply_event(event)
    db.mark_published(bid)
    trace = db.battle_trace(bid)
    assert [e['event_type'] for e in trace['items']] == ['accepted', 'processing', 'published']
    assert trace['items'][1]['occurred_at'] == event.occurred_at.isoformat()
    assert trace['items'][1]['observed_at'] >= event.occurred_at.isoformat()


def test_acceptance_trace_is_atomic_with_outbox(traced):
    db, bid, task = traced
    with db.connection() as conn:
        conn.execute("CREATE TRIGGER reject_acceptance BEFORE INSERT ON battle_trace WHEN NEW.event_type='accepted' BEGIN SELECT RAISE(ABORT, 'test acceptance'); END")
    with pytest.raises(Exception, match='test acceptance'):
        db.create_battles(task.participants[0].id, task.participants[1].id, 2, 'rollback')
    assert db.stats()['total'] == 1
    assert len(db.pending_outbox()) == 1
