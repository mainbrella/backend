import json
import unittest
from mainbrella import Mainbrella, MainbrellaError
from mainbrella._network_policy import normalize_network_policy

CREATED = '2026-10-11T00:00:00.000Z'
SECRET = 'sec_d688d42a-25ef-4c13-9b28-21a0fde6e163'


def reply(policy, created_at=CREATED):
    return {'creation': {'id': 'receipt', 'containerId': 'small', 'createdAt': created_at, 'status': 'running'},
            'containers': [{'id': 'small', 'createdAt': created_at, 'status': 'running', 'internet': False,
                            'networkPolicy': policy, 'secretBindings': [SECRET]}]}


class NetworkPolicyTests(unittest.TestCase):
    def test_domain_and_cidr_canonicalization(self):
        self.assertEqual(normalize_network_policy({'allow': ['API.Example.COM', 'api.example.com', '8.8.8.42/24', '2606:4700:4700::1111/32']}),
                         {'allow': ['2606:4700:0:0:0:0:0:0/32', '8.8.8.0/24', 'api.example.com'], 'deny': []})
        self.assertEqual(normalize_network_policy({'allow': ['[2606:4700::1]', '::ffff:8.8.8.8/120']}),
                         {'allow': ['0:0:0:0:0:ffff:808:800/120', '2606:4700:0:0:0:0:0:1/128'], 'deny': []})
        for invalid in ({'allow': ['8.8.8.8/33']}, {'allow': ['host.local']}, {'allow': ['fe80::1%zone']}, {'allow': ['api.example.com'], 'extra': True}):
            self.assertIsNone(normalize_network_policy(invalid))

    def test_broader_policy_and_missing_deny_are_rejected(self):
        for returned in ({'allow': ['*'], 'deny': ['private.example.com']}, {'allow': ['*.example.com'], 'deny': []}):
            def transport(url, method, headers, body, timeout):
                value = {'networking': {'egressPolicies': True}} if url.endswith('/capabilities') else reply(returned)
                return 200, json.dumps(value).encode()
            client = Mainbrella('mb_' + 'a' * 64, transport=transport)
            with self.assertRaises(MainbrellaError) as caught:
                client.create(network_policy={'allow': ['*.example.com'], 'deny': ['private.example.com']}, idempotency_key='same-policy')
            self.assertEqual(caught.exception.code, 'network_policy_unconfirmed')
            self.assertEqual(caught.exception.idempotency_key, 'same-policy')

    def test_creation_snapshots_before_discovery_and_retains_retry_body(self):
        policy = {'allow': ['8.8.8.42/24', 'API.Example.COM'], 'deny': ['private.example.com']}
        bindings, posts = [SECRET], []
        canonical = normalize_network_policy(policy)
        def transport(url, method, headers, body, timeout):
            if url.endswith('/capabilities'):
                policy['allow'][:] = ['*']
                policy['deny'].clear()
                bindings.clear()
                return 200, b'{"networking":{"egressPolicies":true},"secrets":{"vault":true}}'
            posts.append((json.loads(body), headers['Idempotency-Key']))
            if len(posts) == 1:
                return 503, b'{"error":"containers_unavailable"}'
            return 200, json.dumps(reply(canonical)).encode()
        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        sandbox = client.create(network_policy=policy, secret_bindings=bindings, idempotency_key='stable-request', poll_interval=0.001)
        self.assertEqual(posts[0], posts[1])
        self.assertEqual(posts[0][0]['networkPolicy'], canonical)
        self.assertEqual(posts[0][0]['secretBindings'], [SECRET])
        self.assertEqual(sandbox.network_policy, canonical)

    def test_resume_rejects_a_broader_policy(self):
        def transport(url, method, headers, body, timeout):
            value = {'persistence': {'filesystemAfterStop': True}} if url.endswith('/capabilities') else reply({'allow': ['*'], 'deny': []}, '2026-10-11T00:01:00.000Z')
            return 200, json.dumps(value).encode()
        client = Mainbrella('mb_' + 'a' * 64, transport=transport)
        source = client.connect('small', CREATED)
        source.internet, source.network_policy = False, {'allow': ['api.example.com'], 'deny': []}
        with self.assertRaises(MainbrellaError) as caught:
            source.resume(idempotency_key='safe-resume')
        self.assertEqual(caught.exception.code, 'network_policy_unconfirmed')


if __name__ == '__main__':
    unittest.main()
