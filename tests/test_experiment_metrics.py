"""Offline benchmark metric contracts, with hand-calculated expectations."""

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import experiment_metrics as metrics


def row(battle_id="a", **overrides):
    result = {
        "id": battle_id,
        "status": "completed",
        "created_at": "2026-11-09T12:00:00Z",
        "updated_at": "2026-11-09T12:00:02Z",
        "processing_ms": 500,
        "worker_id": "worker-1",
    }
    result.update(overrides)
    return result


def test_completed_batch_requires_exactly_the_original_ids():
    metrics.validate_completed_batch([row("b"), row("a")], ["a", "b"])
    for rows, expected in [
        ([row("a")], ["a", "b"]),
        ([row("a"), row("a")], ["a", "b"]),
        ([row("a"), row("c")], ["a", "b"]),
        ([row("a", status="processing")], ["a"]),
        ([row("a", status="failed")], ["a"]),
        ([row("a")], ["a", "a"]),
        ([{}], ["a"]),
    ]:
        with pytest.raises(ValueError):
            metrics.validate_completed_batch(rows, expected)


def test_nearest_rank_p95_retains_tail_sample_and_does_not_interpolate():
    assert metrics.percentile(range(1, 21), 0.95) == 19
    assert metrics.percentile([1000, 1, 2], 0.95) == 1000
    assert metrics.percentile([4, 1, 3, 2], 0.5) == 2
    assert metrics.percentile([7], 1) == 7


@pytest.mark.parametrize("values,fraction", [([], .95), ([float("nan")], .95),
    ([float("inf")], .95), ([-1], .95), ([1], 0), ([1], 1.1),
    ([1], float("nan")), ([1], float("inf"))])
def test_percentile_rejects_invalid_samples_and_fraction(values, fraction):
    with pytest.raises(ValueError):
        metrics.percentile(values, fraction)


def test_trial_uses_aware_instants_and_earliest_attempt_without_inventing_waits():
    rows = [row("a"), row("b", created_at="2026-11-09T09:00:00-03:00",
            updated_at=datetime(2026, 11, 9, 12, 0, 4, tzinfo=timezone.utc),
            processing_ms=1500)]
    summary = metrics.summarize_trial(rows, {
        "a": ["2026-11-09T12:00:01.500Z", "2026-11-09T09:00:01-03:00"],
    }, 8, {"worker-1": 6, "worker-2": 2})
    assert summary["count"] == 2
    assert summary["elapsed_seconds"] == 8
    assert summary["throughput_per_second"] == .25
    assert summary["latency_ms"] == {"mean": 3000, "p50": 2000, "p95": 4000, "max": 4000}
    assert summary["processing_ms"] == {"mean": 1000, "p50": 500, "p95": 1500, "max": 1500}
    assert summary["pre_worker_wait_ms"] == {
        "sample_count": 1, "mean": 1000, "p50": 1000, "p95": 1000, "max": 1000}
    assert summary["cpu_seconds"] == 8
    assert summary["mean_worker_cpu_cores"] == 1
    assert summary["cpu_seconds_by_pod"] == {"worker-1": 6, "worker-2": 2}


def test_absent_start_logs_preserve_zero_coverage_and_unknown_wait():
    summary = metrics.summarize_trial([row()], {}, 2, {"worker-1": 1})
    assert summary["pre_worker_wait_ms"] == {
        "sample_count": 0, "mean": None, "p50": None, "p95": None, "max": None}


def test_single_start_timestamp_is_supported():
    summary = metrics.summarize_trial([row()], {"a": "2026-11-09T12:00:00.250Z"}, 2, {})
    assert summary["pre_worker_wait_ms"]["mean"] == 250


@pytest.mark.parametrize("changes,starts,elapsed,cpu", [
    ({"created_at": "2026-11-09T12:00:00"}, {}, 2, {}),
    ({"updated_at": datetime(2026, 11, 9, 12, 0, 2)}, {}, 2, {}),
    ({"updated_at": "invalid"}, {}, 2, {}),
    ({"updated_at": "2026-11-09T11:59:59Z"}, {}, 2, {}),
    ({}, {"a": "2026-11-09T11:59:59Z"}, 2, {}),
    ({}, {"a": "2026-11-09T12:00:01"}, 2, {}),
    ({"processing_ms": -1}, {}, 2, {}),
    ({"processing_ms": float("nan")}, {}, 2, {}),
    ({}, {}, 0, {}), ({}, {}, -1, {}), ({}, {}, float("inf"), {}),
    ({}, {}, 2, {"worker-1": -1}),
    ({}, {}, 2, {"worker-1": float("nan")}),
    ({}, {}, 2, {"worker-1": float("inf")}),
])
def test_trial_rejects_invalid_clock_duration_and_cpu(changes, starts, elapsed, cpu):
    with pytest.raises(ValueError):
        metrics.summarize_trial([row(**changes)], starts, elapsed, cpu)


def test_trial_rejects_empty_or_uncompleted_work():
    for rows in ([], [row(status="failed")], [row(), row()]):
        with pytest.raises(ValueError):
            metrics.summarize_trial(rows, {}, 2, {})


def trial(replicas, elapsed, throughput, count=100):
    return {
        "replicas": replicas, "count": count, "elapsed_seconds": elapsed,
        "throughput_per_second": throughput,
        "latency_ms": {"mean": 1000, "p50": 500, "p95": 2000, "max": 3000},
        "pre_worker_wait_ms": {"sample_count": 0, "mean": None, "p50": None, "p95": None, "max": None},
        "processing_ms": {"mean": 100, "p50": 80, "p95": 200, "max": 300},
        "cpu_seconds": 60, "mean_worker_cpu_cores": 1,
        "cpu_seconds_by_pod": {"worker-1": 60},
    }


def test_fixed_workload_aggregation_uses_trial_medians_and_single_worker_baseline():
    # Unsorted trials, a large outlier, and fewer than three measured worker counts.
    result = metrics.aggregate_comparison([
        trial(3, 20, 5), trial(1, 100, 1), trial(3, 10, 10),
        trial(1, 60, 100 / 60), trial(3, 100, 1), trial(1, 50, 2),
    ])
    assert [group["replicas"] for group in result] == [1, 3]
    baseline, scaled = result
    assert baseline["median_elapsed_seconds"] == 60
    assert baseline["median_throughput_per_second"] == 100 / 60
    assert baseline["speedup"] == 1
    assert baseline["efficiency"] == 1
    assert scaled["trial_count"] == 3
    assert scaled["count"] == 100
    assert scaled["median_elapsed_seconds"] == 20
    assert scaled["median_throughput_per_second"] == 5
    assert scaled["speedup"] == 3
    assert scaled["efficiency"] == 1
    assert scaled["median_latency_ms"]["p95"] == 2000
    assert scaled["median_pre_worker_wait_ms"]["mean"] is None
    assert scaled["median_cpu_seconds"] == 60


@pytest.mark.parametrize("trials", [[], [trial(3, 20, 5)],
    [trial(1, 60, 100 / 60), trial(3, 20, 5, count=99)],
    [trial(0, 60, 100 / 60), trial(1, 60, 100 / 60)],
    [trial(1.5, 60, 100 / 60), trial(1, 60, 100 / 60)],
    [trial(1, 0, 1)], [trial(1, 2, float("nan"))]])
def test_comparison_rejects_missing_baseline_and_uncontrolled_workloads(trials):
    with pytest.raises(ValueError):
        metrics.aggregate_comparison(trials)
