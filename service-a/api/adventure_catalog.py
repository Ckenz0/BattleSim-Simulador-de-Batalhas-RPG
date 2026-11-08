"""Small, server-authoritative campaign using the existing combat contract."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StrictInt, model_validator
from battle_contracts.models import CharacterClass, Contract

ATTRIBUTES = ('hp', 'attack', 'defense', 'speed')
BASES = dict(warrior=dict(zip(ATTRIBUTES, (145, 34, 22, 35))),
             mage=dict(zip(ATTRIBUTES, (105, 46, 10, 50))),
             archer=dict(zip(ATTRIBUTES, (120, 38, 14, 75))))
INITIAL_GAINS = dict(zip(ATTRIBUTES, (12, 3, 2, 2)))
UPGRADES = dict(zip(ATTRIBUTES, (20, 4, 3, 3)))
CAPS = dict(zip(ATTRIBUTES, (1000, 200, 150, 100)))
STAGES = [dict(number=i, name=name, class_name=kind, **dict(zip(ATTRIBUTES, stats)))
          for i, (name, kind, stats) in enumerate([
              ('Recruta', 'warrior', (55, 18, 5, 20)),
              ('Patrulheiro', 'archer', (75, 22, 8, 40)),
              ('Aprendiz Arcano', 'mage', (95, 25, 10, 45)),
              ('Sentinela', 'warrior', (120, 28, 14, 35)),
              ('Guardião da Arena', 'warrior', (145, 30, 18, 45)),
          ], 1)]

Point = Annotated[StrictInt, Field(ge=0, le=5)]

class Allocation(Contract):
    hp: Point
    attack: Point
    defense: Point
    speed: Point

    @model_validator(mode='after')
    def budget(self):
        if sum(self.model_dump().values()) != 5:
            raise ValueError('Distribua exatamente cinco pontos de atributos')
        return self

class AdventureCreate(Contract):
    name: str = Field(min_length=1, max_length=60)
    class_name: CharacterClass
    allocation: Allocation

class Upgrade(Contract):
    battle_id: UUID
    attribute: Literal['hp', 'attack', 'defense', 'speed']

def catalog():
    return dict(classes=BASES, initial_points=5, initial_gains=INITIAL_GAINS,
                upgrades=UPGRADES, caps=CAPS, stages=STAGES)
