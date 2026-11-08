from uuid import uuid4
import pytest
from api.database import Database
from battle_contracts.models import BattleEvent, BattleTask, CharacterCreate
from worker.engine import simulate

@pytest.fixture
def db(tmp_path, fighters):
    db = Database(tmp_path / "battles.db")
    for c in fighters:
        db.create_character(CharacterCreate(**c.model_dump(exclude={"id"})), character_id=c.id)
    return db

def new_battle(db, fighters):
    batch = db.create_battles(fighters[0].id, fighters[1].id, 1, "req-1")
    return batch["battle_ids"][0]

def test_battle_and_outbox_are_persisted_atomically(db, fighters):
    bid = new_battle(db, fighters)
    assert db.get_battle(bid)["status"] == "pending"
    rows = db.pending_outbox()
    assert len(rows) == 1 and rows[0]["battle_id"] == bid
    task = BattleTask.model_validate_json(rows[0]["payload"])
    assert task.participants == fighters
    reopened = Database(db.path)
    assert reopened.get_battle(bid)["participants"][0]["name"] == "Astra"

def test_batch_validation_does_not_leave_partial_records(db, fighters):
    with pytest.raises(KeyError):
        db.create_battles(fighters[0].id, uuid4(), 10, "req")
    with pytest.raises(ValueError):
        db.create_battles(fighters[0].id, fighters[0].id, 10, "req")
    assert db.stats()["total"] == 0
    assert db.pending_outbox() == []

def test_confirmed_publication_removes_only_published_outbox_item(db, fighters):
    bid = new_battle(db, fighters)
    db.mark_published(bid)
    assert db.pending_outbox() == []
    assert db.get_battle(bid)["published"] is True

def test_duplicate_results_and_late_processing_never_reopen_or_recount(db, fighters):
    bid = new_battle(db, fighters)
    task = BattleTask.model_validate_json(db.pending_outbox()[0]["payload"])
    done = BattleEvent(battle_id=bid, worker_id="w1", attempt_id="a1", status="completed",
                       result=simulate(task), processing_ms=12.5)
    assert db.apply_event(done) is True
    assert db.apply_event(done) is False
    another = done.model_copy(update={"event_id":uuid4(), "worker_id":"w2"})
    assert db.apply_event(another) is False
    late = BattleEvent(battle_id=bid, worker_id="w2", attempt_id="a2", status="processing")
    assert db.apply_event(late) is False
    assert db.get_battle(bid)["status"] == "completed"
    assert db.stats()["completed"] == 1
    assert db.stats()["workers"] == [{"worker_id":"w1", "completed":1, "failed":0}]
    assert db.stats()["average_processing_ms"] == 12.5

def test_failed_event_and_unknown_battle(db, fighters):
    bid = new_battle(db, fighters)
    event = BattleEvent(battle_id=bid, worker_id="w1", attempt_id="a1", status="failed",error="simulation_error")
    assert db.apply_event(event)
    assert db.get_battle(bid)["error"] == "simulation_error"
    assert db.stats()["failed"] == 1
    assert not db.apply_event(event.model_copy(update={"battle_id":uuid4()}))

def test_batched_records_can_be_paginated_and_filtered(db, fighters):
    batch = db.create_battles(fighters[0].id, fighters[1].id, 10, "req")
    page = db.list_battles(limit=3, offset=2, batch_id=batch["batch_id"])
    assert page["total"] == 10 and len(page["items"]) == 3
    assert db.stats()["unpublished"] == 10
