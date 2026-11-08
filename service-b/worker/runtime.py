"""Bounded CPU load is separate from deterministic combat rules."""
import hashlib
from time import perf_counter
from .engine import simulate

def read_cpu_iterations(value: str) -> int:
    iterations = int(value)
    if not 0 <= iterations <= 20_000_000:
        raise ValueError("WORKER_CPU_ITERATIONS must be between 0 and 20000000")
    return iterations

def execute(task, cpu_iterations: int):
    started = perf_counter()
    result = simulate(task)
    if cpu_iterations:
        hashlib.pbkdf2_hmac("sha256",str(task.seed).encode(),b"battlesim-cpu-demo",cpu_iterations)
    return result, round((perf_counter()-started)*1000,3)
