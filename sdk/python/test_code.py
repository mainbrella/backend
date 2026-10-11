import json
import unittest
from urllib.parse import parse_qs, urlsplit
from mainbrella import Mainbrella, MainbrellaError, CodeContext


class CodeTests(unittest.TestCase):
    def test_contexts_preserve_identity_and_do_not_replay_ambiguous_code(self):
        calls = []
        context_id = 'd688d42a-25ef-4c13-9b28-21a0fde6e163'
        created_at = '2026-10-11T00:00:00.000Z'

        def transport(url, method, headers, body, timeout):
            payload = json.loads(body) if body else None
            calls.append((urlsplit(url), method, payload))
            if urlsplit(url).path.endswith('/execute'):
                if payload['code'] == 'uncertain()':
                    raise OSError('disconnected')
                return 200, b'{"results":[{"mimeType":"application/json","data":"42"}],"error":null}'
            return 200, json.dumps({'id': context_id, 'expiresAt': 123}).encode()

        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        sandbox = client.connect('small', created_at)
        with sandbox.code.create() as context:
            self.assertIsInstance(context, CodeContext)
            self.assertEqual(context.expires_at, 123)
            self.assertEqual(context.run('41 + 1', timeout_ms=1000)['results'][0]['data'], '42')
            with self.assertRaises(MainbrellaError):
                context.run('uncertain()')
        self.assertEqual(len([call for call in calls if call[2] and call[2].get('code') == 'uncertain()']), 1)
        self.assertTrue(all(parse_qs(call[0].query) == {'id': ['small'], 'createdAt': [created_at]} for call in calls))
        self.assertEqual(calls[-1][1], 'DELETE')
        with self.assertRaises(MainbrellaError):
            sandbox.code.attach('../containers')


if __name__ == '__main__':
    unittest.main()
