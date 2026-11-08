"""Outbox delivery and idempotent result ingestion run independently of HTTP requests."""
import asyncio
from contextlib import suppress
import aio_pika
from pydantic import ValidationError

from battle_contracts.broker import REQUESTS, publish, topology
from battle_contracts.logging import log
from battle_contracts.models import BattleEvent, BattleTask

class MessageBus:
    def __init__(self, database, url):
        self.db, self.url = database, url
        self.connection = None
        self.channel = None
        self.stopping = asyncio.Event()
        self.runner = None

    @property
    def connected(self):
        return bool(self.connection and self.connection.connected.is_set() and self.channel
                    and not self.channel.is_closed)

    async def start(self):
        self.runner = asyncio.create_task(self.run(), name="api-rabbitmq")

    async def pause(self, seconds):
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.stopping.wait(),seconds)

    async def run(self):
        backoff = 1
        while not self.stopping.is_set():
            try:
                self.connection = await aio_pika.connect_robust(
                    self.url, timeout=5, reconnect_interval=2,
                    client_properties={"connection_name":"battlesim-api"})
                self.channel = await self.connection.channel(publisher_confirms=True,on_return_raises=True)
                await self.channel.set_qos(prefetch_count=50)
                _, events = await topology(self.channel)
                await events.consume(self.consume_event)
                backoff = 1
                log("broker_connected",service="service-a")
                while not self.stopping.is_set():
                    rows = await asyncio.to_thread(self.db.pending_outbox,50)
                    for row in rows:
                        if self.stopping.is_set():
                            break
                        task = BattleTask.model_validate_json(row["payload"])
                        await publish(self.channel,task,REQUESTS)
                        await asyncio.to_thread(self.db.mark_published,row["battle_id"])
                        log("battle_published",battle_id=row["battle_id"],request_id=task.request_id)
                    await self.pause(0.25 if not rows else 0.01)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log("broker_retry",service="service-a",error_type=type(exc).__name__,retry_seconds=backoff)
            finally:
                if self.connection:
                    with suppress(Exception):
                        await self.connection.close()
                self.channel = None
                self.connection = None
            await self.pause(backoff)
            backoff = min(backoff * 2,15)

    async def consume_event(self, message):
        try:
            event = BattleEvent.model_validate_json(message.body)
        except (ValidationError, ValueError):
            log("invalid_event",message_id=message.message_id)
            await message.reject(requeue=False)
            return
        try:
            changed = await asyncio.to_thread(self.db.apply_event,event)
            await message.ack()
            log("battle_event_applied" if changed else "battle_event_ignored",battle_id=event.battle_id,
                event_id=event.event_id,worker_id=event.worker_id,status=event.status)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log("event_retry",battle_id=event.battle_id,error_type=type(exc).__name__)
            await asyncio.sleep(1)
            if not message.channel.is_closed:
                await message.nack(requeue=True)

    async def stop(self):
        self.stopping.set()
        if self.runner:
            self.runner.cancel()
            with suppress(asyncio.CancelledError):
                await self.runner
