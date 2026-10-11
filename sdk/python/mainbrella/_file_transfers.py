"""Streaming files and conservative directory copies, without archive extraction."""
import io
import os
import tempfile
import time
from pathlib import Path, PurePosixPath

MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 10_000


class FileTransfers:
    def _error(self, code):
        from . import MainbrellaError
        return MainbrellaError(code)

    def _remote(self, path):
        if (not isinstance(path, str) or not path.startswith('/') or path == '/' or '\0' in path
                or any(part in ('', '.', '..') for part in path.split('/')[1:])):
            raise self._error('invalid_file_path')
        return path

    def upload(self, path, source, size=None):
        self._remote(path)
        if isinstance(source, bytes):
            size = len(source) if size is None else size
            if size != len(source):
                raise self._error('invalid_transfer_size')
            source = io.BytesIO(source)
        if not hasattr(source, 'read'):
            raise self._error('file_stream_required')
        if type(size) is not int or not 0 <= size <= MAX_BYTES:
            raise self._error('invalid_transfer_size')

        def chunks():
            received = 0
            while True:
                data = source.read(min(65536, size - received + 1))
                if not isinstance(data, bytes):
                    raise self._error('file_bytes_required')
                if not data:
                    if received != size:
                        raise self._error('file_size_mismatch')
                    return
                received += len(data)
                if received > size:
                    raise self._error('file_size_mismatch')
                yield data

        return self.sandbox.client.request(self.sandbox._path('/containers/files/transfer', path=path, size=size),
                                           'PUT', chunks(), raw_body=True)

    def download(self, path):
        """Return a binary response stream. Use a with block or close it explicitly."""
        self._remote(path)
        return self.sandbox.client.request(self.sandbox._path('/containers/files/transfer', path=path), stream=True)

    def _snapshot(self, path, recursive=True):
        result = {}

        def walk(directory, depth):
            if depth > 64:
                raise self._error('directory_too_large')
            offset = None
            while True:
                page = self.list(directory, limit=1000, offset=offset)
                for entry in page['entries']:
                    name = entry.get('name')
                    if not isinstance(name, str) or name in ('', '.', '..') or any(c in name for c in ('/', '\\', '\0')):
                        raise self._error('invalid_directory_entry')
                    child = directory + '/' + name
                    if len(result) >= MAX_ENTRIES:
                        raise self._error('directory_too_large')
                    result[child] = dict(entry, path=child)
                    if recursive and entry['type'] == 'directory':
                        walk(child, depth + 1)
                next_offset = page['nextOffset']
                if next_offset is None:
                    break
                if type(next_offset) is not int or next_offset <= (offset or 0):
                    raise self._error('invalid_response')
                offset = next_offset

        walk(path, 0)
        return result

    def upload_directory(self, local, remote):
        self._remote(remote)
        local = Path(local)
        if local.is_symlink() or not local.is_dir():
            raise self._error('not_directory')
        count = 0

        def walk(source, destination, depth):
            nonlocal count
            count += 1
            if count > MAX_ENTRIES or depth > 64:
                raise self._error('directory_too_large')
            if source.is_symlink():
                raise self._error('symlink_not_allowed')
            if source.is_dir():
                self.mkdir(destination, recursive=True)
                for child in sorted(source.iterdir()):
                    self._remote(destination + '/' + child.name)
                    walk(child, destination + '/' + child.name, depth + 1)
            elif source.is_file():
                with source.open('rb') as stream:
                    self.upload(destination, stream, size=os.fstat(stream.fileno()).st_size)
            else:
                raise self._error('not_regular_file')

        walk(local, remote, 0)
        return {'entries': count}

    def download_directory(self, remote, local):
        self._remote(remote)
        entries = self._snapshot(remote)
        if any(entry['type'] not in ('file', 'directory') for entry in entries.values()):
            raise self._error('not_regular_file')
        local = Path(local)
        if local.is_symlink():
            raise self._error('symlink_not_allowed')
        local.mkdir(parents=True, exist_ok=True)
        root = local.resolve()
        for path, entry in entries.items():
            destination = root.joinpath(*PurePosixPath(path[len(remote) + 1:]).parts)
            if destination.is_symlink():
                raise self._error('symlink_not_allowed')
            if entry['type'] == 'directory':
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if destination.exists() and not destination.is_file():
                raise self._error('not_regular_file')
            fd, temporary = tempfile.mkstemp(prefix='.mainbrella-download-', dir=destination.parent)
            try:
                with os.fdopen(fd, 'wb') as output, self.download(path) as stream:
                    while True:
                        chunk = stream.read(65536)
                        if not chunk:
                            break
                        output.write(chunk)
                os.replace(temporary, destination)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {'entries': len(entries)}

    def watch(self, path, interval=1.0, recursive=True, stop_event=None):
        """Poll metadata; same-size writes within one second may be invisible."""
        self._remote(path)
        if type(interval) not in (int, float) or not .25 <= interval < float('inf') or type(recursive) is not bool:
            raise self._error('invalid_file_options')
        previous = self._snapshot(path, recursive)
        while True:
            if stop_event is not None:
                if stop_event.wait(interval):
                    return
            else:
                time.sleep(interval)
            current = self._snapshot(path, recursive)
            for key, entry in current.items():
                if key not in previous:
                    yield {'type': 'create', 'entry': entry}
                elif entry != previous[key]:
                    yield {'type': 'modify', 'entry': entry}
            for key, entry in previous.items():
                if key not in current:
                    yield {'type': 'remove', 'entry': entry}
            previous = current


class Download:
    """Bounded exact-length reader which closes the socket on failure."""
    def __init__(self, source, size):
        from . import MainbrellaError
        self.source, self.size, self.received = source, size, 0
        if type(size) is not int or not 0 <= size <= MAX_BYTES:
            source.close()
            raise MainbrellaError('invalid_response')

    def read(self, size=-1):
        from . import MainbrellaError
        if size == 0:
            return b''
        try:
            data = self.source.read(size)
            self.received += len(data)
            if self.received > self.size or (not data or size is None or size < 0) and self.received != self.size:
                raise MainbrellaError('file_size_mismatch')
            return data
        except Exception:
            self.close()
            raise

    def close(self):
        self.source.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
