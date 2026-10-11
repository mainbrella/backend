import io
import json
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from mainbrella import Mainbrella, MainbrellaError
from mainbrella._file_transfers import Download
from urllib.parse import urlsplit, parse_qs


class TransfersTest(unittest.TestCase):
    def sandbox(self, transport):
        return Mainbrella('mb_' + 'a' * 64, transport=transport).connect('small', '2026-10-05T12:00:00.000Z')

    def test_streaming_upload_and_download_and_size_bounds(self):
        data = bytes(range(256)) * 8193
        calls = []

        def transport(url, method, headers, body, timeout):
            calls.append(url)
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query['createdAt'], ['2026-10-05T12:00:00.000Z'])
            if method == 'PUT':
                self.assertEqual(headers['Content-Type'], 'application/octet-stream')
                self.assertNotIsInstance(body, bytes)
                self.assertEqual(b''.join(body), data)
                return 200, json.dumps({'path': '/workspace/file', 'size': len(data)}).encode()
            return 200, data

        files = self.sandbox(transport).files
        files.upload('/workspace/file', io.BytesIO(data), size=len(data))
        with files.download('/workspace/file') as source:
            self.assertEqual(source.read(65536) + source.read(), data)
        self.assertEqual(len(calls), 2)
        for source, size in [(b'x', 2), (io.BytesIO(b'x'), -1), (io.BytesIO(b'x'), 67108865)]:
            with self.assertRaises(MainbrellaError):
                files.upload('/file', source, size=size)
        for data, length in [(b'x', 2), (b'xxx', 2)]:
            with self.assertRaises(MainbrellaError):
                Download(io.BytesIO(data), length).read()

    def test_default_transport_streams_chunked_uploads_and_closes_download_socket(self):
        data = bytes(range(256)) * 4097
        uploaded = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_PUT(self):
                chunks = []
                if self.headers.get('Transfer-Encoding') != 'chunked':
                    self.send_error(400)
                    return
                while True:
                    size = int(self.rfile.readline().strip(), 16)
                    if not size:
                        self.rfile.readline()
                        break
                    chunks.append(self.rfile.read(size))
                    self.rfile.read(2)
                uploaded.append(b''.join(chunks))
                result = json.dumps({'path': '/file', 'size': len(uploaded[-1])}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(result)))
                self.end_headers()
                self.wfile.write(result)

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = Mainbrella('mb_' + 'a' * 64, base_url='http://127.0.0.1:' + str(server.server_port))
            files = client.connect('small', '2026-10-05T12:00:00.000Z').files
            files.upload('/file', io.BytesIO(data), size=len(data))
            self.assertEqual(uploaded, [data])
            with files.download('/file') as stream:
                self.assertEqual(stream.read(32768) + stream.read(), data)
            self.assertTrue(stream.source.closed)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_directory_transfers_preserve_binary_and_reject_links(self):
        remote = {}

        def transport(url, method, headers, body, timeout):
            parsed = urlsplit(url)
            query = parse_qs(parsed.query)
            path = query.get('path', [None])[0]
            if parsed.path.endswith('/mkdir'):
                value = json.loads(body)
                remote[value['path']] = {'type': 'directory'}
                return 200, b'{"ok": true}'
            if parsed.path.endswith('/transfer'):
                if method == 'PUT':
                    data = b''.join(body)
                    remote[path] = {'type': 'file', 'data': data}
                    return 200, json.dumps({'path': path, 'size': len(data)}).encode()
                return 200, remote[path]['data']
            entries = [dict(name=key[len(path) + 1:], type=value['type'], path=key)
                       for key, value in remote.items() if key.startswith(path + '/') and '/' not in key[len(path) + 1:]]
            return 200, json.dumps({'entries': entries, 'nextOffset': None}).encode()

        files = self.sandbox(transport).files
        with tempfile.TemporaryDirectory() as root:
            source = Path(root, 'source')
            source.joinpath('nested').mkdir(parents=True)
            data = bytes(range(256)) * 4097
            source.joinpath('nested', 'binary').write_bytes(data)
            files.upload_directory(source, '/workspace/tree')
            destination = Path(root, 'destination')
            files.download_directory('/workspace/tree', destination)
            self.assertEqual(destination.joinpath('nested', 'binary').read_bytes(), data)
            source.joinpath('link').symlink_to(source)
            with self.assertRaises(MainbrellaError):
                files.upload_directory(source, '/workspace/tree')

    def test_watch_reports_changes_and_stop_event_closes_iterator(self):
        count = 0

        def transport(*_):
            nonlocal count
            count += 1
            entries = [] if count == 1 else [{'name': 'new', 'type': 'file', 'size': 1}]
            return 200, json.dumps({'entries': entries, 'nextOffset': None}).encode()

        stop = Event()
        events = self.sandbox(transport).files.watch('/workspace', interval=.25, stop_event=stop)
        self.assertEqual(next(events)['type'], 'create')
        stop.set()
        with self.assertRaises(StopIteration):
            next(events)


if __name__ == '__main__':
    unittest.main()
