from worker.engine import simulate

def test_seeded_combat_is_reproducible_and_fastest_starts(task):
    result = simulate(task)
    assert result == simulate(task)
    assert result.attacks[0].attacker_id == task.participants[0].id

def test_winner_and_damage_are_consistent(task):
    result = simulate(task)
    assert result.outcome == "victory"
    assert result.winner_id in [x.id for x in task.participants]
    assert result.turns == len(result.attacks)
    assert all(x.damage >= 1 and x.defender_hp >= 0 for x in result.attacks)
    loser = next(x for x in task.participants if x.id != result.winner_id)
    assert result.final_hp[str(loser.id)] == 0
    assert sum(result.total_damage.values()) == sum(x.damage for x in result.attacks)

def test_turn_limit_is_a_draw_and_never_mutates_character(task):
    limited = task.model_copy(update={"max_actions": 1})
    result = simulate(limited)
    assert result.outcome == "draw" and result.winner_id is None
    assert result.turns == 1
    assert task.participants[0].hp == 100

def test_lethal_damage_is_clamped_to_remaining_hp(task):
    a,b = task.participants
    lethal = task.model_copy(update={"participants": (a.model_copy(update={"attack":200}),b.model_copy(update={"hp":1,"defense":0}))})
    result = simulate(lethal)
    assert result.turns == 1
    assert result.attacks[0].damage == 1
    assert result.winner_id == a.id
