"""Opt-in control-room evidence against the existing local Compose demo."""
import pytest
from test_stack import client, pair, compose, eventually, batch, records, completed

pytestmark = pytest.mark.integration


def test_live_trace_and_existing_history_remain_honest(client, pair):
    old = client.get('/api/battles?limit=100').json()['items']
    legacy = next((b for b in old if client.get('/api/battles/'+b['id']+'/trace').json()['coverage']=='legacy_partial'), None)
    if legacy:
        trace = client.get('/api/battles/'+legacy['id']+'/trace').json()
        assert trace['coverage'] == 'legacy_partial' and trace['items'] == []
    response = client.post('/api/battles',json=pair,headers={'X-Request-ID':'control-live-trace'})
    assert response.status_code == 202
    bid = response.json()['id']
    eventually(lambda:client.get('/api/battles/'+bid).json()['status']=='completed')
    trace = client.get('/api/battles/'+bid+'/trace').json()
    assert trace['coverage'] == 'from_creation'
    assert trace['request_id'] == 'control-live-trace'
    assert {x['event_type'] for x in trace['items']} == {'accepted','published','processing','completed'}
    attempts = {x['attempt_id'] for x in trace['items'] if x['attempt_id']}
    assert len(attempts) == 1
    assert all(x['applied'] for x in trace['items'])
    page = client.get('/api/battles/'+bid+'/trace?limit=2&offset=2').json()
    assert page['items'] == trace['items'][2:4] and page['total'] == 4


def test_real_queue_is_visible_while_consumer_is_stopped(client, pair):
    compose('stop','service-b')
    try:
        pending = batch(client,pair,10)
        eventually(lambda:all(x['published'] for x in records(client,pending['batch_id'])))
        def observed_queue():
            data = client.get('/api/control').json()
            assert data['broker']['status'] == 'ok'
            assert data['cluster']['status'] == 'not_configured'
            queue = next(q for q in data['broker']['queues'] if q['name']=='battles.requests.v1')
            return queue if queue['ready']==10 and queue['consumers']==0 else False
        queue = eventually(observed_queue,timeout=30)
        assert queue['unacknowledged'] == 0
        for battle in records(client,pending['batch_id']):
            trace = client.get('/api/battles/'+battle['id']+'/trace').json()
            assert {x['event_type'] for x in trace['items']} == {'accepted','published'}
    finally:
        compose('start','service-b')
    eventually(lambda:completed(client,pending['batch_id'],10))
