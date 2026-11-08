import json
import pytest
from pydantic import ValidationError
from battle_contracts.models import CharacterCreate, BattleTask, BattleEvent

def test_names_are_trimmed_and_empty_names_rejected():
    data = dict(name="  Aria  ", class_name="archer", hp=100, attack=20, defense=10, speed=50)
    assert CharacterCreate(**data).name == "Aria"
    with pytest.raises(ValidationError):
        CharacterCreate(**(data | {"name": "   "}))

@pytest.mark.parametrize(("field","value"), [("hp",0),("hp",1001),("attack",201),("defense",-1),("speed",101),("hp",True),("attack",3.5)])
def test_stats_are_bounded_integers(field, value):
    data = dict(name="Aria", class_name="archer", hp=100, attack=20, defense=10, speed=50)
    with pytest.raises(ValidationError):
        CharacterCreate(**(data | {field:value}))

def test_task_json_roundtrip_and_version_rejection(task):
    assert BattleTask.model_validate_json(task.model_dump_json()) == task
    invalid = json.loads(task.model_dump_json()) | {"schema_version": 2}
    with pytest.raises(ValidationError):
        BattleTask.model_validate(invalid)

def test_terminal_event_requires_matching_payload(task):
    with pytest.raises(ValidationError):
        BattleEvent(battle_id=task.battle_id, worker_id="worker-1", attempt_id="attempt-1", status="completed")
    with pytest.raises(ValidationError):
        BattleEvent(battle_id=task.battle_id, worker_id="worker-1", attempt_id="attempt-1", status="failed")

def test_same_fighter_is_rejected(task):
    with pytest.raises(ValidationError):
        BattleTask.model_validate(task.model_dump() | {"participants": [task.participants[0],task.participants[0]]})
