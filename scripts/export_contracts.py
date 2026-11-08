"""Regenerate versioned JSON schemas from the shared Pydantic contracts."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root / "contracts"))
from battle_contracts.models import BattleTask, BattleEvent

target = root / "contracts" / "schemas"
target.mkdir(parents=True,exist_ok=True)
for filename, model in [("battle-task-v1.schema.json",BattleTask),("battle-event-v1.schema.json",BattleEvent)]:
    (target / filename).write_text(json.dumps(model.model_json_schema(),ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(target / filename)
