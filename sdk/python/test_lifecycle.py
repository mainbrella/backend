import json
import unittest
import time
from mainbrella import Mainbrella, MainbrellaError

CREATED = '2026-10-11T00:00:00.000Z'
RESUMED = '2026-10-11T00:01:00.000Z'
SECRET = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163'


class LifecycleTests(unittest.TestCase):
    def test_configure_and_wait_for_exact_generation_readiness(self):
        calls = []
        state = {'status': 'starting', 'polls': 0, 'generation': CREATED}
        recipe = {'command': 'node server.mjs', 'cwd': '/workspace', 'readiness': {'port': 3000, 'path': '/', 'timeoutMs': 30000}}

        def transport(url, method, headers, body, timeout):
            payload = json.loads(body) if body else None
            calls.append((method, payload))
            if url.endswith('/capabilities'):
                result = {'persistence': {'startupConfiguration': True}}
            elif method == 'PATCH':
                result = payload
            else:
                state['polls'] += 1
                if state['status'] == 'starting' and state['polls'] > 1:
                    state['status'] = 'ready'
                readiness = {'status': state['status'], 'error': 'launch_exited', 'logTail': 'module missing'} if state['status'] != 'none' else None
                result = {'containers': [{'id': 'small', 'createdAt': state['generation'], 'status': 'running', 'readiness': readiness}]}
            return 200, json.dumps(result).encode()

        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        sandbox = client.connect('small', CREATED)
        sandbox.configure_startup(recipe)
        self.assertEqual(sandbox.launch, recipe)
        self.assertEqual(calls[-1], ('PATCH', {'id': 'small', 'createdAt': CREATED, 'launch': recipe}))
        sandbox.configure_startup(None)
        self.assertIsNone(sandbox.launch)
        self.assertEqual(sandbox.wait_until_ready(poll_interval=0.001)['status'], 'ready')
        self.assertEqual(state['polls'], 2)
        for status, generation, code in [('failed', CREATED, 'launch_exited'), ('none', CREATED, 'readiness_unavailable'), ('ready', RESUMED, 'container_not_running')]:
            state.update(status=status, generation=generation)
            with self.assertRaises(MainbrellaError) as error:
                sandbox.wait_until_ready()
            self.assertEqual(error.exception.code, code)
        self.assertTrue(all(method in ('GET', 'PATCH') for method, _ in calls))
        with self.assertRaises(MainbrellaError) as error:
            sandbox.wait_until_ready(wait_timeout=float('nan'))
        self.assertEqual(error.exception.code, 'invalid_readiness_options')

    def test_older_deployment_rejects_startup_and_wait_timeout_never_relaunches(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append(method)
            result = {'persistence': {'restoreLaunch': True}} if url.endswith('/capabilities') else {'containers': [{'id': 'small', 'createdAt': CREATED, 'status': 'running', 'readiness': {'status': 'starting'}}]}
            return 200, json.dumps(result).encode()
        sandbox = Mainbrella('mb_' + 'a' * 64, transport=transport).connect('small', CREATED)
        with self.assertRaises(MainbrellaError) as error:
            sandbox.configure_startup(None)
        self.assertEqual(error.exception.code, 'workspace_launch_unavailable')
        with self.assertRaises(MainbrellaError) as error:
            sandbox.wait_until_ready(wait_timeout=0.005, poll_interval=0.001)
        self.assertEqual(error.exception.code, 'readiness_wait_timeout')
        self.assertTrue(all(method == 'GET' for method in calls))

    def test_readiness_deadline_bounds_inflight_poll_and_retains_diagnostics(self):
        calls = []
        readiness = {'status': 'starting', 'logPath': '/tmp/startup.log'}
        def transport(url, method, headers, body, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                return 200, json.dumps({'containers': [{'id': 'small', 'createdAt': CREATED, 'status': 'running', 'readiness': readiness}]}).encode()
            time.sleep(timeout + 0.005)
            raise TimeoutError('deadline')
        sandbox = Mainbrella('mb_' + 'a' * 64, transport=transport).connect('small', CREATED)
        with self.assertRaises(MainbrellaError) as error:
            sandbox.wait_until_ready(wait_timeout=0.015, poll_interval=0.001)
        self.assertEqual(error.exception.code, 'readiness_wait_timeout')
        self.assertEqual(error.exception.readiness, readiness)
        def offline(*args):
            raise OSError('offline')
        sandbox = Mainbrella('mb_' + 'a' * 64, transport=offline).connect('small', CREATED)
        with self.assertRaises(MainbrellaError) as error:
            sandbox.wait_until_ready(wait_timeout=1)
        self.assertEqual(error.exception.code, 'transport_unavailable')

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
