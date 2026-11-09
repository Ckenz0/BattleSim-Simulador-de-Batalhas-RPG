import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from worker.main import Worker
import worker.main as worker_module
import worker.runtime as runtime


class Message:
    def __init__(self, task):
        self.body = task.model_dump_json().encode()
        self.message_id = str(task.battle_id)
        self.channel = SimpleNamespace(is_closed=False)
        self.ack = AsyncMock()
        self.nack = AsyncMock()
        self.reject = AsyncMock()


@pytest.mark.parametrize('value', ['0', '21', '-1', '1.5', 'invalid', 'true'])
def test_concurrency_configuration_is_bounded(value):
    with pytest.raises(ValueError):
        runtime.read_concurrency(value)


def test_concurrency_configuration_accepts_one_and_twenty():
    assert runtime.read_concurrency('1') == 1
    assert runtime.read_concurrency('20') == 20


@pytest.mark.parametrize('value', [0, 21, True, 1.5])
def test_constructor_rejects_invalid_concurrency(value):
    with pytest.raises(ValueError):
        Worker('amqp://unused', 0, concurrency=value)


@pytest.mark.parametrize('configured_capacity', [None, 2, 20])
async def test_compute_jobs_fill_capacity_but_extra_job_waits(monkeypatch, task, configured_capacity):
    capacity = configured_capacity or 1
    worker = Worker('amqp://unused', 0, **({'concurrency': capacity} if configured_capacity else {}))
    release = threading.Event()
    lock = threading.Lock()
    started, peak, active = 0, 0, 0

    def compute(task, cpu):
        nonlocal started, peak, active
        with lock:
            started += 1
            active += 1
            peak = max(peak, active)
        assert release.wait(5), 'Test did not release blocked computation'
        with lock:
            active -= 1
        return runtime.execute(task, 0)

    monkeypatch.setattr(worker_module, 'execute', compute)
    published = []
    async def publish(channel, event, queue):
        published.append((str(event.battle_id), event.status))
    monkeypatch.setattr(worker_module, 'publish', publish)
    messages = [Message(task.model_copy(update={'battle_id': uuid4()})) for _ in range(capacity + 1)]
    jobs = [asyncio.create_task(worker.consume(message)) for message in messages]
    try:
        async with asyncio.timeout(3):
            while started < capacity:
                await asyncio.sleep(.005)
        assert started == peak == active == capacity
        assert sum(status == 'processing' for _, status in published) == capacity
        assert all(not message.ack.called for message in messages)
        release.set()
        await asyncio.gather(*jobs)
        assert started == capacity + 1 and peak == capacity
        for message in messages:
            message.ack.assert_awaited_once()
            message.nack.assert_not_called()
            assert [status for bid, status in published if bid == message.message_id] == ['processing', 'completed']
    finally:
        release.set()
        await asyncio.gather(*jobs, return_exceptions=True)
        worker.executor.shutdown(wait=True, cancel_futures=True)


async def test_failed_terminal_confirmation_requeues_without_ack(monkeypatch, task):
    worker = Worker('amqp://unused', 0, concurrency=2)
    message = Message(task)
    async def publish(channel, event, queue):
        if event.status == 'completed':
            raise ConnectionError('Broker confirmation lost')
    monkeypatch.setattr(worker_module, 'publish', publish)
    try:
        await worker.consume(message)
        message.ack.assert_not_called()
        message.nack.assert_awaited_once_with(requeue=True)
    finally:
        worker.executor.shutdown(wait=True, cancel_futures=True)


async def test_invalid_task_does_not_start_computation(monkeypatch, task):
    worker = Worker('amqp://unused', 0, concurrency=20)
    message = Message(task)
    message.body = b'not a battle contract'
    compute = AsyncMock(side_effect=AssertionError('Should not execute invalid input'))
    monkeypatch.setattr(worker_module, 'execute', compute)
    try:
        await worker.consume(message)
        message.reject.assert_awaited_once_with(requeue=False)
        message.ack.assert_not_called()
        compute.assert_not_called()
    finally:
        worker.executor.shutdown(wait=True, cancel_futures=True)


async def test_worker_qos_matches_execution_capacity_and_pool_is_closed(monkeypatch):
    worker = Worker('amqp://unused', 0, concurrency=20)
    channel = SimpleNamespace(set_qos=AsyncMock())
    connection = SimpleNamespace(channel=AsyncMock(return_value=channel), close=AsyncMock())
    async def consume(callback):
        worker.stopping.set()
        return 'consumer-tag'
    requests = SimpleNamespace(consume=consume, cancel=AsyncMock())
    monkeypatch.setattr(worker_module.aio_pika, 'connect_robust', AsyncMock(return_value=connection))
    monkeypatch.setattr(worker_module, 'topology', AsyncMock(return_value=(requests, None)))
    await worker.run()
    channel.set_qos.assert_awaited_once_with(prefetch_count=20)
    requests.cancel.assert_awaited_once_with('consumer-tag')
    connection.close.assert_awaited_once()
    with pytest.raises(RuntimeError):
        worker.executor.submit(lambda: None)


async def test_terminal_publication_must_be_confirmed_before_ack(monkeypatch, task):
    worker = Worker('amqp://unused', 0, concurrency=2)
    message = Message(task)
    terminal_attempted = asyncio.Event()
    allow_confirmation = asyncio.Event()
    async def publish(channel, event, queue):
        if event.status == 'completed':
            terminal_attempted.set()
            await allow_confirmation.wait()
    monkeypatch.setattr(worker_module, 'publish', publish)
    job = asyncio.create_task(worker.consume(message))
    try:
        await asyncio.wait_for(terminal_attempted.wait(), 3)
        message.ack.assert_not_called()
        allow_confirmation.set()
        await job
        message.ack.assert_awaited_once()
    finally:
        allow_confirmation.set()
        await asyncio.gather(job, return_exceptions=True)
        worker.executor.shutdown(wait=True, cancel_futures=True)
