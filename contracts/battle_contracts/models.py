"""Versioned data exchanged through RabbitMQ; no dependency on either service."""
from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

def utcnow() -> datetime:
    return datetime.now(timezone.utc)

class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

class CharacterClass(str, Enum):
    warrior = "warrior"
    mage = "mage"
    archer = "archer"

class CharacterCreate(Contract):
    name: str = Field(min_length=1, max_length=60)
    class_name: CharacterClass
    hp: Annotated[StrictInt, Field(ge=1, le=1000)]
    attack: Annotated[StrictInt, Field(ge=1, le=200)]
    defense: Annotated[StrictInt, Field(ge=0, le=150)]
    speed: Annotated[StrictInt, Field(ge=1, le=100)]

class Character(CharacterCreate):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, frozen=True)
    id: UUID

class BattleTask(Contract):
    schema_version: Literal[1] = 1
    message_type: Literal["battle.requested"] = "battle.requested"
    battle_id: UUID
    participants: tuple[Character, Character]
    seed: Annotated[StrictInt, Field(ge=0, le=9223372036854775807)]
    request_id: str = Field(min_length=1, max_length=128)
    max_actions: Annotated[StrictInt, Field(ge=1, le=1000)] = 200
    created_at: datetime = Field(default_factory=utcnow)

    @model_validator(mode="after")
    def distinct_participants(self):
        if self.participants[0].id == self.participants[1].id:
            raise ValueError("Combatants must be different characters")
        return self

class Attack(Contract):
    turn: int = Field(ge=1)
    attacker_id: UUID
    defender_id: UUID
    damage: int = Field(ge=1)
    defender_hp: int = Field(ge=0)

class CombatResult(Contract):
    outcome: Literal["victory", "draw"]
    winner_id: UUID | None
    turns: int = Field(ge=1, le=1000)
    attacks: list[Attack] = Field(min_length=1, max_length=1000)
    total_damage: dict[str, int]
    final_hp: dict[str, int]

    @model_validator(mode="after")
    def consistent_outcome(self):
        if (self.outcome == "victory") != (self.winner_id is not None):
            raise ValueError("Victory must have a winner; draw must not")
        if self.turns != len(self.attacks):
            raise ValueError("Turns must match the attack history")
        if any(x < 0 for x in [*self.total_damage.values(), *self.final_hp.values()]):
            raise ValueError("Damage and health cannot be negative")
        return self

class BattleEvent(Contract):
    schema_version: Literal[1] = 1
    event_id: UUID = Field(default_factory=uuid4)
    battle_id: UUID
    worker_id: str = Field(min_length=1, max_length=128)
    attempt_id: str = Field(min_length=1, max_length=128)
    status: Literal["processing", "completed", "failed"]
    occurred_at: datetime = Field(default_factory=utcnow)
    result: CombatResult | None = None
    error: str | None = Field(default=None, max_length=500)
    processing_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def payload_for_status(self):
        if self.status == "completed" and (self.result is None or self.processing_ms is None):
            raise ValueError("Completed event requires result and processing_ms")
        if self.status == "failed" and not self.error:
            raise ValueError("Failed event requires an error code")
        if self.status != "completed" and self.result is not None:
            raise ValueError("Only completed events can carry a result")
        return self
