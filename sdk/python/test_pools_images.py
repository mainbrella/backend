import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest.mock import patch
from mainbrella import Mainbrella, MainbrellaError, SandboxPool


class PoolFixture:
    def __init__(self):
        self.calls = []
        self.containers = []
        self.killed = []
        self.serial = 0
        self.ambiguous = False
        self.cleanup_failure = False

    def capabilities(self):
        return {'containers': {'idempotentCreate': True, 'creationRetentionMs': 86_400_000}}

    def list(self):
        return {'containers': self.containers}

    def create(self, **options):
        self.calls.append(options)
        if self.ambiguous:
            self.ambiguous = False
            raise MainbrellaError('creation_ambiguous', idempotency_key=options['idempotency_key'])
        self.serial += 1
        sandbox = SimpleNamespace(id='c' + str(self.serial), created_at='2026-10-11T00:00:00.000Z')
        def kill():
            if self.cleanup_failure:
                self.cleanup_failure = False
                raise MainbrellaError('transport_unavailable')
            self.killed.append(sandbox.id)
            self.containers[:] = [item for item in self.containers if item['id'] != sandbox.id]
        sandbox.kill = kill
        self.containers.append({'id': sandbox.id, 'createdAt': sandbox.created_at, 'status': 'running'})
        return sandbox


class PoolTests(unittest.TestCase):
    def test_pending_retry_and_wait_budget_expire_before_server_receipts(self):
        f = PoolFixture()
        pool = SandboxPool(f, create={'wait_timeout': 172_800})
        f.ambiguous = True
        with patch('mainbrella._pool.time.time', return_value=1_000):
            with self.assertRaises(MainbrellaError):
                pool.refill()
        self.assertEqual(f.calls[0]['wait_timeout'], 3_600)
        with patch('mainbrella._pool.time.time', return_value=4_601):
            with self.assertRaises(MainbrellaError) as error:
                pool.close()
        self.assertEqual(error.exception.code, 'pool_creation_expired')
        self.assertEqual(len(f.calls), 1)

    def test_parallel_refill_and_acquire_never_duplicate_a_generation(self):
        f = PoolFixture()
        pool = SandboxPool(f, target_size=2)
        with ThreadPoolExecutor(2) as threads:
            list(threads.map(lambda _: pool.refill(), range(2)))
            acquired = list(threads.map(lambda _: pool.acquire(), range(2)))
        self.assertEqual(len(f.calls), 2)
        self.assertEqual({item.id for item in acquired}, {'c1', 'c2'})
        with self.assertRaises(MainbrellaError) as error:
            pool.acquire()
        self.assertEqual(error.exception.code, 'pool_empty')
        pool.refill()
        pool.close()
        self.assertEqual(f.killed, ['c3', 'c4'])
        self.assertEqual([item['id'] for item in f.containers], ['c1', 'c2'])

    def test_ambiguous_create_reuses_key_and_cleanup_retries_exact_generation(self):
        f = PoolFixture()
        pool = SandboxPool(f)
        f.ambiguous = True
        with self.assertRaises(MainbrellaError):
            pool.refill()
        key = pool.state['pending']['idempotency_key']
        f.cleanup_failure = True
        with self.assertRaises(MainbrellaError):
            pool.close()
        self.assertEqual([item['idempotency_key'] for item in f.calls], [key, key])
        self.assertEqual(len(pool.state['available']), 1)
        pool.close()
        self.assertEqual(f.killed, ['c1'])

    def test_stale_pool_inventory_does_not_touch_replaced_generations(self):
        f = PoolFixture()
        pool = SandboxPool(f)
        pool.refill()
        f.containers[0]['createdAt'] = '2026-10-11T01:00:00.000Z'
        with self.assertRaises(MainbrellaError):
            pool.acquire()
        pool.close()
        self.assertEqual(f.killed, [])
        self.assertEqual(len(f.containers), 1)


class ImageTests(unittest.TestCase):
    def test_multipart_build_and_owned_image_tag_helpers(self):
        image_id = 'd688d42a-25ef-4c13-9b28-21a0fde6e163'
        calls = []
        def transport(url, method, headers, body, timeout):
            path = urlsplit(url).path
            calls.append((path, method))
            if path == '/images' and method == 'POST':
                message = BytesParser(policy=default).parsebytes(
                    ('Content-Type: ' + headers['Content-Type'] + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + body)
                parts = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True)
                         for part in message.iter_parts()}
                self.assertEqual(parts, {'name': b'Tools', 'dockerfile': b'FROM mainbrella:base\nRUN echo tools',
                                         'context': b'\x1f\x8b\x00\xff'})
            if method == 'PUT':
                self.assertEqual(json.loads(body), {'imageId': image_id})
            return 200, json.dumps({'image': {'id': image_id}}).encode()
        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        self.assertIsInstance(client.pool(), SandboxPool)
        client.images.create('Tools', 'FROM mainbrella:base\nRUN echo tools', b'\x1f\x8b\x00\xff')
        client.images.list()
        client.images.get(image_id)
        client.images.logs(image_id)
        client.images.tags.set('tools.v1', image_id)
        client.images.tags.get('tools.v1')
        client.images.tags.list()
        client.images.tags.delete('tools.v1')
        client.images.delete(image_id)
        self.assertEqual([method for _, method in calls], ['POST', 'GET', 'GET', 'GET', 'PUT', 'GET', 'GET', 'DELETE', 'DELETE'])
        with self.assertRaises(MainbrellaError):
            client.images.tags.get('../other')
