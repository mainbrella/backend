import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from mainbrella import Mainbrella, MainbrellaError

KEY = "mb_" + "a" * 64
GENERATION = "2026-10-05T12:00:00.000Z"


class ClientTests(unittest.TestCase):
    def test_previews_use_exact_generation_and_metadata_reconciliation(self):
        calls = []
        grant = {"id": "b" * 32, "port": 3000, "createdAt": GENERATION, "expiresAt": 2000000000000}
        def transport(url, method, headers, body, timeout):
            calls.append(method)
            self.assertEqual(urlsplit(url).path, "/containers/previews")
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["id"], ["small"])
            self.assertEqual(query["createdAt"], [GENERATION])
            if method == "POST":
                self.assertEqual(json.loads(body), {"port": 3000, "ttlSeconds": 600})
                return 201, json.dumps(dict(grant, url="https://" + "a" * 48 + ".preview.example/")).encode()
            if method == "DELETE":
                self.assertEqual(query["previewId"], [grant["id"]])
                return 200, b'{"revoked":true}'
            return 200, json.dumps({"previews": [grant]}).encode()
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        link = sandbox.previews.create(3000, ttl_seconds=600)
        self.assertEqual(link["id"], grant["id"])
        self.assertEqual(sandbox.previews.list(), {"previews": [grant]})
        self.assertEqual(sandbox.previews.revoke(link["id"]), {"revoked": True})
        for port in [22, 1023, 65536, 3000.5, "3000", True]:
            with self.assertRaises(MainbrellaError):
                sandbox.previews.create(port)
        for ttl in [59, 3601, 60.5, "600", True]:
            with self.assertRaises(MainbrellaError):
                sandbox.previews.create(3000, ttl_seconds=ttl)
        with self.assertRaises(MainbrellaError):
            sandbox.previews.revoke("invalid")
        self.assertEqual(len(calls), 3)

    def test_preview_failure_is_not_retried_and_keeps_only_safe_cleanup_id(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return 503, json.dumps({"error": "preview_reconciliation_required", "previewId": "b" * 32, "token": KEY}).encode()
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        with self.assertRaises(MainbrellaError) as error:
            sandbox.previews.create(3000)
        self.assertEqual(error.exception.preview_id, "b" * 32)
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(len(calls), 1)
        for code, preview_id in [("previews_unavailable", "b" * 32), ("preview_reconciliation_required", KEY)]:
            client = Mainbrella(KEY, transport=lambda *args: (503, json.dumps({"error": code, "previewId": preview_id}).encode()))
            with self.assertRaises(MainbrellaError) as error:
                client.connect("small", GENERATION).previews.list()
            self.assertIsNone(error.exception.preview_id)

    def test_creation_retries_and_generation_cleanup(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append((method, headers, body))
            if len(calls) == 1:
                raise OSError(KEY)
            if method == "DELETE":
                self.assertEqual(parse_qs(urlsplit(url).query)["createdAt"], [GENERATION])
                return 200, b'{"containers":[]}'
            return 200, json.dumps({"creation": {"id": "operation", "containerId": "c1", "createdAt": GENERATION, "status": "running"},
                                    "containers": [{"id": "small", "createdAt": GENERATION, "status": "running"},
                                                   {"id": "c1", "createdAt": GENERATION, "status": "running"}]}).encode()
        with Mainbrella(KEY, transport=transport).create(idempotency_key="stable", poll_interval=0.001) as sandbox:
            self.assertEqual(sandbox.id, "c1")
        self.assertEqual([h["Idempotency-Key"] for m, h, b in calls if m == "POST"], ["stable", "stable"])

    def test_no_command_retry_and_sanitized_failures(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return 503, json.dumps({"error": "secret: " + KEY}).encode()
        with self.assertRaises(MainbrellaError) as error:
            Mainbrella(KEY, transport=transport).connect("small", GENERATION).commands.run("side effect")
        self.assertEqual(error.exception.code, "request_failed")
        self.assertEqual(len(calls), 1)

    def test_unsafe_urls_and_ambiguous_creation(self):
        for url in ["http://example.com", "https://user:pass@example.com", "https://example.com/path"]:
            with self.assertRaises(MainbrellaError):
                Mainbrella(KEY, base_url=url)
        client = Mainbrella(KEY, transport=lambda *args: (503, b'{"error":"unavailable"}'))
        with self.assertRaises(MainbrellaError) as error:
            client.create(idempotency_key="recover", wait_timeout=0.005, poll_interval=0.001)
        self.assertEqual(error.exception.idempotency_key, "recover")

    def test_real_http_binary_roundtrip_and_redirect_refusal(self):
        probe = bytes([0, 128, 255])
        owner = self
        class Handler(BaseHTTPRequestHandler):
            stored = b""
            def log_message(self, *args):
                pass
            def do_PUT(self):
                owner.assertEqual(self.headers["Authorization"], "Bearer " + KEY)
                owner.assertEqual(parse_qs(urlsplit(self.path).query)["createdAt"], [GENERATION])
                Handler.stored = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"size":3}')
            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(302); self.send_header("Location", "/leak"); self.end_headers()
                elif "/events?" in self.path:
                    self.send_response(200); self.end_headers()
                    self.wfile.write('id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"héllo 界"}\n\nevent: status\ndata: {"status":"succeeded"}\n\n'.encode())
                else:
                    owner.assertNotEqual(self.path, "/leak")
                    self.send_response(200); self.end_headers(); self.wfile.write(Handler.stored)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = Mainbrella(KEY, base_url=f"http://127.0.0.1:{server.server_port}")
            sandbox = client.connect("small", GENERATION)
            sandbox.files.write("/tmp/界 &?.bin", probe)
            self.assertEqual(sandbox.files.read("/tmp/界 &?.bin"), probe)
            with self.assertRaises(MainbrellaError) as error:
                client.request("/redirect")
            self.assertEqual(error.exception.status, 302)
            from mainbrella import Execution
            execution = Execution(sandbox, 'd688d42a-25ef-4c13-9b28-21a0fde6e163')
            events = list(execution.events())
            self.assertEqual(events[0]["data"], "héllo 界")
            self.assertEqual(execution.cursor, 1)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
