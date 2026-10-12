import json
import unittest
from mainbrella import Mainbrella, MainbrellaError

GENERATION = '2026-10-12T14:00:00.000Z'
IDENTITY = 'ba121913-12de-4ef9-8dc2-f8f47a755410'


class NativeFileWatchTests(unittest.TestCase):
    def sandbox(self):
        self.calls = []
        def transport(url, method, headers, body, timeout):
            self.calls.append((url, method, headers, body))
            return 200, json.dumps({'id': IDENTITY}).encode()
        return Mainbrella('mb_' + 'a' * 64, transport=transport).connect('small', GENERATION)

    def test_argv_validation_and_stable_execution(self):
        sandbox = self.sandbox()
        watch = sandbox.files.watch_native('/workspace/$(touch injected)', timeout_ms=5000, idempotency_key='native-watch')
        self.assertEqual(watch.execution.id, IDENTITY)
        self.assertEqual(watch.idempotency_key, 'native-watch')
        url, method, headers, body = self.calls[0]
        self.assertIn('createdAt=2026-10-12T14%3A00%3A00.000Z', url)
        self.assertEqual(headers['Idempotency-Key'], 'native-watch')
        request = json.loads(body)
        self.assertEqual(request['argv'][:2], ['node', '-e'])
        self.assertEqual(request['argv'][-2:], ['/workspace/$(touch injected)', 'true'])
        self.assertEqual(request['timeoutMs'], 5000)
        for options in ({'recursive': 1}, {'timeout_ms': True}, {'timeout_ms': 900001}, {'idempotency_key': ''}):
            with self.assertRaisesRegex(MainbrellaError, 'invalid_file_watch_options'):
                sandbox.files.watch_native('/workspace', **options)
        self.assertEqual(len(self.calls), 1)

    def test_partial_frames_and_queued_records_survive_reconnect(self):
        watch = self.sandbox().files.watch_native('/workspace')
        connections = []
        def events():
            connections.append(True)
            if len(connections) == 1:
                yield {'type': 'stdout', 'data': '{"type":"rename","file'}
                raise MainbrellaError('execution_stream_unavailable')
            yield {'type': 'stdout', 'data': 'name":"first"}\n{"type":"change","filename":"nested/界"}\n'}
            yield {'type': 'status', 'execution': {'status': 'canceled'}}
        watch.execution.events = events
        with self.assertRaisesRegex(MainbrellaError, 'execution_stream_unavailable'):
            next(watch.events())
        second = watch.events()
        self.assertEqual(next(second), {'type': 'rename', 'filename': 'first'})
        second.close()
        third = watch.events()
        self.assertEqual(next(third), {'type': 'change', 'filename': 'nested/界'})
        third.close()

    def test_invalid_frames_and_cleanup_confirmation(self):
        watch = self.sandbox().files.watch_native('/workspace')
        for filename in ('../escape', '\ud800', '/absolute', ''):
            def events():
                yield {'type': 'stdout', 'data': json.dumps({'type': 'rename', 'filename': filename}) + '\n'}
            watch.execution.events = events
            with self.assertRaisesRegex(MainbrellaError, 'invalid_file_watch_response'):
                next(watch.events())
        watch.execution.cancel = lambda: {'status': 'running'}
        with self.assertRaisesRegex(MainbrellaError, 'file_watch_cleanup_unconfirmed'):
            watch.close()
        calls = []
        def cancel():
            calls.append(True)
            return {'status': 'canceled'}
        watch.execution.cancel = cancel
        with watch:
            pass
        self.assertEqual(watch.close(), {'closed': True})
        self.assertEqual(len(calls), 1)

    def test_failed_start_preserves_reconciliation_key(self):
        def transport(*args):
            raise OSError('lost')
        sandbox = Mainbrella('mb_' + 'a' * 64, transport=transport).connect('small', GENERATION)
        with self.assertRaises(MainbrellaError) as raised:
            sandbox.files.watch_native('/workspace', idempotency_key='native-retry')
        self.assertEqual(raised.exception.idempotency_key, 'native-retry')


if __name__ == '__main__':
    unittest.main()
