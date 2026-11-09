"""Independent RabbitMQ consumer. No API address or database is known here."""
import asyncio
import os
import signal
import socket
from contextlib import suppress
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import aio_pika
from pydantic import ValidationError
from battle_contracts.broker import EVENTS, publish, topology
from battle_contracts.logging import log
from battle_contracts.models import BattleTask, BattleEvent
from .runtime import execute, read_cpu_iterations, read_concurrency

class Worker:
    def __init__(self, url: str, cpu_iterations: int, concurrency: int = 1):
        if type(concurrency) is not int or not 1 <= concurrency <= 20:
            raise ValueError("WORKER_CONCURRENCY must be an integer between 1 and 20")
        self.url, self.cpu_iterations = url, cpu_iterations
        self.concurrency = concurrency
        self.slots = asyncio.Semaphore(concurrency)
        self.executor = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="battle")
        self.worker_id = socket.gethostname()
        self.stopping = asyncio.Event()
        self.active = set()
        self.channel = None

    async def consume(self, message):
        current = asyncio.current_task()
        self.active.add(current)
        try:
            async with self.slots:
                await self._consume(message)
        finally:
            self.active.discard(current)

    async def _consume(self, message):
        try:
            try:
                task = BattleTask.model_validate_json(message.body)
            except (ValidationError, ValueError):
                log("invalid_task",worker_id=self.worker_id,message_id=message.message_id)
                await message.reject(requeue=False)
                return
            attempt_id = str(uuid4())
            base = dict(battle_id=task.battle_id,worker_id=self.worker_id,attempt_id=attempt_id)
            await publish(self.channel,BattleEvent(**base,status="processing"),EVENTS)
            log("battle_processing",**base,request_id=task.request_id)
            try:
                result, duration = await asyncio.get_running_loop().run_in_executor(
                    self.executor, execute, task, self.cpu_iterations)
                terminal = BattleEvent(**base,status="completed",result=result,processing_ms=duration)
            except Exception as exc:
                log("simulation_failed",**base,error_type=type(exc).__name__)
                terminal = BattleEvent(**base,status="failed",error="simulation_error")
            await publish(self.channel,terminal,EVENTS)
            await message.ack()
            log("battle_finished",**base,status=terminal.status,processing_ms=terminal.processing_ms)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log("task_retry",worker_id=self.worker_id,error_type=type(exc).__name__)
            await asyncio.sleep(1)
            with suppress(Exception):
                if not message.channel.is_closed:
                    await message.nack(requeue=True)

    async def run(self):
        try:
            await self._run()
        finally:
            # In-flight CPU threads cannot be forcibly stopped. Closing a connection
            # requeues unacknowledged messages; queued executor work is cancelled.
            self.executor.shutdown(wait=False, cancel_futures=True)

    async def _run(self):
        backoff = 1
        while not self.stopping.is_set():
            connection = None
            try:
                connection = await aio_pika.connect_robust(self.url,timeout=5,reconnect_interval=2,
                    client_properties={"connection_name":"battlesim-worker-"+self.worker_id})
                self.channel = await connection.channel(publisher_confirms=True,on_return_raises=True)
                await self.channel.set_qos(prefetch_count=self.concurrency)
                requests, _ = await topology(self.channel)
                tag = await requests.consume(self.consume)
                log("worker_ready",worker_id=self.worker_id,cpu_iterations=self.cpu_iterations,
                    concurrency=self.concurrency)
                backoff = 1
                await self.stopping.wait()
                await requests.cancel(tag)
                if self.active:
                    try:
                        await asyncio.wait_for(asyncio.gather(*self.active,return_exceptions=True),timeout=25)
                    except asyncio.TimeoutError:
                        log("shutdown_timeout",worker_id=self.worker_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log("worker_retry",worker_id=self.worker_id,error_type=type(exc).__name__,retry_seconds=backoff)
            finally:
                if connection:
                    with suppress(Exception):
                        await connection.close()
            if not self.stopping.is_set():
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.stopping.wait(),backoff)
                backoff = min(backoff*2,15)
        log("worker_stopped",worker_id=self.worker_id)

async def main():
    worker = Worker(os.environ["RABBITMQ_URL"],read_cpu_iterations(os.getenv("WORKER_CPU_ITERATIONS","0")),
                    read_concurrency(os.getenv("WORKER_CONCURRENCY","1")))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT,signal.SIGTERM):
        try:
            loop.add_signal_handler(sig,worker.stopping.set)
        except NotImplementedError:
            signal.signal(sig,lambda *_: loop.call_soon_threadsafe(worker.stopping.set))
    await worker.run()

if __name__ == "__main__":
    asyncio.run(main())
