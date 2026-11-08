from fastapi.testclient import TestClient
import pytest
from api.main import create_app

@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(db_path=tmp_path / "api.db", broker_enabled=False)) as client:
        yield client

def create_pair(client):
    ids = []
    for name in ["Astra","Borin"]:
        r=client.post("/api/characters",json=dict(name=name,class_name="mage",hp=100,attack=30,defense=10,speed=50))
        assert r.status_code == 201
        ids.append(r.json()["id"])
    return dict(character_a_id=ids[0], character_b_id=ids[1])

def test_accepted_battle_is_queryable_without_broker(client):
    pair = create_pair(client)
    r=client.post("/api/battles",json=pair,headers={"X-Request-ID":"correlation-test"})
    assert r.status_code == 202
    battle=r.json()
    assert battle["status"] == "pending"
    assert battle["request_id"] == "correlation-test"
    assert r.headers["x-request-id"] == "correlation-test"
    assert client.get("/api/battles/"+battle["id"]).json()["id"] == battle["id"]
    assert client.get("/api/stats").json()["unpublished"] == 1

@pytest.mark.parametrize("count", [0,1001,True,1.5])
def test_batch_limits_are_checked_before_creation(client,count):
    r=client.post("/api/battles/batch",json=create_pair(client)|{"count":count})
    assert r.status_code == 422
    assert client.get("/api/stats").json()["total"] == 0

def test_batch_endpoint_is_not_shadowed_and_lists_are_paginated(client):
    r=client.post("/api/battles/batch",json=create_pair(client)|{"count":10})
    assert r.status_code == 202 and r.json()["count"] == 10
    page=client.get("/api/battles",params={"batch_id":r.json()["batch_id"],"limit":3})
    assert len(page.json()["items"]) == 3
    assert page.json()["total"] == 10

def test_unknown_or_duplicate_combatant_is_rejected(client):
    pair=create_pair(client)
    assert client.post("/api/battles",json=pair|{"character_b_id":pair["character_a_id"]}).status_code == 422
    pair["character_a_id"]="00000000-0000-0000-0000-000000000001"
    assert client.post("/api/battles",json=pair).status_code == 404

def test_health_separates_liveness_from_broker_readiness(client):
    assert client.get("/api/health/live").status_code == 200
    assert client.get("/api/health/ready").status_code == 503
    assert client.get("/api/health").json()["broker_connected"] is False

def test_untrusted_names_are_returned_as_data_and_invalid_names_rejected(client):
    payload=dict(name="<script>alert(1)</script>",class_name="archer",hp=80,attack=30,defense=10,speed=90)
    assert client.post("/api/characters",json=payload).json()["name"] == payload["name"]
    assert client.post("/api/characters",json=payload|{"name":"  "}).status_code == 422
