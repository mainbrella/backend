import json
import unittest
from mainbrella import Mainbrella, MainbrellaError

CREATED = '2026-10-11T00:00:00.000Z'
RESUMED = '2026-10-11T00:01:00.000Z'
SECRET = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163'


class LifecycleTests(unittest.TestCase):
    def test_stop_resume_fork_keep_exact_identity_and_retry_key(self):
        calls = []
        attempts = []

        def transport(url, method, headers, body, timeout):
            path = url.split('.com')[1]
            payload = json.loads(body) if body else None
            calls.append((path, method, headers.get('Idempotency-Key'), payload))
            if path == '/capabilities':
                result = {'persistence': {'filesystemAfterStop': True, 'filesystemFork': True}}
            elif path == '/containers/stop':
                result = {'containers': [dict(payload, status='stopped', workspaceId='saved')]}
            else:
                if path == '/containers/fork':
                    attempts.append(calls[-1])
                    if len(attempts) == 1:
                        raise OSError('lost response')
                container_id = 'c1' if path.endswith('/fork') else 'small'
                result = {'creation': {'id': 'receipt', 'containerId': container_id, 'createdAt': RESUMED, 'status': 'running'},
                          'containers': [{'id': container_id, 'createdAt': RESUMED, 'status': 'running'}]}
            return 200, json.dumps(result).encode()

        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        source = client.connect('small', CREATED)
        source.stop(idempotency_key='stop-1')
        resumed = source.resume(idempotency_key='resume-1')
        self.assertEqual(resumed.created_at, RESUMED)
        self.assertEqual(source.created_at, CREATED)
        fork = resumed.fork(name='Experiment', idempotency_key='fork-1', poll_interval=0.001)
        self.assertEqual(fork.id, 'c1')
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(attempts[0][3], {'id': 'small', 'createdAt': RESUMED, 'name': 'Experiment'})

    def test_unavailable_stop_never_deletes_and_retains_key(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append(url)
            return 200, b'{"persistence":{}}'
        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        with self.assertRaises(MainbrellaError) as error:
            client.connect('small', CREATED).stop(idempotency_key='safe-stop')
        self.assertEqual(error.exception.code, 'persistence_unavailable')
        self.assertEqual(error.exception.idempotency_key, 'safe-stop')
        self.assertEqual(len(calls), 1)

    def test_secret_rotation_sends_value_only_in_body(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append((url, method, json.loads(body) if body else None))
            return 200, b'{}'
        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        client.secrets.rotate(SECRET, 'private')
        client.secrets.delete(SECRET)
        self.assertNotIn('private', calls[0][0])
        self.assertEqual(calls[0][2], {'value': 'private'})
        self.assertIsNone(calls[1][2])
        with self.assertRaises(MainbrellaError):
            client.secrets.delete('../containers')


if __name__ == '__main__':
    unittest.main()
