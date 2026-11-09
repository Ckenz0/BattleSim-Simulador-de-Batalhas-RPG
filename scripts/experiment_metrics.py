"""Pure offline metrics for controlled local-cluster experiments.

All durations are nonnegative; all timestamps must identify timezone-aware
instants. CPU input is a per-pod cgroup counter *delta*, in seconds, across the
same wall interval as elapsed_seconds (not an absolute counter or CPU percent).
The caller must exclude warmups and validate the unchanged workload settings.
For operator diagnostics whose counter reads bracket the batch timer, label the
CPU-core ratio approximate and disclose the extra diagnostic interval/overhead.
No I/O or third-party dependencies are used here.
"""

import math
from collections import defaultdict
from datetime import datetime, timezone
from numbers import Real
from statistics import mean, median


def _number(value, name, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite number")
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError(f"{name} must be finite and {'positive' if positive else 'nonnegative'}")
    return float(value)


def _instant(value, name):
    try:
        instant = datetime.fromisoformat(value) if isinstance(value, str) else value
        if not isinstance(instant, datetime) or instant.utcoffset() is None:
            raise ValueError(f"{name} must be a timezone-aware timestamp")
        return instant.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a valid timezone-aware timestamp") from exc


def _stats(values):
    values = list(values)
    if not values:
        return {"mean": None, "p50": None, "p95": None, "max": None}
    return {"mean": mean(values), "p50": percentile(values, .5),
            "p95": percentile(values), "max": max(values)}


def validate_completed_batch(rows, expected_ids):
    """Require exactly one completed row for every original accepted battle ID.

    Duplicate expected IDs are also invalid: a set comparison alone would hide
    a broken submission manifest or duplicate persisted rows.
    """
    rows, expected_ids = list(rows), list(expected_ids)
    try:
        if len(set(expected_ids)) != len(expected_ids):
            raise ValueError("expected_ids contains duplicates")
        if any(not battle_id for battle_id in expected_ids):
            raise ValueError("expected_ids contains an empty ID")
        actual_ids = [row["id"] for row in rows]
        if any(not battle_id for battle_id in actual_ids):
            raise ValueError("rows contain an empty ID")
        if len(set(actual_ids)) != len(actual_ids):
            raise ValueError("rows contain duplicate battle IDs")
        missing = set(expected_ids) - set(actual_ids)
        unexpected = set(actual_ids) - set(expected_ids)
        if missing or unexpected:
            raise ValueError(f"battle IDs mismatch: missing={missing!r}; unexpected={unexpected!r}")
        incomplete = [row["id"] for row in rows if row.get("status") != "completed"]
        if incomplete:
            raise ValueError(f"battles are not completed: {incomplete!r}")
    except (KeyError, TypeError) as exc:
        raise ValueError("rows and expected_ids must contain valid battle IDs") from exc


def percentile(values, fraction=.95):
    """Return the nearest-rank quantile: sorted[ceil(fraction * n) - 1].

    fraction is in (0, 1], with no interpolation. Samples must be finite and
    nonnegative. Empty samples have no percentile and raise ValueError.
    """
    fraction = _number(fraction, "fraction", positive=True)
    if fraction > 1:
        raise ValueError("fraction must be in (0, 1]")
    ordered = sorted(_number(value, "sample") for value in values)
    if not ordered:
        raise ValueError("percentile requires at least one sample")
    return ordered[math.ceil(fraction * len(ordered)) - 1]


def summarize_trial(rows, started_at_by_id, elapsed_seconds, cpu_seconds_by_pod):
    """Summarize a completed measured batch into JSON-serializable values.

    latency_ms = persisted updated_at - accepted created_at.
    pre_worker_wait_ms = earliest observed battle_processing log - created_at;
    it includes outbox, transport and worker admission time, not just broker
    queue time. started_at_by_id accepts an aware datetime/ISO string per ID,
    or an iterable of timestamps for repeated attempts. Missing/empty logs do
    not fabricate zero waits: sample_count exposes coverage and all four
    statistics are None if no start was observed. Extra log IDs are ignored.

    processing_ms is the API-reported worker processing duration. This module
    cannot measure attempts that never produced a persisted result.
    """
    rows = list(rows)
    if not rows:
        raise ValueError("a measured trial must contain completed battles")
    try:
        validate_completed_batch(rows, [row["id"] for row in rows])
    except (KeyError, TypeError) as exc:
        raise ValueError("trial rows must contain battle IDs") from exc
    elapsed = _number(elapsed_seconds, "elapsed_seconds", positive=True)
    cpu = {pod: _number(seconds, f"CPU delta for {pod}")
           for pod, seconds in cpu_seconds_by_pod.items()}
    cpu_total = _number(sum(cpu.values()), "total CPU seconds")
    latencies, waits, processing = [], [], []
    for row in rows:
        try:
            created = _instant(row["created_at"], "created_at")
            finished = _instant(row["updated_at"], "updated_at")
            latencies.append(_number((finished - created).total_seconds() * 1000, "latency_ms"))
            processing.append(_number(row["processing_ms"], "processing_ms"))
        except KeyError as exc:
            raise ValueError(f"missing trial field: {exc.args[0]}") from exc
        starts = started_at_by_id.get(row["id"])
        if starts is None:
            continue
        if isinstance(starts, (str, datetime)):
            starts = [starts]
        instants = [_instant(start, "battle_processing timestamp") for start in starts]
        if instants:
            wait = (min(instants) - created).total_seconds() * 1000
            waits.append(_number(wait, "pre_worker_wait_ms"))
    return {
        "count": len(rows), "elapsed_seconds": elapsed,
        "throughput_per_second": _number(len(rows) / elapsed, "throughput", positive=True),
        "latency_ms": _stats(latencies),
        "pre_worker_wait_ms": {"sample_count": len(waits), **_stats(waits)},
        "processing_ms": _stats(processing), "cpu_seconds": cpu_total,
        "mean_worker_cpu_cores": _number(cpu_total / elapsed, "mean worker CPU cores"),
        "cpu_seconds_by_pod": cpu,
    }


def aggregate_comparison(trials):
    """Compare medians of measured trials, grouped and sorted by replica count.

    All trials must have the same positive battle count; warmups must not be
    passed here. A one-replica baseline is required. speedup is baseline median
    elapsed / group median elapsed; efficiency is speedup / replicas. Each
    median_* value is a median of trial statistics, never a pooled percentile.
    For partially observed log-derived statistics, None values are excluded
    from medians and observed_trial_count plus median sample_count show their
    coverage. An entirely unobserved statistic remains None.
    """
    groups = defaultdict(list)
    counts = set()
    for trial in trials:
        replicas, count = trial["replicas"], trial["count"]
        if isinstance(replicas, bool) or not isinstance(replicas, int) or replicas < 1:
            raise ValueError("replicas must be a positive integer")
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise ValueError("trial count must be a positive integer")
        _number(trial["elapsed_seconds"], "elapsed_seconds", positive=True)
        _number(trial["throughput_per_second"], "throughput_per_second", positive=True)
        counts.add(count)
        groups[replicas].append(trial)
    if 1 not in groups:
        raise ValueError("comparison requires a one-replica baseline")
    if len(counts) != 1:
        raise ValueError("comparison requires the same fixed workload count in every trial")

    baseline_elapsed = median(trial["elapsed_seconds"] for trial in groups[1])
    comparison = []
    for replicas, measured in sorted(groups.items()):
        result = {"replicas": replicas, "trial_count": len(measured), "count": next(iter(counts))}
        for field in ("elapsed_seconds", "throughput_per_second", "cpu_seconds", "mean_worker_cpu_cores"):
            result[f"median_{field}"] = median(_number(trial[field], field) for trial in measured)
        for field in ("latency_ms", "pre_worker_wait_ms", "processing_ms"):
            stats = {}
            for statistic in ("mean", "p50", "p95", "max"):
                values = [trial[field][statistic] for trial in measured if trial[field][statistic] is not None]
                stats[statistic] = median(_number(value, f"{field}.{statistic}") for value in values) if values else None
            if field == "pre_worker_wait_ms":
                stats["sample_count"] = median(_number(trial[field]["sample_count"], "sample_count") for trial in measured)
                stats["observed_trial_count"] = sum(trial[field]["mean"] is not None for trial in measured)
            result[f"median_{field}"] = stats
        result["speedup"] = baseline_elapsed / result["median_elapsed_seconds"]
        result["efficiency"] = result["speedup"] / replicas
        comparison.append(result)
    return comparison
