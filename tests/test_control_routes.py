from uuid import uuid4
from fastapi.testclient import TestClient
from api.main import create_app
from test_api import create_pair


def test_trace_route_validates_and_paginates(tmp_path):
    with TestClient(create_app(tmp_path / 'api.db', broker_enabled=False)) as client:
        battle = client.post('/api/battles', json=create_pair(client), headers={'X-Request-ID':'trace-http'}).json()
        response = client.get('/api/battles/' + battle['id'] + '/trace?limit=1')
        assert response.status_code == 200
        trace = response.json()
        assert trace['request_id'] == 'trace-http'
        assert trace['items'][0]['event_type'] == 'accepted'
        assert trace['coverage'] == 'from_creation'
        assert client.get('/api/battles/' + battle['id'] + '/trace?offset=1').json()['items'] == []
        assert client.get('/api/battles/' + battle['id'] + '/trace?limit=201').status_code == 422
        assert client.get('/api/battles/' + battle['id'] + '/trace?offset=-1').status_code == 422
        assert client.get('/api/battles/' + str(uuid4()) + '/trace').status_code == 404
        assert client.get('/api/battles/invalid/trace').status_code == 422


def test_control_combines_fresh_application_stats_and_cached_observations(tmp_path):
    with TestClient(create_app(tmp_path / 'api.db', broker_enabled=False)) as client:
        class Observer:
            def snapshot(self):
                return {'broker': {'status':'unavailable', 'error_code':'timeout'},
                        'cluster': {'status':'not_configured'}}
        client.app.state.control_metrics = Observer()
        client.post('/api/battles', json=create_pair(client))
        response = client.get('/api/control')
        assert response.status_code == 200
        data = response.json()
        assert data['application']['pending'] == 1
        assert data['api']['database'] is True
        assert data['api']['broker_connected'] is False
        assert data['broker']['status'] == 'unavailable'
        assert data['cluster']['status'] == 'not_configured'
        assert data['refresh_after_seconds'] == 5
        assert data['observed_at']
