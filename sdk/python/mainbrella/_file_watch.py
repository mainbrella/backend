"""Native Linux notifications through a bounded, generation-scoped execution."""
import json
import re
import uuid
from collections import deque
from ._watch_guest import NATIVE_WATCH_GUEST


def _error(code):
    from . import MainbrellaError
    return MainbrellaError(code)


def watch_native(sandbox, path, recursive=True, timeout_ms=900000, idempotency_key=None):
    key = str(uuid.uuid4()) if idempotency_key is None else idempotency_key
    try:
        valid_path = len(path.encode('utf-8')) <= 4096
    except UnicodeError:
        valid_path = False
    if (type(recursive) is not bool or type(timeout_ms) is not int or not 1 <= timeout_ms <= 900000
            or not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key) or not valid_path):
        raise _error('invalid_file_watch_options')
    execution = sandbox.commands.start(['node', '-e', NATIVE_WATCH_GUEST, path, str(recursive).lower()],
                                       timeout_ms=timeout_ms, idempotency_key=key)
    return NativeFileWatch(execution, path, recursive, key)


class NativeFileWatch:
    def __init__(self, execution, path, recursive, key):
        self.execution, self.idempotency_key = execution, key
        self._path, self._recursive = path, recursive
        self._pending, self._queued = '', deque()
        self._reading, self._closed = False, False

    def events(self):
        if self._reading:
            raise _error('file_watch_already_reading')
        if self._closed:
            return
        self._reading = True
        stream = None
        try:
            while self._queued:
                yield self._queued.popleft()
            stream = self.execution.events()
            for item in stream:
                if item['type'] == 'stderr':
                    raise _error('file_watch_unavailable')
                if item['type'] == 'status':
                    state = item['execution']
                    if state.get('outputTruncated'):
                        raise _error('file_watch_output_limit')
                    if state.get('timedOut'):
                        raise _error('file_watch_timeout')
                    if state.get('status') not in ('starting', 'running'):
                        if self._pending or state.get('status') not in ('succeeded', 'canceled'):
                            raise _error('file_watch_failed')
                        return
                    continue
                self._pending += item['data']
                if len(self._pending) > 65536:
                    raise _error('invalid_file_watch_response')
                while '\n' in self._pending:
                    line, self._pending = self._pending.split('\n', 1)
                    if len(line) > 16384:
                        raise _error('invalid_file_watch_response')
                    try:
                        event = json.loads(line)
                    except ValueError:
                        raise _error('invalid_file_watch_response') from None
                    if not isinstance(event, dict):
                        raise _error('invalid_file_watch_response')
                    if event.get('type') == 'error':
                        code = event.get('code')
                        if code not in ('file_watch_output_limit', 'file_watch_filename_invalid', 'file_watch_unavailable'):
                            raise _error('invalid_file_watch_response')
                        raise _error(code)
                    valid = event.get('type') == 'ready' and event.get('path') == self._path and event.get('recursive') is self._recursive
                    if event.get('type') in ('rename', 'change') and 'filename' in event:
                        name = event['filename']
                        try:
                            valid = name is None or isinstance(name, str) and bool(name) and not name.startswith('/') and '\0' not in name and all(
                                part not in ('', '.', '..') for part in name.split('/')) and len(name.encode('utf-8')) <= 4096
                        except UnicodeError:
                            valid = False
                    if not valid:
                        raise _error('invalid_file_watch_response')
                    self._queued.append(event)
                while self._queued:
                    yield self._queued.popleft()
        finally:
            if stream is not None:
                stream.close()
            self._reading = False

    def close(self):
        if self._closed:
            return {'closed': True}
        result = self.execution.cancel()
        if not isinstance(result, dict) or result.get('status') not in ('succeeded', 'failed', 'canceled', 'timed_out'):
            raise _error('file_watch_cleanup_unconfirmed')
        self._closed = True
        return {'closed': True}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
