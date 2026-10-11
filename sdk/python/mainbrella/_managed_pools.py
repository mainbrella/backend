"""Durable server inventory. Local SandboxPool remains an explicit-refill helper."""
import re
import uuid


class ManagedPools:
    def __init__(self, client):
        from . import MainbrellaError
        self._error = MainbrellaError
        self._client = client

    def _path(self, pool_id):
        if not isinstance(pool_id, str) or not re.fullmatch(r'pool_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', pool_id):
            raise self._error('invalid_pool_identity')
        return '/pools/' + pool_id

    def _keyed(self, path, body, key):
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
            raise self._error('invalid_pool_options')
        try:
            return self._client.request(path, 'POST', body, {'Idempotency-Key': key})
        except self._error as error:
            error.idempotency_key = key
            raise

    def list(self):
        return self._client.request('/pools')

    def get(self, pool_id):
        return self._client.request(self._path(pool_id))

    def create(self, name, target_size, ttl_seconds, *, size=None, catalog_id=None, image_id=None,
               internet=None, network_policy=None, secret_bindings=None, idempotency_key=None):
        body = {'name': name, 'targetSize': target_size, 'ttlSeconds': ttl_seconds}
        for field, value in (('size', size), ('catalogId', catalog_id), ('imageId', image_id), ('internet', internet),
                             ('networkPolicy', network_policy), ('secretBindings', secret_bindings)):
            if value is not None:
                body[field] = value
        return self._keyed('/pools', body, str(uuid.uuid4()) if idempotency_key is None else idempotency_key)

    def update(self, pool_id, *, name=None, target_size=None):
        body = {}
        if name is not None:
            body['name'] = name
        if target_size is not None:
            body['targetSize'] = target_size
        return self._client.request(self._path(pool_id), 'PATCH', body)

    def delete(self, pool_id):
        return self._client.request(self._path(pool_id), 'DELETE')

    def acquire(self, pool_id, *, idempotency_key=None):
        path = self._path(pool_id)
        key = str(uuid.uuid4()) if idempotency_key is None else idempotency_key
        try:
            result = self._keyed(path + '/acquire', {}, key)
            container = result.get('container') if isinstance(result, dict) else None
            if not isinstance(result, dict) or result.get('poolId') != pool_id or not isinstance(container, dict) or container.get('status') != 'running':
                raise self._error('invalid_pool_response')
            sandbox = self._client.connect(container.get('id'), container.get('createdAt'))
            for attribute, field in (('image_digest', 'imageDigest'), ('instance', 'instance'), ('internet', 'internet'),
                                     ('network_policy', 'networkPolicy'), ('secret_bindings', 'secretBindings')):
                setattr(sandbox, attribute, container.get(field))
            return sandbox
        except self._error as error:
            error.idempotency_key = key
            raise
