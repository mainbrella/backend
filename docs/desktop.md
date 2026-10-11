# SDK desktop automation

The unreleased JavaScript and Python SDKs can start a bounded Linux X11 desktop
inside a running sandbox. They reuse the stateful Python interpreter, managed
process supervision, generation authorization and streaming file transfer APIs.
No new HTTP endpoint or public desktop listener is added.

The guest image must contain Python 3, GNU `timeout`, `Xvfb`, `xdpyinfo`,
`xdotool` and ImageMagick `import`. `sandbox.desktop.probe()` creates a temporary
Python context, checks the four X11 tools, and closes the context. A missing
Python interpreter fails through the existing code-context API.

[The custom image recipe](../examples/desktop/Dockerfile) adds these packages,
Openbox, xterm and fonts to the managed base. It requires enabled and qualified
customer image builds; no desktop image has been published. The SDK does not
install guest packages or change a running image automatically.

```js
const desktop = await sandbox.desktop.start({ width: 1280, height: 720 });
try {
  await desktop.launch(['openbox']);
  await desktop.launch(['xterm']);
  await desktop.move(120, 100);
  await desktop.click();
  await desktop.type('printf "hello\\n"');
  await desktop.press('Return');
  const png = await desktop.screenshot(); // Uint8Array
} finally {
  await desktop.close();
}
```

```python
with sandbox.desktop.start(width=1280, height=720) as desktop:
    desktop.launch(['openbox'])
    desktop.launch(['xterm'])
    desktop.move(120, 100)
    desktop.click()
    desktop.type('printf "hello\\n"')
    desktop.press('Return')
    png = desktop.screenshot()  # bytes
```

`launch()` accepts an argument list and sets `DISPLAY` for that process. It
reports process admission, not application readiness. Input targets the current
pointer/focused window. `press()` accepts X11 key names and combinations such as
`ctrl+l`, `Return`, and `Alt+F4`. `type()` sends literal text; keyboard layout and
application behavior still determine how the guest receives it. Buttons 1–3 are
left/middle/right; 4 and 5 scroll. Commands never interpolate arguments into a
shell. Launch an explicit shell only when the application needs one.

Desktop operations serialize within one SDK session. Width is 320–1920 pixels,
height is 240–1080, text and launch arguments are bounded to 2 KiB, and at most
16 launched child processes are retained. Xvfb allocates a free local display
and disables TCP. The display is shared with processes inside the same sandbox;
it is not a second security boundary within that sandbox.

PNG screenshots are capped at 8 MiB and downloaded through the bounded binary
file API. The SDK checks the declared size, PNG header, dimensions and end marker,
then deletes the private temporary file, including on transfer failure. Invalid
or truncated output is an error. Screenshots do not pass through interpreter
rich-result output limits.

Each desktop consumes one interpreter/execution slot and expires no later than
its code context's 15-minute deadline or the sandbox lease. Closing tries to stop
children and remove temporary files, then deletes the supervised context to
confirm process-group cleanup. Generation stop and runtime recovery also close
contexts. A deliberately daemonized process can escape the process group; the
sandbox generation lease remains its resource boundary. Abrupt termination can
leave temporary files on the ephemeral guest disk until that generation ends.

Creation and actions are never automatically replayed after a lost response.
A failed start closes its known context. If cleanup cannot be confirmed, the
error retains `contextId`/`context_id` and `cleanupUnconfirmed`/
`cleanup_unconfirmed`; use `sandbox.code.attach(id).close()` to reconcile that
same context. An ambiguous initial context creation has not launched Xvfb and
remains bounded by the interpreter deadline. A session whose `close()` fails
can retry the same close. No reconnectable desktop handle is promised.

## Local verification

SDK tests cover generation identity, literal input, bounds, ambiguous startup,
cleanup, invalid screenshots and serialization. Linux tests use real Xvfb,
xdotool, xterm and ImageMagick: two independent displays, pointer movement,
keyboard input received by an application, PNG decoding, private file modes,
graceful cleanup and supervisor deadline cleanup. These passed locally on
October 11, 2026. They do not establish Cloudflare image/runtime qualification.
The recipe also built against the existing local managed Node base: its Docker
image size was 371,003,171 bytes, below the 512 MiB custom-image limit. That local
base and package resolution do not pin future build output or publish an image.

```sh
docker build -f examples/desktop/Dockerfile.local -t mainbrella-desktop-local:qualification examples/desktop
docker run --rm --init --network none --mount type=bind,source="$PWD",target=/source,readonly --env PYTHONPATH=/source/sdk/python --env MAINBRELLA_DESKTOP_LINUX=1 mainbrella-desktop-local:qualification python3 -m unittest -v sdk/python/test_desktop.py sdk/python/test_desktop_guest.py
```

The local recipe is only a test environment. VNC, browser desktop streaming,
video recording, Windows and a production desktop catalog remain unavailable.
The SDK helper does not close that entire P2 capability.

Tool references checked October 11, 2026:
[Xvfb](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml),
[xdotool](https://github.com/jordansissel/xdotool), and
[ImageMagick import](https://imagemagick.org/script/import.php).
