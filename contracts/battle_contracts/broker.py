"""RabbitMQ topology and confirmed, persistent publication shared by both services."""
import asyncio
import aio_pika
from .models import Contract

REQUESTS = "battles.requests.v1"
EVENTS = "battles.events.v1"
DEAD = "battles.dead.v1"

async def topology(channel):
    await channel.declare_queue(DEAD, durable=True)
    arguments = {"x-dead-letter-exchange":"", "x-dead-letter-routing-key":DEAD}
    requests = await channel.declare_queue(REQUESTS, durable=True, arguments=arguments)
    events = await channel.declare_queue(EVENTS, durable=True, arguments=arguments)
    return requests, events

async def publish(channel, payload: Contract, routing_key: str):
    bid = str(payload.battle_id)
    message = aio_pika.Message(
        body=payload.model_dump_json().encode("utf-8"), content_type="application/json",
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        message_id=str(getattr(payload, "event_id", payload.battle_id)),
        correlation_id=bid, headers={"schema_version":1},
    )
    # wait_for also bounds waiting for a reconnect, before publish gets its channel.
    await asyncio.wait_for(channel.default_exchange.publish(
        message, routing_key=routing_key, mandatory=True, timeout=8), timeout=10)
