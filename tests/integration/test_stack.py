"""Real stack checks. Run explicitly with: uv run pytest -m integration -v.

These checks stop/restart this Compose project's worker/broker and add test records.
Run against a disposable demonstration environment, never a shared deployment.
"""
import json
import os
from pathlib import Path
import subprocess
import time
from uuid import uuid4

import httpx
import pytest

pytestmark = pytest.mark.integration
ROOT=Path(__file__).resolve().parents[2]

def compose(*args):
    result=subprocess.run(["docker","compose",*args],cwd=ROOT,capture_output=True,text=True,timeout=150)
    assert result.returncode==0, result.stderr[-3000:]
    return result.stdout

def eventually(check,timeout=120):
    deadline=time.monotonic()+timeout
    last=None
    while time.monotonic()<deadline:
        try:
            last=check()
            if last:
                return last
        except (httpx.HTTPError,ConnectionError):
            pass
        time.sleep(.3)
    raise AssertionError(f"Condition did not become true within {timeout}s; last result={last!r}")

@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=os.getenv("BATTLESIM_URL","http://127.0.0.1:8080"),timeout=15) as client:
        eventually(lambda:client.get("/api/health/ready").status_code==200)
        yield client

@pytest.fixture
def pair(client):
    ids=[]
    for name,cls in [("Astra","mage"),("Borin","warrior")]:
        response=client.post("/api/characters",json={
            "name":name+" "+str(uuid4())[:6],"class_name":cls,"hp":120,"attack":50,"defense":25,"speed":50})
        assert response.status_code==201
        ids.append(response.json()["id"])
    return {"character_a_id":ids[0],"character_b_id":ids[1]}

def batch(client,pair,count):
    response=client.post("/api/battles/batch",json=pair|{"count":count})
    assert response.status_code==202
    return response.json()

def records(client,batch_id):
    return client.get("/api/battles",params={"batch_id":batch_id,"limit":100}).json()["items"]

def completed(client,batch_id,count):
    rows=records(client,batch_id)
    return rows if len(rows)==count and all(x["status"]=="completed" for x in rows) else False

def test_nginx_is_the_only_exposed_component_and_battle_finishes(client,pair):
    config=json.loads(compose("config","--format","json"))
    assert set(config["services"])=={"nginx","service-a","service-b","rabbitmq"}
    assert config["services"]["nginx"]["ports"]
    assert all(not config["services"][name].get("ports") for name in ("service-a","service-b","rabbitmq"))
    assert client.get("/").status_code==200
    assert client.get("/api/openapi.json").status_code==200
    response=client.post("/api/battles",json=pair,headers={"X-Request-ID":"integration-trace"})
    assert response.status_code==202
    bid=response.json()["id"]
    result=eventually(lambda:(r if (r:=client.get("/api/battles/"+bid).json())["status"]=="completed" else False))
    assert result["request_id"]=="integration-trace"
    assert result["result"]["turns"]==len(result["result"]["attacks"])
    assert result["worker_id"] and result["published"]

def test_stopped_worker_and_restarted_broker_preserve_pending_work(client,pair):
    compose("stop","service-b")
    try:
        pending=batch(client,pair,10)
        eventually(lambda:all(row["published"] for row in records(client,pending["batch_id"])))
        assert all(x["status"]=="pending" for x in records(client,pending["batch_id"]))
        compose("restart","rabbitmq")
        eventually(lambda:client.get("/api/health/ready").status_code==200)
        compose("up","-d","service-b")
        rows=eventually(lambda:completed(client,pending["batch_id"],10))
        assert len({r["id"] for r in rows})==10
    finally:
        compose("up","-d","service-b")

def test_broker_outage_accepts_and_recovers_outbox_tasks(client,pair):
    compose("stop","rabbitmq")
    try:
        pending=batch(client,pair,4)
        rows=records(client,pending["batch_id"])
        assert len(rows)==4 and all(x["status"]=="pending" and not x["published"] for x in rows)
        assert client.get("/api/health/live").status_code==200
        compose("start","rabbitmq")
        eventually(lambda:client.get("/api/health/ready").status_code==200)
        eventually(lambda:completed(client,pending["batch_id"],4))
    finally:
        compose("start","rabbitmq")

def test_three_workers_share_a_batch_without_duplicate_results(client,pair):
    compose("up","-d","--scale","service-b=3","service-b")
    try:
        def consumers_ready():
            output=compose("exec","-T","rabbitmq","rabbitmqctl","list_queues","name","consumers","--no-table-headers")
            return any(line.split()==["battles.requests.v1","3"] for line in output.splitlines())
        eventually(consumers_ready,timeout=45)
        pending=batch(client,pair,36)
        rows=eventually(lambda:completed(client,pending["batch_id"],36))
        assert len({x["id"] for x in rows})==36
        assert len({x["worker_id"] for x in rows})>=2
        assert all(row["result"]["turns"]>0 for row in rows)
    finally:
        compose("up","-d","--scale","service-b=1","service-b")

def test_invalid_messages_go_to_dead_letter_queue(client):
    script="""
import asyncio,os,aio_pika
from battle_contracts.broker import topology,REQUESTS,DEAD
async def main():
    async with await aio_pika.connect_robust(os.environ['RABBITMQ_URL']) as conn:
        channel=await conn.channel(publisher_confirms=True)
        await topology(channel)
        queue=await channel.declare_queue(DEAD,passive=True)
        initial=queue.declaration_result.message_count
        await channel.default_exchange.publish(aio_pika.Message(b'{"schema_version":999}',delivery_mode=2),routing_key=REQUESTS)
        for _ in range(100):
            # RobustChannel caches passive declarations; explicitly refresh the server count.
            await queue.declare()
            if queue.declaration_result.message_count>initial:
                print('dead-lettered')
                return
            await asyncio.sleep(.1)
        raise RuntimeError('Invalid task was not dead-lettered')
asyncio.run(main())
"""
    assert "dead-lettered" in compose("exec","-T","service-b","python","-c",script)
    assert client.get("/api/health/ready").status_code==200

def test_api_recreation_keeps_sqlite_data_and_nginx_route(client,pair):
    response=client.post('/api/battles',json=pair)
    assert response.status_code==202
    bid=response.json()['id']
    eventually(lambda:client.get('/api/battles/'+bid).json()['status']=='completed')
    compose('up','-d','--force-recreate','service-a')
    eventually(lambda:client.get('/api/health/ready').status_code==200)
    assert client.get('/api/battles/'+bid).json()['status']=='completed'
