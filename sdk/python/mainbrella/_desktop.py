"""X11 desktop helpers built on generation-scoped supervised code contexts."""
import json
import re
import struct
import threading
from importlib.resources import files


def _error(code):
    from . import MainbrellaError
    return MainbrellaError(code)


def _decode(result):
    if not isinstance(result, dict):
        raise _error('invalid_desktop_response')
    if result.get('error'):
        message = result['error'].get('message', '') if isinstance(result['error'], dict) else ''
        if not isinstance(message, str):
            message = ''
        raise _error(message if re.fullmatch(r'desktop_[a-z_]+', message) else 'desktop_command_failed')
    item = next((item for item in result.get('results', []) if item.get('mimeType') == 'application/json'), None)
    if result.get('outputTruncated') or item is None:
        raise _error('invalid_desktop_response')
    try:
        return json.loads(item['data'])
    except (TypeError, ValueError, KeyError):
        raise _error('invalid_desktop_response') from None


def _bootstrap():
    return 'exec(' + repr(files(__package__).joinpath('_desktop_guest.py').read_text(encoding='utf-8')) + ')\n'


def _close_context(context):
    try:
        context.close()
    except Exception as error:
        if getattr(error, 'code', None) != 'code_context_not_found':
            error.context_id, error.cleanup_unconfirmed = context.id, True
            raise


class DesktopTools:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def probe(self):
        context = self.sandbox.code.create()
        try:
            result = _decode(context.run(_bootstrap() + 'DesktopGuest.probe()', timeout_ms=15000))
            if (not isinstance(result, dict) or type(result.get('supported')) is not bool
                    or not isinstance(result.get('tools'), dict)
                    or any(type(result['tools'].get(name)) is not bool for name in ('Xvfb', 'xdpyinfo', 'xdotool', 'import'))
                    or result['supported'] != all(result['tools'].values())):
                raise _error('invalid_desktop_response')
            return result
        finally:
            _close_context(context)

    def start(self, width=1280, height=720):
        if type(width) is not int or type(height) is not int or not 320 <= width <= 1920 or not 240 <= height <= 1080:
            raise _error('invalid_desktop_options')
        context = self.sandbox.code.create()
        try:
            info = _decode(context.run(_bootstrap() + '_mb_desktop = DesktopGuest(%d, %d)\n_mb_desktop.info()' % (width, height), timeout_ms=20000))
            if (not isinstance(info, dict) or info.get('width') != width or info.get('height') != height
                    or not isinstance(info.get('display'), str) or not re.fullmatch(r':[0-9]{1,5}', info['display'])
                    or not isinstance(info.get('directory'), str)
                    or not re.fullmatch(r'/tmp/mainbrella-desktop-[a-z0-9_]{8}', info['directory'])):
                raise _error('invalid_desktop_response')
            return DesktopSession(self.sandbox, context, info)
        except Exception as error:
            try:
                _close_context(context)
            except Exception:
                error.cleanup_unconfirmed = True
            error.context_id = context.id
            raise


class DesktopSession:
    def __init__(self, sandbox, context, info):
        self._sandbox, self._context, self._directory = sandbox, context, info['directory']
        self._lock, self._closed, self._closing = threading.RLock(), False, False
        self.context_id, self.expires_at = context.id, context.expires_at
        self.width, self.height, self.display = info['width'], info['height'], info['display']

    def _call(self, payload):
        with self._lock:
            if self._closed or self._closing:
                raise _error('desktop_closed')
            encoded = repr(json.dumps(payload, ensure_ascii=False))
            result = _decode(self._context.run("_mb_desktop.call(__import__('json').loads(" + encoded + "))", timeout_ms=15000))
            if (not isinstance(result, dict)
                    or payload['action'] == 'launch' and (type(result.get('pid')) is not int or result['pid'] <= 1)
                    or payload['action'] not in ('launch', 'screenshot') and result.get('ok') is not True):
                raise _error('invalid_desktop_response')
            return result

    def move(self, x, y):
        if type(x) is not int or type(y) is not int or not 0 <= x < self.width or not 0 <= y < self.height:
            raise _error('invalid_desktop_coordinates')
        return self._call({'action': 'move', 'x': x, 'y': y})

    def click(self, button=1):
        if type(button) is not int or not 1 <= button <= 5:
            raise _error('invalid_desktop_button')
        return self._call({'action': 'click', 'button': button})

    def press(self, keys):
        if not isinstance(keys, str) or len(keys) > 128 or not re.fullmatch(r'[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*', keys):
            raise _error('invalid_desktop_keys')
        return self._call({'action': 'press', 'keys': keys})

    def type(self, text):
        if not isinstance(text, str) or '\0' in text or len(text.encode('utf-8')) > 2048:
            raise _error('invalid_desktop_text')
        return self._call({'action': 'type', 'text': text})

    def launch(self, argv):
        if (not isinstance(argv, list) or not 1 <= len(argv) <= 64 or not argv[0]
                or any(not isinstance(arg, str) or '\0' in arg for arg in argv)
                or sum(len(arg.encode('utf-8')) for arg in argv) > 2048):
            raise _error('invalid_desktop_argv')
        return self._call({'action': 'launch', 'argv': argv})

    def screenshot(self):
        with self._lock:
            if self._closed or self._closing:
                raise _error('desktop_closed')
            path = self._directory + '/screenshot.png'
            try:
                result = self._call({'action': 'screenshot'})
                size = result.get('size')
                if result.get('path') != path or type(size) is not int or not 45 <= size <= 8 * 1024 * 1024:
                    raise _error('invalid_desktop_screenshot')
                data = bytearray()
                with self._sandbox.files.download(path) as stream:
                    while True:
                        chunk = stream.read(min(65536, size - len(data) + 1))
                        if not isinstance(chunk, bytes) or len(data) + len(chunk) > size:
                            raise _error('invalid_desktop_screenshot')
                        if not chunk:
                            break
                        data.extend(chunk)
                if (len(data) != size or data[:8] != b'\x89PNG\r\n\x1a\n'
                        or data[-12:] != b'\0\0\0\0IEND\xaeB`\x82'
                        or data[8:16] != b'\0\0\0\rIHDR'
                        or struct.unpack('>II', data[16:24]) != (self.width, self.height)):
                    raise _error('invalid_desktop_screenshot')
                return bytes(data)
            finally:
                try:
                    self._sandbox.files.remove(path)
                except Exception as error:
                    if getattr(error, 'code', None) != 'file_not_found':
                        raise

    def close(self):
        with self._lock:
            if self._closed:
                return {'closed': True}
            self._closing = True
            try:
                self._context.run('_mb_desktop.close()', timeout_ms=10000)
            except Exception:
                pass
            try:
                _close_context(self._context)
            except Exception as error:
                error.context_id, error.cleanup_unconfirmed = self.context_id, True
                raise
            self._closed = True
            return {'closed': True}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
