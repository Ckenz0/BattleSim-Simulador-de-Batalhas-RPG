"""Read-only control telemetry contracts using realistic upstream responses."""
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError

import pytest

from api.control_metrics import ControlMetrics, quantity


PROMETHEUS = '''# HELP rabbitmq_queue_messages_ready Messages ready to be delivered
rabbitmq_queue_messages_ready{vhost="/",queue="battles.requests.v1"} 17
rabbitmq_queue_messages_unacked{vhost="/",queue="battles.requests.v1"} 3
rabbitmq_queue_consumers{queue="battles.requests.v1",vhost="/"} 2
rabbitmq_queue_messages_ready{queue="battles.events.v1",vhost="/"} 4
rabbitmq_queue_messages_unacked{queue="battles.events.v1",vhost="/"} 0
rabbitmq_queue_consumers{queue="battles.events.v1",vhost="/"} 1
rabbitmq_queue_messages_ready{queue="battles.dead.v1",vhost="/"} 99
'''


def pod(name="worker-a", *, ready=True, slots="4"):
    env = [{"name": "WORKER_CONCURRENCY", "value": slots}] if slots is not None else []
    return {
        "metadata": {"name": name, "uid": name + "-uid"},
        "spec": {"containers": [{"name": "worker", "env": env,
            "resources": {"requests": {"cpu": "250m", "memory": "128Mi"},
                          "limits": {"cpu": "1", "memory": "256Mi"}}}]},
        "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
                   "containerStatuses": [{"name": "worker", "restartCount": 2}]},
    }


@pytest.fixture
def upstream(monkeypatch, tmp_path):
    for key in ("KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "CONTROL_WORKER_CONCURRENCY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("RABBITMQ_METRICS_URL", "http://rabbitmq:15692/metrics/per-object")
    for name, value in {"token": "private-token", "namespace": "battlesim", "ca.crt": "test-ca"}.items():
        (tmp_path / name).write_text(value)
    responses = {
        "/metrics/per-object": PROMETHEUS,
        "/api/v1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b": {"items": [pod(), pod("worker-b", ready=False)]},
        "/apis/apps/v1/namespaces/battlesim/deployments/service-b": {"spec": {"replicas": 2}, "status": {"availableReplicas": 1}},
        "/apis/autoscaling/v2/namespaces/battlesim/horizontalpodautoscalers/service-b": {
            "spec": {"minReplicas": 1, "maxReplicas": 5, "metrics": [{"type": "Resource", "resource": {"name": "cpu", "target": {"averageUtilization": 60}}}]},
            "status": {"currentReplicas": 2, "desiredReplicas": 3, "currentMetrics": [{"type": "Resource", "resource": {"name": "cpu", "current": {"averageUtilization": 82}}}]}},
        "/apis/metrics.k8s.io/v1beta1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b": {"items": [{"metadata": {"name": "worker-a", "uid": "worker-a-uid"}, "timestamp": "2026-11-10T12:00:00Z", "containers": [{"name": "worker", "usage": {"cpu": "123456789n", "memory": "65536Ki"}}]}]},
    }
    calls = []

    class Opener:
        def open(self, request, timeout):
            from urllib.parse import urlsplit
            path = urlsplit(request.full_url).path
            if urlsplit(request.full_url).query:
                path += "?" + urlsplit(request.full_url).query
            calls.append((request, timeout))
            value = responses[path]
            if callable(value):
                value = value()
            if isinstance(value, Exception):
                raise value
            payload = value if isinstance(value, str) else json.dumps(value)
            return io.BytesIO(payload.encode())

    monkeypatch.setattr("api.control_metrics.build_opener", lambda *args: Opener())
    monkeypatch.setattr("api.control_metrics.ssl.create_default_context", lambda **kwargs: object())

    def collector(cluster=False, **kwargs):
        if cluster:
            monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.96.0.1")
            monkeypatch.setenv("KUBERNETES_SERVICE_PORT", "443")
        return ControlMetrics(service_account_dir=tmp_path, **kwargs)
    return collector, responses, calls


def test_broker_parses_real_queue_metric_names_and_filters_other_queues(upstream):
    create, _, calls = upstream
    result = create().snapshot()
    assert result["broker"]["status"] == "ok"
    assert result["broker"]["queues"] == [
        {"name": "battles.requests.v1", "ready": 17, "unacknowledged": 3, "consumers": 2},
        {"name": "battles.events.v1", "ready": 4, "unacknowledged": 0, "consumers": 1}]
    assert result["broker"]["observed_at"]
    assert result["cluster"]["status"] == "not_configured"
    assert all(0 < timeout <= 3 for _, timeout in calls)
    assert all(request.method == "GET" for request, _ in calls)


def test_cluster_capacity_resources_hpa_and_missing_metrics_are_truthful(upstream):
    create, _, calls = upstream
    result = create(cluster=True).snapshot()["cluster"]
    assert result["status"] == "ok"
    assert (result["desired_replicas"], result["available_replicas"], result["ready_workers"]) == (2, 1, 1)
    assert (result["slots_per_worker"], result["configured_capacity"]) == (4, 4)
    assert result["hpa"] == {"min_replicas": 1, "max_replicas": 5, "current_replicas": 2, "desired_replicas": 3, "target_cpu_percent": 60, "current_cpu_percent": 82}
    first, second = result["pods"]
    assert first == {"name": "worker-a", "uid": "worker-a-uid", "phase": "Running", "ready": True,
        "cpu_cores": .123456789, "memory_bytes": 67108864, "restarts": 2,
        "cpu_request_cores": .25, "cpu_limit_cores": 1.0,
        "memory_request_bytes": 134217728, "memory_limit_bytes": 268435456}
    assert second["cpu_cores"] is None and second["memory_bytes"] is None
    assert result["metrics_status"] == "ok"
    assert result["metrics_observed_at"] == "2026-11-10T12:00:00Z"
    assert all(request.get_header("Authorization") == "Bearer private-token" for request, _ in calls if request.full_url.startswith("https:"))
    assert "private-token" not in json.dumps(result)


def test_metrics_failure_preserves_cluster_state_and_sanitizes_error(upstream):
    create, responses, _ = upstream
    responses["/apis/metrics.k8s.io/v1beta1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"] = HTTPError("https://private-token:password@secret", 403, "private-token", {}, None)
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["status"] == "ok"
    assert cluster["ready_workers"] == 1
    assert cluster["metrics_status"] == "unavailable"
    assert cluster["metrics_error_code"] == "http_403"
    assert cluster["metrics_observed_at"] is None
    assert cluster["pods"][0]["cpu_cores"] is None
    assert "private-token" not in json.dumps(cluster)


def test_broker_errors_are_sanitized_and_empty_config_disables_io(upstream, monkeypatch):
    create, responses, calls = upstream
    responses["/metrics/per-object"] = URLError("private-token at private-host")
    broker = create().snapshot()["broker"]
    assert broker["status"] == "unavailable" and broker["error_code"] == "connection_error"
    assert broker["queues"] == [] and broker["observed_at"] is None
    assert "private" not in json.dumps(broker)
    calls.clear()
    monkeypatch.setenv("RABBITMQ_METRICS_URL", "")
    assert create().snapshot()["broker"]["status"] == "not_configured"
    assert calls == []


@pytest.mark.parametrize("value,kind,expected", [("123n", "cpu", .000000123), ("42u", "cpu", .000042), ("250m", "cpu", .25), ("2", "cpu", 2), ("1.5Gi", "memory", 1610612736), ("64Mi", "memory", 67108864), ("2Ki", "memory", 2048), ("1.5G", "memory", 1500000000), ("500M", "memory", 500000000), ("1000", "memory", 1000), ("NaN", "cpu", None), ("inf", "memory", None), ("-1", "cpu", None), ("bad", "memory", None)])
def test_resource_quantity_units_and_invalid_values(value, kind, expected):
    assert quantity(value, kind) == expected


def test_snapshot_single_flight_cache_expires_and_is_defensive(upstream, monkeypatch):
    create, responses, calls = upstream
    def slow_broker():
        time.sleep(.03)
        return PROMETHEUS
    responses["/metrics/per-object"] = slow_broker
    now = [0.0]
    monkeypatch.setattr("api.control_metrics.time.monotonic", lambda: now[0])
    collector = create()
    with ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = list(pool.map(lambda _: collector.snapshot(), range(16)))
    assert len(calls) == 1
    snapshots[0]["broker"]["queues"].clear()
    assert len(collector.snapshot()["broker"]["queues"]) == 2
    now[0] = 5.01
    collector.snapshot()
    assert len(calls) == 2


def test_incomplete_or_nan_queue_samples_do_not_become_zero(upstream):
    create, responses, _ = upstream
    responses["/metrics/per-object"] = 'rabbitmq_queue_messages_ready{queue="battles.requests.v1"} NaN\n'
    broker = create().snapshot()["broker"]
    assert broker["status"] == "unavailable"
    assert broker["error_code"] == "invalid_response"
    assert broker["queues"] == []


def test_unresolved_env_requires_explicit_concurrency_override(upstream, monkeypatch):
    create, responses, _ = upstream
    path = "/api/v1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"
    responses[path]["items"][0]["spec"]["containers"][0]["env"] = [{"name": "WORKER_CONCURRENCY", "valueFrom": {"configMapKeyRef": {"name": "worker-config", "key": "slots"}}}]
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["slots_per_worker"] is None and cluster["configured_capacity"] is None
    monkeypatch.setenv("CONTROL_WORKER_CONCURRENCY", "6")
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["slots_per_worker"] is None and cluster["configured_capacity"] == 6


def test_actual_pod_concurrency_precedes_api_fallback_during_rollout(upstream, monkeypatch):
    create, _, _ = upstream
    monkeypatch.setenv("CONTROL_WORKER_CONCURRENCY", "20")
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["slots_per_worker"] == 4 and cluster["configured_capacity"] == 4


def test_missing_metrics_for_ready_pods_are_partial_and_never_zero(upstream):
    create, responses, _ = upstream
    path = "/api/v1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"
    responses[path]["items"][1] = pod("worker-b", ready=True)
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["metrics_status"] == "partial"
    assert cluster["pods"][1]["cpu_cores"] is None
    assert cluster["pods"][0]["cpu_cores"] == .123456789


def test_recreated_pod_cannot_receive_old_uid_resource_samples(upstream):
    create, responses, _ = upstream
    path = "/apis/metrics.k8s.io/v1beta1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"
    responses[path]["items"][0]["metadata"]["uid"] = "old-worker-uid"
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["metrics_status"] == "partial"
    assert cluster["metrics_observed_at"] is None
    assert cluster["pods"][0]["cpu_cores"] is None


def test_cluster_api_error_sanitized_and_missing_credentials_unavailable(upstream):
    create, responses, _ = upstream
    responses["/api/v1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"] = TimeoutError("private-token")
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["status"] == "unavailable" and cluster["error_code"] == "timeout"
    assert cluster["ready_workers"] is None
    assert "private-token" not in json.dumps(cluster)


def test_other_virtual_hosts_cannot_override_default_virtual_host(upstream):
    create, responses, _ = upstream
    responses["/metrics/per-object"] += 'rabbitmq_queue_messages_ready{queue="battles.requests.v1",vhost="another"} 999\n'
    assert create().snapshot()["broker"]["queues"][0]["ready"] == 17


def test_hpa_failure_keeps_ready_capacity_and_metrics(upstream):
    create, responses, _ = upstream
    responses["/apis/autoscaling/v2/namespaces/battlesim/horizontalpodautoscalers/service-b"] = HTTPError("secret", 404, "secret", {}, None)
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["status"] == "ok" and cluster["configured_capacity"] == 4
    assert cluster["hpa_error_code"] == "http_404"
    assert cluster["hpa"]["max_replicas"] is None
    assert cluster["pods"][0]["memory_bytes"] == 67108864


def test_oversized_or_malformed_responses_fail_closed(upstream):
    create, responses, _ = upstream
    responses["/metrics/per-object"] = "x" * (2 * 1024 * 1024 + 1)
    assert create().snapshot()["broker"]["error_code"] == "invalid_response"
    responses["/api/v1/namespaces/battlesim/pods?labelSelector=app%3Dservice-b"] = "not-json secret"
    cluster = create(cluster=True).snapshot()["cluster"]
    assert cluster["status"] == "unavailable" and cluster["error_code"] == "invalid_response"


def test_missing_service_account_cannot_send_unauthenticated_request(upstream):
    create, _, calls = upstream
    collector = create(cluster=True)
    (collector.service_account_dir / "token").unlink()
    cluster = collector.snapshot()["cluster"]
    assert cluster["status"] == "unavailable"
    assert all(not request.full_url.startswith("https:") for request, _ in calls)
