import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cluster_experiments import LocalCluster, preserve_settings, recover_attempts


def test_mutation_requires_explicit_permission_and_local_context():
    with pytest.raises(ValueError):
        LocalCluster(allow_mutations=False)
    with pytest.raises(ValueError):
        LocalCluster(context='production', allow_mutations=True)
    with pytest.raises(ValueError):
        LocalCluster(base_url='https://remote.example', allow_mutations=True)
    with pytest.raises(ValueError):
        LocalCluster(base_url='http://@localhost:8081', allow_mutations=True)


def test_invalid_starting_profile_is_rejected_without_restoration_writes(monkeypatch, tmp_path):
    import run_requirements_experiments as runner
    from types import SimpleNamespace
    class Fake:
        last_restore_succeeded = False
        restores = 0
        def wait_idle(self):
            pass
        def snapshot_settings(self):
            return {'concurrency': '1', 'replicas': 1, 'hpa': {'minReplicas': 1, 'maxReplicas': 5}}
        def restore_settings(self, snapshot):
            self.restores += 1
    fake = Fake()
    monkeypatch.setattr(runner, 'LocalCluster', lambda **kwargs: fake)
    monkeypatch.setattr(runner.subprocess, 'check_output', lambda *args, **kwargs: 'revision')
    args = SimpleNamespace(context='docker-desktop', base_url='http://localhost:8081',
        allow_cluster_mutations=True, cpu_iterations=5000000, repetitions=3, output=tmp_path / 'evidence.json')
    with pytest.raises(ValueError):
        runner.run(args)
    assert fake.restores == 0


def test_controlled_profile_rejects_resource_changes():
    from cluster_experiments import validate_profile
    profile = {'concurrency': '20', 'replicas': 5, 'hpa': {'minReplicas': 5, 'maxReplicas': 5},
        'resources': {'requests': {'cpu': '250m', 'memory': '128Mi'},
                      'limits': {'cpu': '1', 'memory': '256Mi'}}}
    validate_profile(profile)
    profile['resources']['limits']['cpu'] = '2'
    with pytest.raises(ValueError):
        validate_profile(profile)


def test_fault_runtime_requires_all_five_workers_at_ten_million_iterations():
    from run_requirements_experiments import validate_fault_runtime
    expected = {f'worker-{i}': 10000000 for i in range(5)}
    validate_fault_runtime(expected)
    expected['worker-2'] = 5000000
    with pytest.raises(ValueError):
        validate_fault_runtime(expected)
    with pytest.raises(ValueError):
        validate_fault_runtime({})


@pytest.mark.parametrize('failure', [RuntimeError, KeyboardInterrupt])
def test_original_settings_are_restored_after_failure_or_interrupt(failure):
    class Fake:
        state = {'hpa': {'minReplicas': 5, 'maxReplicas': 5}, 'cpu_env': None}
        def snapshot_settings(self):
            return copy.deepcopy(self.state)
        def restore_settings(self, snapshot):
            self.state = snapshot
    fake = Fake()
    original = copy.deepcopy(fake.state)
    with pytest.raises(failure):
        with preserve_settings(fake):
            fake.state['hpa']['minReplicas'] = 1
            fake.state['cpu_env'] = {'name': 'WORKER_CPU_ITERATIONS', 'value': '5000000'}
            raise failure('Controlled failure')
    assert fake.state == original


@pytest.mark.parametrize('labels,uid', [({'app': 'service-a'}, 'original'), ({'app': 'service-b'}, 'changed')])
def test_worker_delete_refuses_foreign_pod_or_changed_uid(monkeypatch, labels, uid):
    client = LocalCluster(allow_mutations=True)
    writes = []
    monkeypatch.setattr(client, 'kube', lambda *args: {'metadata': {
        'name': 'service-b-abcd-12345', 'uid': uid, 'labels': labels,
        'ownerReferences': [{'kind': 'ReplicaSet', 'name': 'service-b-abcd', 'controller': True}]}})
    monkeypatch.setattr(client, 'command', lambda *args: writes.append(args))
    with pytest.raises(ValueError):
        client.delete_worker('service-b-abcd-12345', 'original')
    assert writes == []


def test_worker_delete_is_scoped_to_verified_controller_without_force(monkeypatch):
    client = LocalCluster(allow_mutations=True)
    def read(*args):
        if args[1] == 'pod':
            return {'metadata': {'name': 'service-b-abcd-12345', 'uid': 'original',
                'labels': {'app': 'service-b'}, 'ownerReferences': [
                    {'kind': 'ReplicaSet', 'name': 'service-b-abcd', 'controller': True}]}}
        return {'metadata': {'ownerReferences': [{'kind': 'Deployment', 'name': 'service-b', 'controller': True}]}}
    writes = []
    monkeypatch.setattr(client, 'kube', read)
    monkeypatch.setattr(client, 'command', lambda *args: writes.append(args))
    client.delete_worker('service-b-abcd-12345', 'original')
    assert len(writes) == 1
    assert writes[0][:3] == ('delete', 'pod', 'service-b-abcd-12345')
    assert '--grace-period=5' in writes[0]
    assert '--force' not in writes[0]


def test_restore_removes_only_the_added_cpu_override_and_restores_hpa(monkeypatch):
    client = LocalCluster(allow_mutations=True)
    writes = []
    monkeypatch.setattr(client, 'command', lambda *args: writes.append(args))
    monkeypatch.setattr(client, 'wait_idle', lambda **kwargs: None)
    monkeypatch.setattr(client, 'wait_workers', lambda *args, **kwargs: [])
    client.restore_settings({'hpa': {'minReplicas': 5, 'maxReplicas': 5}, 'cpu_env': None,
                             'replicas': 5})
    patches = [json.loads(args[-1]) for args in writes if args[0] == 'patch']
    cpu = next(p for p in patches if 'template' in p['spec'])
    entries = cpu['spec']['template']['spec']['containers'][0]['env']
    assert entries == [{'name': 'WORKER_CPU_ITERATIONS', '$patch': 'delete'}]
    assert {'spec': {'minReplicas': 5, 'maxReplicas': 5}} in patches


def test_retry_evidence_requires_a_new_attempt_for_an_original_battle():
    def event(battle, attempt, status='battle_processing'):
        return {'battle_id': battle, 'attempt_id': attempt, 'event': status}
    before = [event('a', 'attempt1'), event('b', 'attempt2')]
    after = [event('a', 'attempt1'), event('a', 'attempt1'), event('b', 'attempt3'),
             event('foreign', 'attempt4'), event('a', 'attempt5', 'battle_finished')]
    assert recover_attempts(before, after, {'a', 'b'}) == ['b']


def test_ready_old_pod_is_not_mistaken_for_the_new_cpu_configuration(monkeypatch):
    client = LocalCluster(allow_mutations=True)
    def pod(cpu):
        return {'metadata': {'name': 'service-b-abcd-12345'}, 'spec': {'containers': [
            {'name': 'worker', 'image': 'worker:tested', 'env': [
                {'name': 'WORKER_CPU_ITERATIONS', 'value': cpu}]}]},
            'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
    old, updated = pod('10000000'), pod('5000000')
    reads, sleeps = [], []
    monkeypatch.setattr(client, 'kube', lambda *args: {'spec': {'template': {'spec': {
        'containers': updated['spec']['containers']}}}})
    def pods():
        reads.append(True)
        return [old] if len(reads) == 1 else [updated]
    monkeypatch.setattr(client, 'pods', pods)
    monkeypatch.setattr(client, 'consumers', lambda: [{'active': True, 'prefetch_count': 20}])
    monkeypatch.setattr('cluster_experiments.time.sleep', lambda seconds: sleeps.append(seconds))
    assert client.wait_workers(1) == [updated]
    assert sleeps == [1]
