import os
import shutil
import struct
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from mainbrella._desktop_guest import DesktopGuest


class DesktopGuestValidationTests(unittest.TestCase):
    def test_missing_tools_and_invalid_dimensions_do_not_start_processes(self):
        with patch('mainbrella._desktop_guest.shutil.which', return_value=None), patch('mainbrella._desktop_guest.subprocess.Popen') as launch:
            self.assertFalse(DesktopGuest.probe()['supported'])
            with self.assertRaisesRegex(RuntimeError, 'desktop_tools_unavailable'):
                DesktopGuest(640, 480)
            with self.assertRaisesRegex(ValueError, 'invalid_desktop_options'):
                DesktopGuest(True, 480)
            launch.assert_not_called()


@unittest.skipUnless(os.environ.get('MAINBRELLA_DESKTOP_LINUX') == '1', 'opt-in Linux X11 qualification')
class DesktopGuestLinuxTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(DesktopGuest.probe()['supported'])

    def test_real_private_displays_input_png_and_cleanup(self):
        first = DesktopGuest(640, 480)
        second = DesktopGuest(320, 240)
        try:
            self.assertNotEqual(first.display, second.display)
            first.call({'action': 'move', 'x': 100, 'y': 110})
            position = subprocess.check_output(['xdotool', 'getmouselocation', '--shell'], env=first.env).decode()
            self.assertIn('X=100\n', position)
            self.assertIn('Y=110\n', position)
            marker = first.directory + '/typed.txt'
            literal = 'literal -- "quotes" $(touch /tmp/mb-desktop-injection)'
            first.call({'action': 'launch', 'argv': ['xterm', '-title', 'MainbrellaDesktopTest', '-e', 'sh', '-c',
                       'IFS= read -r line; printf "%s" "$line" > "$1"; sleep 60', 'sh', marker]})
            window = subprocess.check_output(['xdotool', 'search', '--sync', '--onlyvisible', '--name', 'MainbrellaDesktopTest'],
                                             env=first.env, timeout=10).decode().splitlines()[0]
            subprocess.run(['xdotool', 'windowfocus', '--sync', window], env=first.env, check=True, timeout=10)
            first.call({'action': 'click', 'button': 1})
            first.call({'action': 'type', 'text': literal})
            first.call({'action': 'press', 'keys': 'Return'})
            deadline = time.monotonic() + 5
            while not os.path.exists(marker) and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(Path(marker).read_text(), literal)
            self.assertFalse(os.path.exists('/tmp/mb-desktop-injection'))
            shot = first.call({'action': 'screenshot'})
            data = Path(shot['path']).read_bytes()
            self.assertEqual(len(data), shot['size'])
            self.assertEqual(struct.unpack('>II', data[16:24]), (640, 480))
            subprocess.run(['identify', '-regard-warnings', shot['path']], stdout=subprocess.DEVNULL, check=True, timeout=10)
            self.assertEqual(os.stat(shot['path']).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                first.call({'action': 'screenshot'})
            os.unlink(shot['path'])
            xvfb, children = first.xvfb, list(first.processes)
            first.close()
            self.assertIsNotNone(xvfb.poll())
            self.assertTrue(all(child.poll() is not None for child in children))
            self.assertFalse(os.path.exists(first.directory))
            with self.assertRaisesRegex(RuntimeError, 'desktop_closed'):
                first.call({'action': 'click', 'button': 1})
            # Closing one desktop must not stop another display in the sandbox.
            self.assertIsNone(second.xvfb.poll())
            self.assertTrue(second.call({'action': 'move', 'x': 10, 'y': 10})['ok'])
        finally:
            first.close()
            second.close()

    def test_supervised_process_group_deadline_kills_xvfb(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'pid'
            source = ('import time; from mainbrella._desktop_guest import DesktopGuest; '
                      'desktop=DesktopGuest(320,240); '
                      'open(' + repr(str(marker)) + ',"w").write(str(desktop.xvfb.pid)); time.sleep(60)')
            result = subprocess.run(['timeout', '--signal=KILL', '2s', 'python3', '-c', source],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            pid = int(marker.read_text())
            status = Path('/proc') / str(pid) / 'stat'
            self.assertTrue(not status.exists() or status.read_text().split()[2] in ('Z', 'X'))


if __name__ == '__main__':
    unittest.main()
