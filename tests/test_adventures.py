from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from battle_contracts.models import BattleEvent, BattleTask
from worker.engine import simulate


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'adventure.db', broker_enabled=False)) as client:
        yield client


def create(client, **changes):
    return client.post('/api/adventures', json=dict(name='Astra', class_name='mage',
        allocation=dict(hp=2, attack=2, defense=1, speed=0)) | changes)


def queue(client, run):
    response = client.post(f'/api/adventures/{run["id"]}/battles')
    assert response.status_code == 202
    return response.json()


def finish(client, battle, *, winner=True, failed=False):
    db = client.app.state.db
    with db.connection() as connection:
        payload = connection.execute('SELECT payload FROM outbox WHERE battle_id=?', (battle['id'],)).fetchone()[0]
    task = BattleTask.model_validate_json(payload)
    result = simulate(task)
    result = result.model_copy(update={'outcome': 'victory', 'winner_id': task.participants[0 if winner else 1].id})
    event = BattleEvent(battle_id=task.battle_id, worker_id='test', attempt_id='attempt',
        status='failed' if failed else 'completed', result=None if failed else result,
        error='test_failure' if failed else None, processing_ms=None if failed else 1)
    assert db.apply_event(event)
    return event


@pytest.mark.parametrize('allocation', [dict(hp=5, attack=1, defense=0, speed=0),
    dict(hp=True, attack=4, defense=0, speed=0), dict(hp=1.5, attack=3.5, defense=0, speed=0),
    dict(hp=-1, attack=6, defense=0, speed=0)])
def test_allocation_is_strict_and_creation_atomic(client, allocation):
    assert create(client, allocation=allocation).status_code == 422
    assert client.get('/api/characters').json()['total'] == 0


def test_catalog_creation_snapshots_and_recovery(client):
    assert len(client.get('/api/adventures/catalog').json()['stages']) == 5
    response = create(client)
    assert response.status_code == 201
    run = response.json()
    assert (run['hero']['hp'], run['hero']['attack'], run['level'], run['stage']) == (129, 52, 1, 1)
    battle = queue(client, run)
    assert battle['adventure']['id'] == run['id']
    assert client.get('/api/stats').json()['unpublished'] == 1
    assert client.get('/api/characters').json()['total'] == 1  # rival is only a snapshot
    from api.database import Database
    from api.adventures import AdventureStore
    assert AdventureStore(Database(client.app.state.db.path)).get(run['id'])['status'] == 'pending'


def test_concurrent_start_returns_one_attempt(client):
    run = create(client).json()
    store = client.app.state.adventures
    with ThreadPoolExecutor(max_workers=4) as pool:
        battles = list(pool.map(lambda _: store.start(run['id'], 'request'), range(4)))
    assert len({b['id'] for b in battles}) == 1
    assert client.get('/api/stats').json()['total'] == 1


def test_reward_is_once_per_battle_even_after_next_victory(client):
    run = create(client).json()
    battle = queue(client, run)
    event = finish(client, battle)
    db = client.app.state.db
    assert not db.apply_event(event.model_copy(update={'event_id': uuid4()}))
    path = f'/api/adventures/{run["id"]}'
    assert client.get(path).json()['level'] == 2
    assert client.post(path + '/battles').status_code == 409
    claim = dict(battle_id=battle['id'], attribute='attack')
    upgraded = client.post(path + '/upgrades', json=claim).json()
    assert upgraded['hero']['attack'] == 56 and upgraded['stage'] == 2
    assert client.post(path + '/upgrades', json=claim).json()['hero']['attack'] == 56
    assert client.post(path + '/upgrades', json=claim | {'attribute': 'hp'}).status_code == 409
    next_battle = queue(client, run)
    assert next_battle['participants'][0]['attack'] == 56
    assert battle['participants'][0]['attack'] == 52
    finish(client, next_battle)
    retried = client.post(path + '/upgrades', json=claim).json()
    assert retried['status'] == 'reward' and retried['stage'] == 2


@pytest.mark.parametrize('failed', [False, True])
def test_loss_and_infrastructure_failure_do_not_advance(client, failed):
    run = create(client).json()
    battle = queue(client, run)
    finish(client, battle, winner=False, failed=failed)
    current = client.get(f'/api/adventures/{run["id"]}').json()
    assert (current['status'], current['level'], current['stage']) == ('ready', 1, 1)
    assert queue(client, run)['id'] != battle['id']


def test_five_rewards_complete_adventure_and_cannot_queue_more(client):
    run = create(client).json()
    path = f'/api/adventures/{run["id"]}'
    for stage in range(1, 6):
        battle = queue(client, run)
        finish(client, battle)
        response = client.post(path + '/upgrades', json=dict(battle_id=battle['id'], attribute='hp'))
        assert response.status_code == 200
        assert response.json()['level'] == stage + 1
    assert response.json()['status'] == 'completed'
    assert client.post(path + '/battles').status_code == 409


def test_progress_failure_rolls_back_terminal_event_and_result(client):
    import sqlite3
    run = create(client).json()
    battle = queue(client, run)
    db = client.app.state.db
    with db.connection() as connection:
        connection.execute("""CREATE TRIGGER reject_progress BEFORE UPDATE ON adventures
            BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        finish(client, battle)
    assert db.get_battle(battle['id'])['status'] == 'pending'
    with db.connection() as connection:
        assert connection.execute('SELECT COUNT(*) FROM battle_events').fetchone()[0] == 0
        connection.execute('DROP TRIGGER reject_progress')
    finish(client, battle)
    assert client.get(f'/api/adventures/{run["id"]}').json()['status'] == 'reward'


def test_draw_and_unrelated_reward_cannot_advance(client):
    run = create(client).json()
    battle = queue(client, run)
    db = client.app.state.db
    task = BattleTask.model_validate_json(db.pending_outbox()[0]['payload'])
    result = simulate(task).model_copy(update={'outcome': 'draw', 'winner_id': None})
    db.apply_event(BattleEvent(battle_id=battle['id'], worker_id='test', attempt_id='draw',
                              status='completed', result=result, processing_ms=1))
    path = f'/api/adventures/{run["id"]}'
    current = client.get(path).json()
    assert (current['status'], current['last_outcome'], current['level']) == ('ready', 'draw', 1)
    assert client.post(path + '/upgrades', json=dict(battle_id=battle['id'], attribute='attack')).status_code == 409


def test_reward_cannot_be_claimed_by_another_adventure(client):
    first, second = create(client).json(), create(client, name='Outro').json()
    battle = queue(client, first)
    finish(client, battle)
    claim = dict(battle_id=battle['id'], attribute='attack')
    assert client.post(f'/api/adventures/{second["id"]}/upgrades', json=claim).status_code == 409
    assert client.post(f'/api/adventures/{first["id"]}/upgrades', json=claim).status_code == 200
    assert client.post(f'/api/adventures/{second["id"]}/upgrades', json=claim).status_code == 409
