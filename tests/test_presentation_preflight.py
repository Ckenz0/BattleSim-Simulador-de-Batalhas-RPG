import copy
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")
pytestmark = pytest.mark.skipif(not POWERSHELL, reason="PowerShell is required")


def evaluate(snapshot, tmp_path, operation="Get-PresentationChecks -Snapshot $snapshot"):
    fixture = tmp_path / "snapshot.json"
    fixture.write_text(json.dumps(snapshot), encoding="utf-8")
    module = str(ROOT / "scripts/Presentation.psm1").replace("'", "''")
    source = str(fixture).replace("'", "''")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command",
         f"$ErrorActionPreference='Stop'; Import-Module '{module}' -Force; "
         f"$snapshot=Get-Content -Raw -Encoding utf8 '{source}' | ConvertFrom-Json; "
         f"{operation} | ConvertTo-Json -Depth 8 -Compress"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.lstrip("\ufeff"))


@pytest.fixture
def ready_snapshot():
    workload = lambda name, kind="Deployment": {
        "kind": kind, "metadata": {"name": name, "generation": 1}, "spec": {"replicas": 1},
        "status": {"observedGeneration": 1, "readyReplicas": 1, "updatedReplicas": 1,
                   "availableReplicas": 1},
    }
    control = {"api": {"status": "ok", "database": True, "broker_connected": True},
               "application": {"pending": 0, "processing": 0, "unpublished": 0},
               "broker": {"status": "ok", "queues": [
                   {"name": "battles.requests.v1", "ready": 0, "unacknowledged": 0, "consumers": 1},
                   {"name": "battles.events.v1", "ready": 0, "unacknowledged": 0, "consumers": 1}]},
               "cluster": {"status": "ok", "metrics_status": "ok", "ready_workers": 1,
                           "hpa": {"current_replicas": 1, "desired_replicas": 1, "current_cpu_percent": 0},
                           "pods": [{"ready": True, "cpu_cores": 0, "memory_bytes": 1048576}]}}
    return {"dockerInstalled": True, "kubectlInstalled": True, "engine": True,
            "composeServices": [{"Service": s, "State": "running", "Health": "healthy" if s != "service-b" else ""}
                                for s in ["nginx", "service-a", "service-b", "rabbitmq"]],
            "nodes": [{"status": {"conditions": [{"type": "Ready", "status": "True"}]}}],
            "workloads": [workload(n) for n in ["service-a", "service-b", "frontend"]] + [workload("rabbitmq", "StatefulSet")],
            "pvcs": [{"metadata": {"name": n}, "status": {"phase": "Bound"}}
                     for n in ["api-data", "data-rabbitmq-0"]],
            "ingress": {"spec": {"ingressClassName": "nginx", "rules": [{"host": "localhost"}]}},
            "controller": workload("nginx-ingress"),
            "healthCompose": {"status": "ok", "database": True, "broker_connected": True},
            "healthCluster": {"status": "ok", "database": True, "broker_connected": True},
            "controlCompose": copy.deepcopy(control), "controlCluster": control, "frontendModule": True,
            "hpa": {"spec": {"minReplicas": 1, "maxReplicas": 5, "scaleTargetRef": {"name": "service-b", "kind": "Deployment"},
                              "metrics": [{"type": "Resource", "resource": {"name": "cpu", "target": {"type": "Utilization", "averageUtilization": 60}}}]}},
            "workerConfig": {"cpuIterations": "5000000", "concurrency": "1", "cpuRequest": "250m"}}


def failed_checks(report):
    return {row["Id"] for row in report if row["Status"] == "FAIL"}


def test_ready_environment_including_measured_zero_passes(ready_snapshot, tmp_path):
    checks = evaluate(ready_snapshot, tmp_path)
    assert not failed_checks(checks)
    assert {"docker", "compose", "nodes", "workloads", "storage", "ingress", "metrics", "hpa", "queues", "baseline", "frontend"} <= {row["Id"] for row in checks}


def test_missing_engine_reports_action_without_raw_connection_details(ready_snapshot, tmp_path):
    ready_snapshot["engine"] = False
    ready_snapshot["private_error"] = "amqp://user:secret@internal"
    checks = evaluate(ready_snapshot, tmp_path)
    assert "docker" in failed_checks(checks)
    assert "secret" not in json.dumps(checks)
    assert all(row["Action"] for row in checks if row["Status"] == "FAIL")


@pytest.mark.parametrize("change, expected", [
    (lambda s: s["workloads"][1]["status"].update(readyReplicas=0), "workloads"),
    (lambda s: s["workloads"][0]["status"].update(observedGeneration=0), "workloads"),
    (lambda s: s["workloads"][0]["status"].update(availableReplicas=0), "workloads"),
    (lambda s: s["controller"]["status"].update(availableReplicas=0), "ingress"),
    (lambda s: s["pvcs"][0]["status"].update(phase="Pending"), "storage"),
    (lambda s: s["composeServices"][0].update(Health="starting"), "compose"),
    (lambda s: s["hpa"]["spec"].update(minReplicas=5), "hpa"),
    (lambda s: s["workerConfig"].update(cpuIterations="0"), "hpa"),
    (lambda s: s["workerConfig"].update(concurrency="20"), "hpa"),
    (lambda s: s["controlCluster"]["cluster"].update(metrics_status="unavailable"), "metrics"),
    (lambda s: s["controlCluster"]["cluster"]["pods"][0].update(cpu_cores=None), "metrics"),
    (lambda s: s["controlCluster"]["cluster"]["hpa"].update(current_cpu_percent=None), "metrics"),
    (lambda s: s["controlCluster"]["application"].update(pending=3), "queues"),
    (lambda s: s["controlCompose"]["application"].pop("unpublished"), "queues"),
    (lambda s: s["controlCluster"]["broker"].update(queues=[]), "queues"),
    (lambda s: s["controlCluster"]["cluster"]["hpa"].update(current_replicas=5), "baseline"),
    (lambda s: s.update(frontendModule=False), "frontend"),
])
def test_incomplete_environment_is_not_declared_ready(ready_snapshot, tmp_path, change, expected):
    change(ready_snapshot)
    assert expected in failed_checks(evaluate(ready_snapshot, tmp_path))


def test_native_runner_preserves_arguments_with_spaces_and_stops_on_timeout(tmp_path):
    module = str(ROOT / "scripts/Presentation.psm1").replace("'", "''")
    native = tmp_path / "native argument reader.ps1"
    native.write_text("param([string]$Value) [Console]::Write($Value)", encoding="ascii")
    native_path = str(native).replace("'", "''")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command",
         f"Import-Module '{module}' -Force; "
         f"$first=Invoke-PresentationCommand -Command powershell -Arguments @('-NoProfile','-File','{native_path}','a\"b c\\') -TimeoutSeconds 5; "
         "$second=Invoke-PresentationCommand -Command powershell -Arguments @('-NoProfile','-Command','Start-Sleep -Seconds 10') -TimeoutSeconds 1; "
         "@{first=$first;second=$second} | ConvertTo-Json -Compress"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout.lstrip("\ufeff"))
    assert data["first"]["Ok"] and data["first"]["Text"] == 'a"b c\\'
    assert not data["second"]["Ok"] and data["second"]["TimedOut"]


def test_launcher_failure_has_nonzero_exit_and_machine_readable_report(tmp_path):
    report = tmp_path / "readiness report.json"
    environment = {**os.environ, "PATH": ""}
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-File", str(ROOT / "scripts/Prepare-Presentation.ps1"),
         "-ReportPath", str(report)], env=environment, capture_output=True, timeout=15,
    )
    assert result.returncode == 1
    recorded = json.loads(report.read_text(encoding="utf-8-sig"))
    assert recorded["ready"] is False and recorded["startup_requested"] is False
    assert "docker" in failed_checks(recorded["checks"])
    assert all(row["Action"] for row in recorded["checks"] if row["Status"] == "FAIL")


@pytest.mark.parametrize("engine_ready", [True, False])
def test_startup_only_starts_existing_components_without_scaling_or_deleting(engine_ready, tmp_path):
    module = str(ROOT / "scripts/Presentation.psm1").replace("'", "''")
    fake_root = str(tmp_path).replace("'", "''")
    ingress = tmp_path / "k8s/Start-LocalIngress.ps1"
    ingress.parent.mkdir()
    ingress.write_text("# Intentional no-op replacing the process boundary in this unit test.", encoding="ascii")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command",
         f"Import-Module '{module}' -Force; & (Get-Module Presentation) {{ "
         "$script:commands=New-Object System.Collections.Generic.List[string]; "
         "function Invoke-PresentationCommand { param($Command,$Arguments,$TimeoutSeconds,$WorkingDirectory) "
         "$script:commands.Add($Command+' '+($Arguments -join ' ')); "
         f"if ($Arguments[0] -eq 'info') {{ return @{{Ok=${str(engine_ready).lower()};Text='';TimedOut=$false}} }}; "
         "return @{Ok=$true;Text='';TimedOut=$false} }; "
         f"Start-PresentationServices -ProjectRoot '{fake_root}' -TimeoutSeconds 15; "
         "$script:commands | ConvertTo-Json -Compress }"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
    )
    assert result.returncode == 0, result.stderr
    # Write-Host progress precedes the final JSON array.
    commands = json.loads(next(line for line in result.stdout.splitlines() if line.startswith("[")))
    assert any("compose up -d --wait" in command for command in commands)
    assert any("desktop start" in command for command in commands) is (not engine_ready)
    assert any("Start-LocalIngress.ps1" in command and "-File" in command for command in commands)
    assert all("delete" not in command and " scale " not in command and "apply" not in command for command in commands)


def test_compose_address_follows_published_nginx_port(ready_snapshot, tmp_path):
    ready_snapshot["composeServices"][0]["Publishers"] = [
        {"URL": "0.0.0.0", "TargetPort": 80, "PublishedPort": 8188, "Protocol": "tcp"}]
    assert evaluate(ready_snapshot, tmp_path, "Get-PresentationComposeUrl -Services $snapshot.composeServices") == "http://127.0.0.1:8188"


def test_statefulset_does_not_require_deployment_only_availability_field(ready_snapshot, tmp_path):
    ready_snapshot["workloads"][-1]["status"].pop("availableReplicas")
    assert not failed_checks(evaluate(ready_snapshot, tmp_path))
