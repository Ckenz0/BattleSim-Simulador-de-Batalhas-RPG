"""Controlled local failure and1/3/5worker comparison; restores cluster settings.

Requires explicit --allow-cluster-mutations. Creates test records, temporarily
changes only worker CPU/HPA bounds, and removes one verified worker Pod with a
five-second grace period. Never removes data, Secrets, API or broker resources.
"""
import argparse
import hashlib
import json
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from cluster_experiments import LocalCluster, preserve_settings, recover_attempts, validate_profile
from experiment_metrics import aggregate_comparison, summarize_trial, validate_completed_batch


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2), encoding='utf-8')


def progress(event, **fields):
    print(json.dumps(dict(timestamp=now(), event=event, **fields)), flush=True)


def wait_batch(client, batch, *, timeout=300):
    deadline, last_print = time.monotonic() + timeout, 0
    while time.monotonic() < deadline:
        rows = client.records(batch['batch_id'])
        counts = Counter(row['status'] for row in rows)
        if counts['failed']:
            raise RuntimeError(f"Batch {batch['batch_id']} has failed results")
        if len(rows) == batch['count'] and counts['completed'] == batch['count']:
            validate_completed_batch(rows, batch['battle_ids'])
            return rows
        if time.monotonic() - last_print >= 10:
            progress('batch_progress', batch_id=batch['batch_id'], statuses=dict(counts))
            last_print = time.monotonic()
        time.sleep(1)
    raise TimeoutError(f"Batch {batch['batch_id']} did not finish")


def identities(pods):
    return sorted((p['metadata']['name'], p['metadata']['uid'],
                   p['status']['containerStatuses'][0]['containerID'],
                   p['status']['containerStatuses'][0]['restartCount']) for p in pods)


def controlled_pods(pods, settings, cpu_env):
    records = []
    for pod in pods:
        worker = next(c for c in pod['spec']['containers'] if c['name'] == 'worker')
        env = {e['name']: e for e in worker.get('env', [])}
        if (worker['image'] != settings['worker_image'] or worker['resources'] != settings['resources'] or
                env.get('WORKER_CONCURRENCY', {}).get('value') != '20' or
                env.get('WORKER_CPU_ITERATIONS') != cpu_env):
            raise ValueError('A Pod does not match the controlled image/resources/concurrency/CPU override')
        records.append(dict(name=pod['metadata']['name'], uid=pod['metadata']['uid'], image=worker['image'],
                            resources=worker['resources'], cpu_env=cpu_env, concurrency=20))
    return records


def validate_fault_runtime(cpu_by_worker):
    if len(cpu_by_worker) != 5 or any(value != 10_000_000 for value in cpu_by_worker.values()):
        raise ValueError('The fault case requires five warm workers with CPU iterations10000000')


def failure_case(client, pair, report, output):
    client.wait_idle()
    before_pods = client.wait_workers(5)
    client.trace = 'failure100-' + uuid4().hex
    batch = client.batch(pair)
    case = report['failure'] = dict(batch_id=batch['batch_id'], expected_ids=batch['battle_ids'],
                                   request_id=client.trace, started_at=now(), samples=[])
    save(output, report)
    deadline, victim = time.monotonic() + 45, None
    while time.monotonic() < deadline:
        queue = client.request_queue()
        case['samples'].append(dict(timestamp=now(), broker=queue))
        if queue['messages_unacknowledged'] >= 80:
            events = client.worker_events()
            batch_ids = set(batch['battle_ids'])
            running = {}
            for event in sorted(events, key=lambda e: e['timestamp']):
                if event.get('battle_id') not in batch_ids:
                    continue
                if event['event'] == 'battle_processing':
                    running[event['battle_id']] = event
                elif event['event'] == 'battle_finished':
                    running.pop(event['battle_id'], None)
            for pod in before_pods:
                candidate = [event for event in running.values() if event['worker_id'] == pod['metadata']['name']]
                if candidate:
                    victim, before_events = pod, candidate
                    break
            if victim:
                break
        time.sleep(.25)
    if victim is None:
        raise RuntimeError('No active worker from this batch was identified; no Pod was removed')
    case.update(victim={'name': victim['metadata']['name'], 'uid': victim['metadata']['uid']},
                victim_started_events=before_events, delete_requested_at=now(), delete_grace_seconds=5)
    save(output, report)
    progress('removing_active_worker', **case['victim'], active_batch_attempts=len(before_events))
    client.delete_worker(victim['metadata']['name'], victim['metadata']['uid'])
    rows = wait_batch(client, batch)
    client.wait_idle()
    after_pods = client.wait_workers(5)
    old_uids = {p['metadata']['uid'] for p in before_pods}
    replacements = [p for p in after_pods if p['metadata']['uid'] not in old_uids]
    if not replacements or any(p['metadata']['uid'] == victim['metadata']['uid'] for p in after_pods):
        raise RuntimeError('New Ready replacement UID was not verified')
    after_events = client.worker_events()
    retried = recover_attempts(before_events, after_events, set(batch['battle_ids']))
    if not retried:
        raise RuntimeError('All results finished, but no changed attempt ID proved redelivery')
    case.update(completed=len(rows), failed=0, unique_ids=len({r['id'] for r in rows}),
                rows=rows, final_broker=client.request_queue(),
                final_ready_pods=[dict(name=p['metadata']['name'], uid=p['metadata']['uid'],
                    conditions=p['status']['conditions']) for p in after_pods],
                replacements=[{'name': p['metadata']['name'], 'uid': p['metadata']['uid']} for p in replacements],
                retried_battle_ids=retried, retries_verified=len(retried),
                worker_distribution=dict(Counter(r['worker_id'] for r in rows)),
                after_events=[e for e in after_events if e.get('battle_id') in set(batch['battle_ids'])],
                finished_at=now(), verified=True)
    save(output, report)
    progress('failure_case_passed', completed=100, verified_retried_battles=len(retried), replacements=len(replacements))


def measured_trial(client, pair, replicas, trial_number, report, output):
    client.wait_idle()
    pods = client.wait_workers(replicas)
    cpu_env = {'name': 'WORKER_CPU_ITERATIONS', 'value': str(report['workload']['cpu_iterations'])}
    controls_before = controlled_pods(pods, report['original_settings'], cpu_env)
    before_identity = identities(pods)
    cpu_before = client.cpu_counters(pods)
    if len(cpu_before) != replicas:
        raise RuntimeError('Missing CPU counters')
    client.trace = f'benchmark-{replicas}-{trial_number}-' + uuid4().hex
    started_at, started = now(), time.monotonic()
    batch = client.batch(pair)
    pending_trial = report['current_trial'] = dict(replicas=replicas, trial=trial_number,
        batch_id=batch['batch_id'], expected_ids=batch['battle_ids'], request_id=client.trace, started_at=started_at)
    save(output, report)
    rows = wait_batch(client, batch)
    elapsed = time.monotonic() - started
    cpu_after = client.cpu_counters(pods)
    after_pods = client.pods()
    controls_after = controlled_pods(after_pods, report['original_settings'], cpu_env)
    if identities(after_pods) != before_identity:
        raise RuntimeError('Pod identity/container restart changed during a measured trial')
    cpu_seconds = {name: (cpu_after[name]['usage_usec'] - before['usage_usec']) / 1_000_000
                   for name, before in cpu_before.items()}
    events = [e for e in client.worker_events() if e.get('battle_id') in set(batch['battle_ids'])]
    starts = {}
    for event in events:
        if event['event'] == 'battle_processing':
            starts.setdefault(event['battle_id'], []).append(event['timestamp'])
    metrics = summarize_trial(rows, starts, elapsed, cpu_seconds)
    if metrics['pre_worker_wait_ms']['sample_count'] != 100:
        raise RuntimeError('Worker-start log coverage is incomplete; refusing an incomplete comparison')
    result = dict(**pending_trial, **metrics, cpu_counters_before=cpu_before,
                  cpu_counters_after=cpu_after, worker_events=events, rows=rows, pod_identities=before_identity)
    result.update(pod_controls_before=controls_before, pod_controls_after=controls_after)
    report['trials'].append(result)
    report['current_trial'] = None
    save(output, report)
    progress('trial_completed', replicas=replicas, trial=trial_number,
             elapsed_seconds=round(elapsed, 2), throughput=round(metrics['throughput_per_second'], 3),
             latency_p95_ms=round(metrics['latency_ms']['p95'], 2),
             cpu_cores=round(metrics['mean_worker_cpu_cores'], 3))


def run(args):
    client = LocalCluster(context=args.context, base_url=args.base_url,
                          allow_mutations=args.allow_cluster_mutations)
    report = dict(started_at=now(), source_revision=subprocess.check_output(
        ['git', 'rev-parse', 'HEAD'], text=True).strip(),
        tooling_source_sha256={name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
            for name in ('run_requirements_experiments.py', 'cluster_experiments.py', 'experiment_metrics.py')},
        workload=dict(count=100, cpu_iterations=args.cpu_iterations, concurrency_per_worker=20,
                      replicas=[1, 3, 5], repetitions=args.repetitions),
        trials=[], failure=None, current_trial=None, restored=False, verified=False)
    save(args.output, report)
    try:
        client.wait_idle()
        initial = client.snapshot_settings()
        validate_profile(initial)  # Reject an incompatible setup before any restoration writes.
        initial_pods = client.wait_workers(5)
        report['initial_pod_controls'] = controlled_pods(initial_pods, initial, initial['cpu_env'])
        report['initial_worker_cpu'] = client.runtime_cpu_iterations(initial_pods)
        validate_fault_runtime(report['initial_worker_cpu'])
        with preserve_settings(client) as original:
            report['original_settings'] = original
            validate_profile(original)
            client.wait_workers(5)
            client.cpu_counters(client.pods())  # Fail before sending load if cgroup readings are unavailable.
            pair = [client.api('/characters', dict(name='Experiment ' + suffix + ' ' + uuid4().hex[:8],
                    class_name='warrior', hp=145, attack=34, defense=22, speed=35))['id'] for suffix in ('A', 'B')]
            failure_case(client, pair, report, args.output)
            client.patch_cpu({'name': 'WORKER_CPU_ITERATIONS', 'value': str(args.cpu_iterations)})
            for replicas in (1, 3, 5):
                client.pin_replicas(replicas)
                ready = client.wait_workers(replicas)
                events = client.worker_events()
                pod_names = {p['metadata']['name'] for p in ready}
                effective = {e['worker_id'] for e in events if e['event'] == 'worker_ready' and
                             e.get('cpu_iterations') == args.cpu_iterations and e.get('concurrency') == 20}
                if not pod_names <= effective:
                    raise RuntimeError('Actual worker startup configuration does not match controlled workload')
                progress('warmup', replicas=replicas, count=20 * replicas)
                warmup = client.batch(pair, count=20 * replicas)
                wait_batch(client, warmup)
                client.wait_idle()
                for number in range(1, args.repetitions + 1):
                    measured_trial(client, pair, replicas, number, report, args.output)
            report['comparison'] = aggregate_comparison(report['trials'])
            report['verified'] = report['failure']['verified'] and len(report['trials']) == 3 * args.repetitions
    except BaseException as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        report['restored'] = client.last_restore_succeeded
        report['verified'] = report['verified'] and report['restored'] and 'error' not in report
        report['finished_at'] = now()
        save(args.output, report)
        progress('experiment_finished', verified=report['verified'], restored=report['restored'], output=str(args.output))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-cluster-mutations', action='store_true')
    parser.add_argument('--context', default='docker-desktop')
    parser.add_argument('--base-url', default='http://localhost:8081')
    parser.add_argument('--repetitions', type=int, choices=range(1, 6), default=3)
    parser.add_argument('--cpu-iterations', type=int, default=5_000_000)
    parser.add_argument('--output', type=Path, default=Path('.git/local-cluster/reliability-benchmark/evidence.json'))
    args = parser.parse_args()
    if not args.allow_cluster_mutations or args.context != 'docker-desktop':
        parser.error('Use --allow-cluster-mutations only for the local docker-desktop context')
    if not 1 <= args.cpu_iterations <= 20_000_000:
        parser.error('--cpu-iterations must be between1 and20000000')
    run(args)


if __name__ == '__main__':
    main()
