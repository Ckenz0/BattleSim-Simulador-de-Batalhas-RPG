"""Pure deterministic combat. No broker, database or wall-clock dependency."""
import random
from battle_contracts.models import Attack, BattleTask, CombatResult

def simulate(task: BattleTask) -> CombatResult:
    rng = random.Random(task.seed)
    fighters = list(task.participants)
    if fighters[1].speed > fighters[0].speed:
        fighters.reverse()
    elif fighters[0].speed == fighters[1].speed and rng.randrange(2):
        fighters.reverse()
    hp = {str(x.id): x.hp for x in fighters}
    damage = {str(x.id): 0 for x in fighters}
    attacks = []
    winner = None
    for index in range(task.max_actions):
        attacker, defender = fighters[index % 2], fighters[(index + 1) % 2]
        amount = max(1, int(attacker.attack * rng.uniform(0.9, 1.1) - defender.defense * 0.5))
        amount = min(amount, hp[str(defender.id)])
        hp[str(defender.id)] -= amount
        damage[str(attacker.id)] += amount
        attacks.append(Attack(turn=index + 1, attacker_id=attacker.id, defender_id=defender.id,
                              damage=amount, defender_hp=hp[str(defender.id)]))
        if hp[str(defender.id)] == 0:
            winner = attacker.id
            break
    return CombatResult(outcome="victory" if winner else "draw", winner_id=winner,
                        turns=len(attacks), attacks=attacks, total_damage=damage, final_hp=hp)
