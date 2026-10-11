"""Explicit client-managed prewarming of ordinary, billed sandboxes."""
import copy
import threading
import time
import uuid


class SandboxPool:
    def __init__(self, client, target_size=1, create=None):
        from . import MainbrellaError
        self._error = MainbrellaError
        create = {} if create is None else create
        if (type(target_size) is not int or not 1 <= target_size <= 10 or not isinstance(create, dict)
                or 'idempotency_key' in create or 'startup_command' in create or create.get('lifecycle') == 'production'):
            raise self._error('invalid_pool_options')
        self._client = client
        self._options = copy.deepcopy(create)
        self._target = target_size
        self._ready = []
        self._pending = None
        self._closed = False
        self._lock = threading.RLock()

    @property
    def state(self):
        with self._lock:
            return {'closed': self._closed, 'target_size': self._target,
                    'available': [{'id': item.id, 'created_at': item.created_at} for item in self._ready],
                    'pending': copy.deepcopy(self._pending)}

    def _refresh(self):
        if not self._ready:
            return
        containers = self._client.list().get('containers')
        if not isinstance(containers, list):
            raise self._error('invalid_response')
        for sandbox in list(self._ready):
            current = next((item for item in containers if item.get('id') == sandbox.id
                            and item.get('createdAt') == sandbox.created_at), None)
            if current and current.get('status') == 'running':
                continue
            if current:
                sandbox.kill()
            self._ready.remove(sandbox)

    def _create(self):
        if self._pending is None:
            caps = self._client.capabilities().get('containers', {})
            retention = caps.get('creationRetentionMs')
            if (caps.get('idempotentCreate') is not True or type(retention) not in (int, float)
                    or not 60_000 <= retention < float('inf')):
                raise self._error('pool_unavailable')
            self._pending = {'idempotency_key': str(uuid.uuid4()),
                             'retry_before': time.time() + min(retention / 2000, 3600)}
        if time.time() >= self._pending['retry_before']:
            raise self._error('pool_creation_expired', idempotency_key=self._pending['idempotency_key'])
        options = dict(self._options)
        options['wait_timeout'] = min(options.get('wait_timeout', 120), max(0.001, self._pending['retry_before'] - time.time()))
        sandbox = self._client.create(**options, idempotency_key=self._pending['idempotency_key'])
        self._ready.append(sandbox)
        self._pending = None

    def refill(self):
        with self._lock:
            if self._closed:
                raise self._error('pool_closed')
            self._refresh()
            while len(self._ready) < self._target:
                self._create()
            return self.state

    def acquire(self):
        with self._lock:
            if self._closed:
                raise self._error('pool_closed')
            self._refresh()
            if not self._ready:
                raise self._error('pool_empty')
            return self._ready.pop(0)

    def close(self):
        with self._lock:
            self._closed = True
            pending_error = None
            try:
                if self._pending is not None:
                    self._create()
            except Exception as error:
                pending_error = error
            self._refresh()
            while self._ready:
                self._ready[0].kill()
                self._ready.pop(0)
            if pending_error:
                raise pending_error
            return self.state
