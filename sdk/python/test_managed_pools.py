import json
import unittest
from mainbrella import Mainbrella, MainbrellaError

POOL = 'pool_a12d8bf6-12dc-4f4b-9aa1-7a1f174683a4'
GENERATION = '2026-10-11T08:00:00.000Z'


class ManagedPoolTests(unittest.TestCase):
    def test_durable_pool_retries_preserve_keys_and_generation_policy(self):
        calls = []
        unavailable = True

        def transport(url, method, headers, body, timeout):
            nonlocal unavailable
            calls.append((url, method, headers.get('Idempotency-Key'), json.loads(body) if body else None))
            if unavailable:
                unavailable = False
                raise RuntimeError('private transport details')
            if url.endswith('/acquire'):
                result = {'poolId': POOL, 'container': {'id': 'c1', 'createdAt': GENERATION, 'status': 'running',
                          'internet': False, 'networkPolicy': {'allow': ['example.com']}, 'secretBindings': ['sec-owned']}}
            else:
                result = {'pool': {'id': POOL}}
            return 200, json.dumps(result).encode()

        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        for attempt in range(2):
            try:
                client.pools.create('Workers', 2, 600, catalog_id='node', idempotency_key='pool-request')
            except MainbrellaError as error:
                self.assertEqual(attempt, 0)
                self.assertEqual(error.idempotency_key, 'pool-request')
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(calls[1][3], {'name': 'Workers', 'targetSize': 2, 'ttlSeconds': 600, 'catalogId': 'node'})
        unavailable = True
        with self.assertRaises(MainbrellaError) as failure:
            client.pools.acquire(POOL, idempotency_key='claim-request')
        self.assertEqual(failure.exception.idempotency_key, 'claim-request')
        sandbox = client.pools.acquire(POOL, idempotency_key='claim-request')
        self.assertEqual(calls[2], calls[3])
        self.assertEqual((sandbox.id, sandbox.created_at, sandbox.internet), ('c1', GENERATION, False))
        self.assertEqual(sandbox.network_policy, {'allow': ['example.com']})
        self.assertEqual(sandbox.secret_bindings, ['sec-owned'])
        client.pools.list()
        client.pools.get(POOL)
        client.pools.update(POOL, target_size=0)
        client.pools.delete(POOL)
        self.assertEqual([call[1] for call in calls[4:]], ['GET', 'GET', 'PATCH', 'DELETE'])
        with self.assertRaises(MainbrellaError):
            client.pools.get('../secrets')

    def test_unconfirmed_acquisition_preserves_retry_key(self):
        for response in (None, {}, {'poolId': POOL, 'container': {'id': 'c1', 'createdAt': GENERATION, 'status': 'starting'}},
                         {'poolId': 'other', 'container': {'id': 'c1', 'createdAt': GENERATION, 'status': 'running'}},
                         {'poolId': POOL, 'container': {'id': 'c1', 'createdAt': 'invalid', 'status': 'running'}}):
            client = Mainbrella('mb_' + 'a' * 64, transport=lambda *args: (200, json.dumps(response).encode()))
            with self.assertRaises(MainbrellaError) as failure:
                client.pools.acquire(POOL, idempotency_key='same-claim')
            self.assertEqual(failure.exception.idempotency_key, 'same-claim')
