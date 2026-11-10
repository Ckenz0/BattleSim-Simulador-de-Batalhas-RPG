"""Bounded, read-only infrastructure observations; no control-plane mutations.

Call ``snapshot`` in a worker thread from asynchronous routes. Missing sources
and missing resource samples stay explicit, rather than implying zero load.
"""
import copy
import json
import math
import os
import re
import ssl
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener


QUEUES = ("battles.requests.v1", "battles.events.v1")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_SAMPLE = re.compile(r'^(rabbitmq_queue_messages_ready|rabbitmq_queue_messages_unacked|rabbitmq_queue_consumers)\{([^}]*)\}\s+(\S+)(?:\s+\S+)?$')
_LABEL = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')


def quantity(value, kind):
    """Parse finite nonnegative Kubernetes CPU or memory quantities."""
    if value is None or isinstance(value, bool):
        return None
    match = re.fullmatch(r'([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)', str(value))
    if not match:
        return None
    units = {"": 1, "n": 1e-9, "u": 1e-6, "m": 1e-3}
    if kind == "memory":
        units.update({"k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
                      "P": 1e15, "E": 1e18, "Ki": 1024, "Mi": 1024**2,
                      "Gi": 1024**3, "Ti": 1024**4, "Pi": 1024**5, "Ei": 1024**6})
    if match[2] not in units:
        return None
    try:
        number = float(Decimal(match[1]) * Decimal(str(units[match[2]])))
    except (InvalidOperation, OverflowError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _integer(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
        return int(number) if math.isfinite(number) and number >= 0 and number.is_integer() else None
    except (TypeError, ValueError, OverflowError):
        return None


def _error(exc):
    # Never include exception messages: upstream URLs and tokens can appear there.
    if isinstance(exc, HTTPError):
        return f"http_{exc.code}" if 100 <= exc.code <= 599 else "http_error"
    if isinstance(exc, (TimeoutError,)):
        return "timeout"
    if isinstance(exc, URLError):
        return "timeout" if isinstance(exc.reason, TimeoutError) else "connection_error"
    if isinstance(exc, ssl.SSLError):
        return "tls_error"
    if isinstance(exc, OSError):
        return "connection_error"
    return "invalid_response"


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ControlMetrics:
    def __init__(self, *, service_account_dir="/var/run/secrets/kubernetes.io/serviceaccount",
                 timeout=2.0, cache_seconds=5.0):
        self.service_account_dir = Path(service_account_dir)
        self.timeout = max(0.1, min(float(timeout), 3.0))
        self.cache_seconds = max(0.0, float(cache_seconds))
        self._lock = threading.Lock()
        self._cached = None
        self._cached_at = None

    def snapshot(self):
        """Single-flight refresh, with independent snapshots for callers."""
        with self._lock:
            if self._cached is None or time.monotonic() - self._cached_at >= self.cache_seconds:
                self._cached = {"broker": self._broker(), "cluster": self._cluster()}
                self._cached_at = time.monotonic()
            return copy.deepcopy(self._cached)

    def _get(self, url, *, headers=None, context=None, as_json=True):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            raise ValueError("invalid telemetry endpoint")
        handlers = [ProxyHandler({}), _NoRedirect()]
        if context is not None:
            handlers.append(HTTPSHandler(context=context))
        opener = build_opener(*handlers)
        with opener.open(Request(url, headers=headers or {}, method="GET"), timeout=self.timeout) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise ValueError("response too large")
        text = payload.decode("utf-8")
        if not as_json:
            return text
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value

    def _broker(self):
        result = {"status": "not_configured", "observed_at": None,
                  "source": "rabbitmq_prometheus", "error_code": None, "queues": []}
        url = os.environ.get("RABBITMQ_METRICS_URL", "http://rabbitmq:15692/metrics/per-object").strip()
        if not url:
            return result
        try:
            text = self._get(url, as_json=False)
            rows = {name: {"name": name} for name in QUEUES}
            keys = {"rabbitmq_queue_messages_ready": "ready", "rabbitmq_queue_messages_unacked": "unacknowledged", "rabbitmq_queue_consumers": "consumers"}
            for line in text.splitlines():
                match = _SAMPLE.fullmatch(line.strip())
                if not match:
                    continue
                labels = {name: json.loads('"' + value + '"') for name, value in _LABEL.findall(match[2])}
                name = labels.get("queue")
                if name not in rows or labels.get("vhost", "/") != "/":
                    continue
                number = _integer(match[3])
                if number is None or keys[match[1]] in rows[name]:
                    raise ValueError("invalid queue sample")
                rows[name][keys[match[1]]] = number
            if not all(len(row) == 4 for row in rows.values()):
                raise ValueError("missing queue samples")
            result.update(status="ok", observed_at=_now(), queues=list(rows.values()))
        except Exception as exc:
            result.update(status="unavailable", error_code=_error(exc))
        return result

    def _cluster(self):
        result = {"status": "not_configured", "observed_at": None, "source": "kubernetes",
            "error_code": None, "desired_replicas": None, "available_replicas": None,
            "ready_workers": None, "slots_per_worker": None, "configured_capacity": None,
            "hpa": {key: None for key in ("min_replicas", "max_replicas", "current_replicas", "desired_replicas", "target_cpu_percent", "current_cpu_percent")},
            "hpa_error_code": None, "metrics_status": "not_configured", "metrics_error_code": None,
            "metrics_observed_at": None, "pods": []}
        host, port = os.environ.get("KUBERNETES_SERVICE_HOST"), os.environ.get("KUBERNETES_SERVICE_PORT")
        if not host or not port:
            return result
        try:
            token = (self.service_account_dir / "token").read_text().strip()
            namespace = (self.service_account_dir / "namespace").read_text().strip()
            if not token or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", namespace):
                raise ValueError("invalid service account")
            if not port.isdigit() or not 0 < int(port) <= 65535 or any(char in host for char in "/@?#"):
                raise ValueError("invalid Kubernetes endpoint")
            context = ssl.create_default_context(cafile=str(self.service_account_dir / "ca.crt"))
            base = f"https://{'[' + host + ']' if ':' in host and not host.startswith('[') else host}:{port}"
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            ns = quote(namespace, safe="")
            selector = urlencode({"labelSelector": "app=service-b"})

            def get(path):
                return self._get(base + path, headers=headers, context=context)

            pods = get(f"/api/v1/namespaces/{ns}/pods?{selector}")["items"]
            if not isinstance(pods, list):
                raise ValueError("expected pods")
            slot_values = []
            for pod in pods:
                summary, slots = self._pod(pod)
                result["pods"].append(summary)
                slot_values.append((summary["ready"], slots))
            result["ready_workers"] = sum(pod["ready"] for pod in result["pods"])
            unique_slots = {slots for _, slots in slot_values}
            if len(unique_slots) == 1:
                result["slots_per_worker"] = unique_slots.pop()
            if all(slots is not None for ready, slots in slot_values if ready):
                result["configured_capacity"] = sum(slots for ready, slots in slot_values if ready)
            deployment = get(f"/apis/apps/v1/namespaces/{ns}/deployments/service-b")
            result["desired_replicas"] = _integer(deployment.get("spec", {}).get("replicas"))
            result["available_replicas"] = _integer(deployment.get("status", {}).get("availableReplicas", 0))
            result.update(status="ok", observed_at=_now())
            try:
                hpa = get(f"/apis/autoscaling/v2/namespaces/{ns}/horizontalpodautoscalers/service-b")
                self._hpa(result["hpa"], hpa)
            except Exception as exc:
                result["hpa_error_code"] = _error(exc)
            try:
                metrics = get(f"/apis/metrics.k8s.io/v1beta1/namespaces/{ns}/pods?{selector}")
                self._metrics(result, metrics)
                result["metrics_status"] = "partial" if any(pod["ready"] and pod["cpu_cores"] is None for pod in result["pods"]) else "ok"
            except Exception as exc:
                result.update(metrics_status="unavailable", metrics_error_code=_error(exc))
        except Exception as exc:
            result.update(status="unavailable", error_code=_error(exc))
        return result

    @staticmethod
    def _pod(pod):
        metadata, spec, status = pod.get("metadata", {}), pod.get("spec", {}), pod.get("status", {})
        containers = spec.get("containers", [])
        worker = next((container for container in containers if container.get("name") == "worker"), None)
        if worker is None:
            raise ValueError("missing worker container")
        ready = status.get("phase") == "Running" and not metadata.get("deletionTimestamp") and any(
            condition.get("type") == "Ready" and condition.get("status") == "True" for condition in status.get("conditions", []))
        row = {"name": metadata["name"], "uid": metadata.get("uid"), "phase": status.get("phase"),
               "ready": bool(ready), "cpu_cores": None, "memory_bytes": None,
               "restarts": sum(_integer(item.get("restartCount")) or 0 for item in status.get("containerStatuses", []))}
        resources = worker.get("resources", {})
        for field, group, resource, kind in (("cpu_request_cores", "requests", "cpu", "cpu"),
                ("cpu_limit_cores", "limits", "cpu", "cpu"), ("memory_request_bytes", "requests", "memory", "memory"),
                ("memory_limit_bytes", "limits", "memory", "memory")):
            row[field] = quantity(resources.get(group, {}).get(resource), kind)
        override = os.environ.get("CONTROL_WORKER_CONCURRENCY")
        env = next((item for item in worker.get("env", []) if item.get("name") == "WORKER_CONCURRENCY"), None)
        if env is not None and "value" in env:
            value = env["value"]
        elif env is not None or worker.get("envFrom"):
            value = override
        else:
            value = "1"
        slots = _integer(value)
        return row, slots if slots and slots > 0 else None

    @staticmethod
    def _hpa(result, hpa):
        spec, status = hpa.get("spec", {}), hpa.get("status", {})
        for key, source, field in (("min_replicas", spec, "minReplicas"), ("max_replicas", spec, "maxReplicas"),
                ("current_replicas", status, "currentReplicas"), ("desired_replicas", status, "desiredReplicas")):
            result[key] = _integer(source.get(field))
        for source, items_key, object_key, field, key in ((spec, "metrics", "target", "averageUtilization", "target_cpu_percent"),
                (status, "currentMetrics", "current", "averageUtilization", "current_cpu_percent")):
            for metric in source.get(items_key, []):
                resource = metric.get("resource", {})
                if metric.get("type") == "Resource" and resource.get("name") == "cpu":
                    result[key] = _integer(resource.get(object_key, {}).get(field))

    @staticmethod
    def _metrics(result, metrics):
        items = metrics["items"]
        if not isinstance(items, list):
            raise ValueError("expected metrics")
        by_name = {item["metadata"]["name"]: item for item in items}
        timestamps = []
        updates = []
        for pod in result["pods"]:
            item = by_name.get(pod["name"])
            if item is None or (item.get("metadata", {}).get("uid") and item["metadata"]["uid"] != pod["uid"]):
                continue
            usage = next((container.get("usage", {}) for container in item.get("containers", []) if container.get("name") == "worker"), None)
            if usage is None:
                continue
            cpu, memory = quantity(usage.get("cpu"), "cpu"), quantity(usage.get("memory"), "memory")
            if cpu is None or memory is None:
                raise ValueError("invalid metric quantity")
            updates.append((pod, cpu, memory))
            if isinstance(item.get("timestamp"), str):
                timestamps.append(item["timestamp"])
        for pod, cpu, memory in updates:
            pod.update(cpu_cores=cpu, memory_bytes=memory)
        result["metrics_observed_at"] = min(timestamps) if timestamps else None
