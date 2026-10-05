import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from mainbrella import Mainbrella, MainbrellaError

KEY = "mb_" + "a" * 64
GENERATION = "2026-10-05T12:00:00.000Z"


class ClientTests(unittest.TestCase):
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
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
