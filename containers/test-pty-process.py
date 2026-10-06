"""Local native-PTY adapter for managed-execution integration tests only."""
import base64
import errno
import fcntl
import json
import os
import pty
import selectors
import struct
import subprocess
import sys
import termios

options = json.loads(sys.argv[1])
argv = json.loads(sys.argv[2])
master, slave = pty.openpty()


def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def prepare():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)


resize(options["cols"], options["rows"])
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, preexec_fn=prepare)
os.close(slave)
os.write(3, (str(child.pid) + "\n").encode())
os.close(3)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
pending = b""
try:
    while True:
        for key, _ in selector.select(timeout=0.1):
            if key.fd == master:
                try:
                    data = os.read(master, 8192)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    else:
                        raise
                if not data:
                    # PTY EOF can arrive before the child is reaped. Wait for its
                    # actual exit status rather than inventing a failure in that race.
                    sys.exit(child.wait())
                os.write(1, data)
            else:
                data = os.read(0, 65536)
                if not data:
                    selector.unregister(0)
                    continue
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    if "data" in message:
                        os.write(master, base64.b64decode(message["data"]))
                    else:
                        resize(message["cols"], message["rows"])
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
    child.wait()
