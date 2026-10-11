"""Guest-side X11 driver, executed inside a supervised Python code context."""
import os
import re
import select
import shutil
import subprocess
import tempfile
import time


class DesktopGuest:
    @staticmethod
    def probe():
        tools = {name: shutil.which(name) is not None for name in ('Xvfb', 'xdpyinfo', 'xdotool', 'import')}
        return {'supported': all(tools.values()), 'tools': tools}

    def __init__(self, width, height):
        if type(width) is not int or type(height) is not int or not 320 <= width <= 1920 or not 240 <= height <= 1080:
            raise ValueError('invalid_desktop_options')
        if not self.probe()['supported']:
            raise RuntimeError('desktop_tools_unavailable')
        self.width, self.height = width, height
        self.directory = tempfile.mkdtemp(prefix='mainbrella-desktop-', dir='/tmp')
        self.processes, self.xvfb, self.closed = [], None, False
        read_fd, write_fd = os.pipe()
        try:
            self.xvfb = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0',
                                         str(width) + 'x' + str(height) + 'x24', '-nolisten', 'tcp', '-noreset'],
                                        pass_fds=(write_fd,), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.close(write_fd)
            write_fd = None
            if not select.select([read_fd], [], [], 10)[0]:
                raise RuntimeError('desktop_start_timeout')
            display = os.read(read_fd, 32).decode('ascii').strip()
            if not re.fullmatch(r'[0-9]{1,5}', display) or self.xvfb.poll() is not None:
                raise RuntimeError('desktop_unavailable')
            self.display = ':' + display
            self.env = dict(os.environ, DISPLAY=self.display)
            self._run(['xdpyinfo', '-display', self.display])
        except BaseException:
            self.close()
            raise
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

    def info(self):
        return {'display': self.display, 'width': self.width, 'height': self.height,
                'directory': self.directory}

    def _run(self, argv):
        try:
            subprocess.run(argv, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError('desktop_command_failed') from None

    def call(self, value):
        if self.closed or self.xvfb.poll() is not None:
            raise RuntimeError('desktop_closed')
        action = value.get('action')
        if action == 'move':
            x, y = value.get('x'), value.get('y')
            if type(x) is not int or type(y) is not int or not 0 <= x < self.width or not 0 <= y < self.height:
                raise ValueError('invalid_desktop_coordinates')
            self._run(['xdotool', 'mousemove', str(x), str(y)])
        elif action == 'click':
            button = value.get('button')
            if type(button) is not int or not 1 <= button <= 5:
                raise ValueError('invalid_desktop_button')
            self._run(['xdotool', 'click', '--clearmodifiers', str(button)])
        elif action == 'press':
            keys = value.get('keys')
            if not isinstance(keys, str) or len(keys) > 128 or not re.fullmatch(r'[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*', keys):
                raise ValueError('invalid_desktop_keys')
            self._run(['xdotool', 'key', '--clearmodifiers', keys])
        elif action == 'type':
            text = value.get('text')
            if not isinstance(text, str) or '\0' in text or len(text.encode('utf-8')) > 2048:
                raise ValueError('invalid_desktop_text')
            self._run(['xdotool', 'type', '--clearmodifiers', '--delay', '0', '--', text])
        elif action == 'launch':
            argv = value.get('argv')
            if (not isinstance(argv, list) or not 1 <= len(argv) <= 64 or not argv[0]
                    or any(not isinstance(arg, str) or '\0' in arg for arg in argv)
                    or sum(len(arg.encode('utf-8')) for arg in argv) > 2048):
                raise ValueError('invalid_desktop_argv')
            self.processes = [process for process in self.processes if process.poll() is None]
            if len(self.processes) >= 16:
                raise RuntimeError('desktop_process_limit')
            try:
                process = subprocess.Popen(argv, env=self.env, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                raise RuntimeError('desktop_command_failed') from None
            self.processes.append(process)
            return {'pid': process.pid}
        elif action == 'screenshot':
            path = self.directory + '/screenshot.png'
            # A private directory and O_EXCL avoid overwriting an earlier file.
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
            try:
                self._run(['import', '-display', self.display, '-window', 'root', '-depth', '8',
                           '-limit', 'memory', '32MiB', '-limit', 'map', '64MiB', '-limit', 'disk', '32MiB',
                           'PNG:' + path])
                size = os.stat(path).st_size
                if not 45 <= size <= 8 * 1024 * 1024:
                    raise RuntimeError('desktop_screenshot_limit')
                return {'path': path, 'size': size}
            except BaseException:
                os.unlink(path)
                raise
        else:
            raise ValueError('invalid_desktop_action')
        return {'ok': True}

    def close(self):
        if self.closed:
            return {'closed': True}
        processes = self.processes + ([self.xvfb] if self.xvfb is not None else [])
        for process in processes:
            if process.poll() is None:
                process.terminate()
        deadline = time.monotonic() + 2
        for process in processes:
            try:
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        shutil.rmtree(self.directory)
        self.closed = True
        return {'closed': True}
