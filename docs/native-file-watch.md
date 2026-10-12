# Native filesystem watching

The unreleased 0.2.0 SDK supplies `sandbox.files.watchNative()` in JavaScript and
`sandbox.files.watch_native()` in Python. Both start the same Node guest program
through existing managed execution, output streaming and cancellation APIs.
Linux Node 22+ must be installed on the guest PATH. No dependency is installed by
the helper. This is available in source with local Linux qualification; production
qualification and SDK publication remain outstanding. `/capabilities.files.watch`
stays false because there is no provider-native watcher endpoint.

The guest uses nonrecursive `fs.watch`, which uses inotify on Linux. It registers
each existing directory and adds watches for new directories in response to native
rename notifications. Directory traversal occurs during registration, not on a
polling timer. Symlink roots are refused, and recursion does not follow symlinks.
The maximum is 2,048 directories and 64 levels. Invalid UTF-8 filenames cause an
explicit error rather than a renamed/replacement-character path.

The handle returns its managed `execution` and its creation idempotency key.
Execution admission can succeed even if the guest cannot start the watcher, so
consume the `ready` event before triggering a change. Later events are
`{type: "rename" | "change", filename: string | null}` with relative filenames.
These are native hints: a rename notification can mean creation, deletion or
renaming. A missing filename is retained as null, not fabricated. Call normal
file APIs to inspect the current state when necessary.

The guest stops after 512 KiB of output; managed execution has additional output,
history and event limits. Timeouts are explicit and bounded to 15 minutes. A
watcher uses an ordinary managed execution slot and the sandbox's paid lifetime.
Generation-qualified cancellation stops only that execution. `close()` requires a
terminal execution response and is repeatable; cleanup errors retain the handle
so the caller can reconcile through `execution.get()` or retry cancellation.
Use JavaScript `try/finally` or Python's context manager.

Closing or losing an event reader does not stop the guest. Reopening `events()`
on the same handle continues from the execution cursor and retains partial JSON
and queued records. A second concurrent reader is rejected. The execution ID can
be attached from another client for raw retained output and cleanup; decoded
watcher state is not a portable checkpoint. No automatic replacement watcher is
started after an ambiguous request or stream failure. Retry admission only with
the original key and identical options.

Native watching is not a durable journal. Kernel notifications may coalesce,
queues or retained execution output may overflow, and changes inside a directory
can race registration when that directory is created or moved into the tree.
Watching an inode does not follow a replaced root; recreate the watcher when its
root is moved/replaced. Filesystem restore creates a new generation and requires
a new watcher. There is no promise to replay events missed during downtime.
The SDK reports observed guest/parser errors and explicit managed truncation; it
cannot detect every kernel-level loss.

Local verification exercises actual Linux short-lived files, nested writes,
renames, invalid filename bytes, symlink rejection and process cleanup. SDK tests
cover split output, reconnect, iterator return, error bounds, retained creation
keys and cancellation confirmation. Run native checks on Linux with:

```sh
node --test scripts/native-file-watch.test.mjs
```

See Node's [filesystem watching caveats](https://nodejs.org/api/fs.html#caveats).
