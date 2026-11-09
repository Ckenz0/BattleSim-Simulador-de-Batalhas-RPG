"""Local-cluster diagnostics and narrowly scoped, restorable experiment operations."""
import copy
import json
import re
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from uuid import uuid4


class LocalCluster:
    def __init__(self, *, context='docker-desktop', base_url='http://localhost:8081', allow_mutations=False):
        if not allow_mutations or context != 'docker-desktop':
            raise ValueError('Explicit --allow-cluster-mutations and context docker-desktop are required')
        url = urlsplit(base_url)
        if (url.scheme not in ('http', 'https') or url.hostname not in ('localhost', '127.0.0.1', '::1') or
                url.username is not None or url.password is not None or url.path not in ('', '/') or url.query or url.fragment):
            raise ValueError('The experiment HTTP target must be a loopback base URL without credentials')
        self.context, self.base_url = context, base_url.rstrip('/')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.trace = 'experiments-' + uuid4().hex
        self.last_restore_succeeded = False

    def command(self, *args):
        return subprocess.check_output(['kubectl', '--context', self.context, '-n', 'battlesim',
                                        *args], text=True, timeout=40, stderr=subprocess.PIPE)

    def kube(self, *args):
        return json.loads(self.command(*args, '-o', 'json'))

    def api(self, path, payload=None):
        request = urllib.request.Request(self.base_url + '/api' + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={'Content-Type': 'application/json', 'X-Request-ID': self.trace})
        # No retry: a timed-out POST might already have been accepted.
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)

    def broker(self, command, fields):
        return json.loads(self.command('exec', 'rabbitmq-0', '--', 'rabbitmqctl', '-q', command,
                                       *fields, '--formatter', 'json'))

    def request_queue(self):
        return next(row for row in self.broker('list_queues', ['name', 'messages_ready',
            'messages_unacknowledged', 'consumers']) if row['name'] == 'battles.requests.v1')

    def consumers(self):
        return [row for row in self.broker('list_consumers', ['queue_name', 'prefetch_count', 'active'])
                if row['queue_name'] == 'battles.requests.v1']

    def pods(self):
        return self.kube('get', 'pods', '-l', 'app=service-b')['items']

    def snapshot_settings(self):
        deployment = self.kube('get', 'deployment', 'service-b')
        worker = next(c for c in deployment['spec']['template']['spec']['containers'] if c['name'] == 'worker')
        hpa = self.kube('get', 'hpa', 'service-b')
        return dict(hpa={key: hpa['spec'][key] for key in ('minReplicas', 'maxReplicas')},
                    cpu_env=copy.deepcopy(next((e for e in worker.get('env', [])
                        if e['name'] == 'WORKER_CPU_ITERATIONS'), None)),
                    replicas=deployment['spec']['replicas'], worker_image=worker['image'],
                    resources=worker['resources'], concurrency=next((e.get('value') for e in worker.get('env', [])
                        if e['name'] == 'WORKER_CONCURRENCY'), None))

    def patch_cpu(self, entry):
        patch = {'spec': {'template': {'spec': {'containers': [{'name': 'worker', 'env': [entry]}]}}}}
        self.command('patch', 'deployment', 'service-b', '--type=strategic', '-p', json.dumps(patch))

    def pin_replicas(self, replicas):
        if type(replicas) is not int or replicas not in (1, 3, 5):
            raise ValueError('Only the controlled 1/3/5 worker cases are supported')
        self.command('patch', 'hpa', 'service-b', '--type=merge', '-p',
                     json.dumps({'spec': {'minReplicas': replicas, 'maxReplicas': replicas}}))

    def wait_workers(self, replicas, *, timeout=180):
        deadline = time.monotonic() + timeout
        deployment = self.kube('get', 'deployment', 'service-b')
        template = next(c for c in deployment['spec']['template']['spec']['containers'] if c['name'] == 'worker')
        expected_cpu = next((e for e in template.get('env', []) if e['name'] == 'WORKER_CPU_ITERATIONS'), None)
        def current_revision(pod):
            container = next(c for c in pod['spec']['containers'] if c['name'] == 'worker')
            actual_cpu = next((e for e in container.get('env', []) if e['name'] == 'WORKER_CPU_ITERATIONS'), None)
            return container['image'] == template['image'] and actual_cpu == expected_cpu
        while time.monotonic() < deadline:
            pods = self.pods()
            ready = [p for p in pods if not p['metadata'].get('deletionTimestamp') and
                     any(c['type'] == 'Ready' and c['status'] == 'True' for c in p.get('status', {}).get('conditions', []))]
            if len(pods) == len(ready) == replicas and all(current_revision(p) for p in ready):
                consumers = self.consumers()
                if len(consumers) == replicas and all(c['active'] and c['prefetch_count'] == 20 for c in consumers):
                    return ready
            time.sleep(1)
        raise TimeoutError(f'{replicas} ready workers with prefetch20 were not observed')

    def wait_idle(self, *, timeout=240):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            stats, queue = self.api('/stats'), self.request_queue()
            if all(stats[key] == 0 for key in ('pending', 'processing', 'unpublished')) and \
                    queue['messages_ready'] == queue['messages_unacknowledged'] == 0:
                return
            time.sleep(1)
        raise TimeoutError('The queue/outbox did not drain; no new batch may be submitted')

    def restore_settings(self, snapshot):
        errors = []
        try:
            self.wait_idle(timeout=240)
        except Exception as exc:
            errors.append(str(exc))
        entry = snapshot['cpu_env'] or {'name': 'WORKER_CPU_ITERATIONS', '$patch': 'delete'}
        for action in (lambda: self.patch_cpu(entry), lambda: self.command('patch', 'hpa', 'service-b',
                '--type=merge', '-p', json.dumps({'spec': snapshot['hpa']}))):
            try:
                action()
            except Exception as exc:
                errors.append(str(exc))
        if not errors:
            self.wait_workers(snapshot['replicas'], timeout=180)
        else:
            raise RuntimeError('Restoration needs inspection: ' + '; '.join(errors))

    def delete_worker(self, name, expected_uid):
        pod = self.kube('get', 'pod', name)
        meta = pod['metadata']
        if (not re.fullmatch(r'service-b-[a-z0-9]+-[a-z0-9]+', name) or
                meta.get('uid') != expected_uid or meta.get('labels', {}).get('app') != 'service-b' or
                meta.get('deletionTimestamp')):
            raise ValueError('Only the identified current worker Pod may be removed')
        owners = [o for o in meta.get('ownerReferences', []) if o.get('controller') and o['kind'] == 'ReplicaSet']
        if len(owners) != 1:
            raise ValueError('Worker ReplicaSet owner missing')
        replica_set = self.kube('get', 'replicaset', owners[0]['name'])
        if not any(o.get('controller') and o['kind'] == 'Deployment' and o['name'] == 'service-b'
                   for o in replica_set['metadata'].get('ownerReferences', [])):
            raise ValueError('Pod is not owned by the service-b Deployment')
        self.command('delete', 'pod', name, '--grace-period=5', '--wait=false')

    def batch(self, pair, count=100):
        result = self.api('/battles/batch', dict(character_a_id=pair[0], character_b_id=pair[1], count=count))
        if result['count'] != count or len(set(result['battle_ids'])) != count:
            raise RuntimeError('Accepted batch does not match requested count')
        return result

    def records(self, batch_id):
        return self.api('/battles?limit=100&batch_id=' + batch_id)['items']

    def worker_events(self, pod=None):
        target = [pod] if pod else ['-l', 'app=service-b', '--max-log-requests=6']
        output = self.command('logs', *target, '--tail=2000')
        events = []
        for line in output.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('event') in ('worker_ready', 'battle_processing', 'battle_finished', 'shutdown_timeout'):
                events.append(event)
        return events

    def cpu_counters(self, pods):
        def read(pod):
            name = pod['metadata']['name']
            raw = self.command('exec', name, '--', 'cat', '/sys/fs/cgroup/cpu.stat')
            data = {key: int(value) for key, value in (line.split() for line in raw.splitlines())}
            return name, data
        with ThreadPoolExecutor(max_workers=5) as pool:
            return dict(pool.map(read, pods))

    def runtime_cpu_iterations(self, pods):
        def read(pod):
            name = pod['metadata']['name']
            # Query only the non-secret CPU setting inside each existing worker.
            value = self.command('exec', name, '--', 'python', '-c',
                                 "import os; print(os.environ['WORKER_CPU_ITERATIONS'])")
            return name, int(value.strip())
        with ThreadPoolExecutor(max_workers=5) as pool:
            return dict(pool.map(read, pods))


@contextmanager
def preserve_settings(client):
    snapshot = client.snapshot_settings()
    try:
        yield snapshot
    finally:
        client.restore_settings(snapshot)
        client.last_restore_succeeded = True


def recover_attempts(before, after, battle_ids):
    def attempts(events):
        result = {}
        for event in events:
            if event.get('event') == 'battle_processing' and event.get('battle_id') in battle_ids:
                result.setdefault(event['battle_id'], set()).add(event['attempt_id'])
        return result
    old, new = attempts(before), attempts(after)
    return sorted(bid for bid in old if new.get(bid, set()) - old[bid])


def validate_profile(settings):
    if (settings.get('concurrency') != '20' or settings.get('replicas') != 5 or
            settings.get('hpa') != {'minReplicas': 5, 'maxReplicas': 5}):
        raise ValueError('Start from the warm docker-desktop-concurrent100 profile (5x20)')
    resources = settings.get('resources', {})
    for section, expected in (('requests', {'cpu': '250m', 'memory': '128Mi'}),
                              ('limits', {'cpu': '1', 'memory': '256Mi'})):
        if any(resources.get(section, {}).get(key) != value for key, value in expected.items()):
            raise ValueError('Controlled runs require CPU250m/1 and memory128Mi/256Mi per worker')
