"""Send one real batch and record broker evidence; requires the warm local 100 profile.

Uses only the public HTTP API and read-only kubectl diagnostics. It never scales,
deletes resources, reads Secrets, or retries a possibly accepted POST.
"""
import argparse
import json
import subprocess
import time
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://localhost:8081')
    parser.add_argument('--context', default='docker-desktop')
    parser.add_argument('--output', type=Path, default=Path('.git/local-cluster/concurrent100-evidence.json'))
    args = parser.parse_args()
    trace = 'concurrent100-' + uuid4().hex
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(path, payload=None):
        request = urllib.request.Request(args.base_url.rstrip('/') + '/api' + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={'Content-Type': 'application/json', 'X-Request-ID': trace})
        with opener.open(request, timeout=30) as response:
            return response.status, json.load(response)

    def broker(command, fields):
        output = subprocess.check_output(['kubectl', '--context', args.context, '-n', 'battlesim',
            'exec', 'rabbitmq-0', '--', 'rabbitmqctl', '-q', command, *fields,
            '--formatter', 'json'], text=True, timeout=20)
        return json.loads(output)

    def queue():
        return next(row for row in broker('list_queues', ['name', 'messages_ready',
            'messages_unacknowledged', 'consumers']) if row['name'] == 'battles.requests.v1')

    initial = queue()
    consumers = [row for row in broker('list_consumers', ['queue_name', 'prefetch_count', 'active'])
                 if row['queue_name'] == 'battles.requests.v1']
    if initial['messages_ready'] or initial['messages_unacknowledged']:
        raise SystemExit('Aguarde a fila ficar vazia antes deste ensaio; nada foi enviado.')
    if len(consumers) != 5 or any(not row['active'] or row['prefetch_count'] != 20 for row in consumers):
        raise SystemExit('O ensaio exige cinco consumidores ativos com prefetch20; nada foi enviado.')
    _, health = api('/health/ready')
    if not health['broker_connected']:
        raise SystemExit('API sem conexao ao broker; nada foi enviado.')
    participants = [api('/characters', dict(name=trace + '-' + suffix, class_name='warrior',
        hp=145, attack=34, defense=22, speed=35))[1] for suffix in ('A', 'B')]
    started = time.monotonic()
    status, batch = api('/battles/batch', dict(count=100, character_a_id=participants[0]['id'],
                                            character_b_id=participants[1]['id']))
    if status != 202 or batch['count'] != 100:
        raise RuntimeError('Batch acceptance did not match the requested100')
    samples = []
    report = dict(request_id=trace, batch_id=batch['batch_id'], submitted=100,
                  http_status=status, initial_consumers=consumers, samples=samples)
    rows = []
    while time.monotonic() - started < 180:
        snapshot = queue()
        _, page = api('/battles?limit=100&batch_id=' + batch['batch_id'])
        rows = page['items']
        counts = Counter(row['status'] for row in rows)
        sample = dict(timestamp=datetime.now(timezone.utc).isoformat(),
                      elapsed_seconds=round(time.monotonic() - started, 2),
                      broker=snapshot, reported_statuses=dict(counts))
        samples.append(sample)
        report['peak_unacknowledged'] = max(s['broker']['messages_unacknowledged'] for s in samples)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(sample), flush=True)
        if len(rows) == 100 and counts['completed'] + counts['failed'] == 100:
            break
        time.sleep(.25)
    counts = Counter(row['status'] for row in rows)
    report.update(completed=counts['completed'], failed=counts['failed'],
                  elapsed_seconds=round(time.monotonic() - started, 2),
                  workers=dict(Counter(row['worker_id'] for row in rows if row['status'] == 'completed')))
    report['verified'] = (len(rows) == 100 and counts['completed'] == 100 and
                          counts['failed'] == 0 and len(report['workers']) == 5 and
                          any(s['broker']['messages_unacknowledged'] == 100 and
                              s['broker']['messages_ready'] == 0 and s['broker']['consumers'] == 5
                              for s in samples))
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'samples'}, indent=2))
    if not report['verified']:
        raise SystemExit('O pico100 e a conclusao por cinco workers nao foram ambos comprovados; confira a evidencia.')


if __name__ == '__main__':
    main()
