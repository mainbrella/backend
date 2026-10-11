import io
import ast
import json
import re
import struct
import unittest
from types import SimpleNamespace
from mainbrella import Mainbrella, MainbrellaError, DesktopSession


DIRECTORY = '/tmp/mainbrella-desktop-abcdefgh'
CONTEXT = 'd688d42a-25ef-4c13-9b28-21a0fde6e163'


def png():
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I4sII', 13, b'IHDR', 1280, 720) + b'\0' * 9 + b'\0\0\0\0IEND\xaeB`\x82'


def fixture(execute=None, image=None):
    sandbox = Mainbrella('mb_' + 'a' * 64).connect('small', '2026-10-11T00:00:00.000Z')
    calls, image = [], png() if image is None else image

    def run(code, timeout_ms=None):
        calls.append(('run', code, timeout_ms))
        match = re.fullmatch(r"_mb_desktop\.call\(__import__\('json'\)\.loads\((.*)\)\)", code)
        payload = json.loads(ast.literal_eval(match[1])) if match else None
        replacement = execute(code, payload) if execute else None
        if replacement is not None:
            return replacement
        if code.endswith('DesktopGuest.probe()'):
            value = {'supported': True, 'tools': dict.fromkeys(('Xvfb', 'xdpyinfo', 'xdotool', 'import'), True)}
        elif code.endswith('_mb_desktop.info()'):
            value = {'display': ':10', 'width': 1280, 'height': 720, 'directory': DIRECTORY}
        elif payload and payload['action'] == 'screenshot':
            value = {'path': DIRECTORY + '/screenshot.png', 'size': len(image)}
        elif payload and payload['action'] == 'launch':
            value = {'pid': 100}
        else:
            value = {'ok': True}
        return {'error': None, 'outputTruncated': False, 'results': [{'mimeType': 'application/json', 'data': json.dumps(value)}]}

    sandbox.code = SimpleNamespace(create=lambda: SimpleNamespace(id=CONTEXT, expires_at=1000, run=run,
        close=lambda: calls.append(('close',))))
    sandbox.files = SimpleNamespace(download=lambda path: (calls.append(('download', path)), io.BytesIO(image))[1],
                                    remove=lambda path: calls.append(('remove', path)))
    return sandbox, calls


class DesktopTests(unittest.TestCase):
    def test_probe_actions_literal_payload_screenshot_and_close(self):
        actions = []
        sandbox, calls = fixture(lambda code, payload: actions.append(payload) if payload else None)
        self.assertTrue(sandbox.desktop.probe()['supported'])
        with sandbox.desktop.start() as desktop:
            self.assertIsInstance(desktop, DesktopSession)
            self.assertEqual(desktop.context_id, CONTEXT)
            self.assertEqual(desktop.expires_at, 1000)
            desktop.move(20, 30)
            desktop.click()
            desktop.press('ctrl+shift+a')
            text = '"\n\\ $() -- literal 中文'
            desktop.type(text)
            desktop.launch(['xterm', '-title', 'literal $()'])
            self.assertEqual(desktop.screenshot(), png())
        desktop.close()
        self.assertEqual(next(action for action in actions if action['action'] == 'type')['text'], text)
        self.assertEqual(len([call for call in calls if call[0] == 'close']), 2)
        self.assertEqual(len([call for call in calls if call[0] == 'remove']), 1)
        with self.assertRaisesRegex(MainbrellaError, 'desktop_closed'):
            desktop.click()

    def test_input_bounds_fail_before_side_effects(self):
        sandbox, calls = fixture()
        for options in ({'width': 0}, {'height': 1081}, {'width': True}):
            with self.assertRaises(MainbrellaError):
                sandbox.desktop.start(**options)
        self.assertFalse(calls)
        desktop = sandbox.desktop.start()
        count = len(calls)
        for operation in (lambda: desktop.move(-1, 0), lambda: desktop.move(True, 0), lambda: desktop.click(6),
                          lambda: desktop.press('--window 5'), lambda: desktop.type('a' * 2049),
                          lambda: desktop.launch('sh'), lambda: desktop.launch(['x', 3])):
            with self.assertRaises(MainbrellaError):
                operation()
        self.assertEqual(len(calls), count)
        desktop.type('\x01' * 2048)
        self.assertLess(len(calls[-1][1].encode()), 16384)
        desktop.close()

    def test_ambiguous_start_closes_without_replaying(self):
        def execute(code, payload):
            if code.endswith('_mb_desktop.info()'):
                raise MainbrellaError('transport_unavailable')
        sandbox, calls = fixture(execute)
        with self.assertRaises(MainbrellaError) as caught:
            sandbox.desktop.start()
        self.assertEqual(caught.exception.context_id, CONTEXT)
        self.assertEqual(len([call for call in calls if call[0] == 'run']), 1)
        self.assertEqual(calls[-1], ('close',))

    def test_invalid_screenshots_are_rejected_and_removed(self):
        for mutation in ('oversized', 'truncated', 'path', 'invalid_png'):
            def execute(code, payload):
                if not payload or payload['action'] != 'screenshot' or mutation == 'invalid_png':
                    return None
                value = {'path': '/tmp/unrelated' if mutation == 'path' else DIRECTORY + '/screenshot.png',
                         'size': 8 * 1024 * 1024 + 1 if mutation == 'oversized' else len(png())}
                return {'error': None, 'outputTruncated': mutation == 'truncated',
                        'results': [{'mimeType': 'application/json', 'data': json.dumps(value)}]}
            sandbox, calls = fixture(execute, png()[:-1] + b'\0' if mutation == 'invalid_png' else None)
            with sandbox.desktop.start() as desktop:
                with self.assertRaises(MainbrellaError):
                    desktop.screenshot()
            self.assertIn(('remove', DIRECTORY + '/screenshot.png'), calls)
            self.assertEqual(any(call[0] == 'download' for call in calls), mutation == 'invalid_png')

    def test_unconfirmed_close_retains_context_for_retry(self):
        sandbox, calls = fixture()
        create = sandbox.code.create
        attempts = []

        def close():
            attempts.append(True)
            if len(attempts) == 1:
                raise MainbrellaError('transport_unavailable')

        def context():
            value = create()
            value.close = close
            return value

        sandbox.code.create = context
        desktop = sandbox.desktop.start()
        with self.assertRaises(MainbrellaError) as caught:
            desktop.close()
        self.assertTrue(caught.exception.cleanup_unconfirmed)
        self.assertEqual(caught.exception.context_id, CONTEXT)
        with self.assertRaisesRegex(MainbrellaError, 'desktop_closed'):
            desktop.click()
        self.assertEqual(desktop.close(), {'closed': True})
        self.assertEqual(len(attempts), 2)


if __name__ == '__main__':
    unittest.main()
