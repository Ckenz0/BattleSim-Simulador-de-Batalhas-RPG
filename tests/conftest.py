from uuid import uuid4
import pytest
from battle_contracts.models import Character, BattleTask

@pytest.fixture
def fighters():
    return (
        Character(id=uuid4(), name="Astra", class_name="mage", hp=100, attack=30, defense=12, speed=80),
        Character(id=uuid4(), name="Borin", class_name="warrior", hp=140, attack=25, defense=20, speed=30),
    )

@pytest.fixture
def task(fighters):
    return BattleTask(battle_id=uuid4(), participants=fighters, seed=42, request_id="test-request")
