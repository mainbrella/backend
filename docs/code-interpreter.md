# Stateful Python code contexts

This checkout implements a Python interpreter API, HTTP OpenAPI definitions, and
JavaScript/Python SDK helpers. It has local runtime coverage using real Python
processes. Deployment qualification and SDK publication are separate steps;
check the running API's `codeInterpreter` capability before use.

Create a context with `POST /containers/code-contexts` and
`{"language":"python"}`. Every endpoint requires the exact owned sandbox `id`
and `createdAt` query parameters. The image must supply `python3` and GNU
`timeout`. The Python catalog image is suitable. The kernel is launched directly
without installing packages or writing helper files into the guest.

`POST /containers/code-contexts/{contextId}/execute` accepts `code` and optional
`timeoutMs`. Globals, imports, and the `_` final-expression variable persist
within a context. Separate contexts have separate Python namespaces but share
the sandbox's filesystem and privileges. Python exceptions return structured
`error` fields with a 200 response and preserve existing variables.

Responses contain `stdout`, `stderr`, `results`, `error`, and
`outputTruncated`. The final expression yields `text/plain`, plus
`application/json` when serializable. Objects may additionally provide
`_repr_html_()` or `_repr_png_()`; PNG data is base64 encoded. MIME data is always
a string. Treat HTML as untrusted and sanitize it before rendering.

Native/subprocess stdout and stderr are combined in `stderr`. A boundary on the
native-output pipe ensures that a completed subprocess's output is included
before the result returns. Python `input()` receives EOF; use managed executions
for interactive subprocesses, PTYs, background jobs, or streamed output.

## Limits and lifetime

- Code: 16 KiB UTF-8; HTTP JSON body: 32 KiB.
- Execution: 30 seconds by default, 60 seconds maximum, capped at context expiry.
- All returned string contents: 256 KiB UTF-8 combined, including stdout, stderr
  (Python and native output), MIME types/data, and error fields. Truncation sets
  `outputTruncated`. JSON escaping and field names do not count toward this
  content budget; the encoded JSON response also has a 2 MiB bound. At most four
  MIME results are returned. Oversized JSON/HTML/PNG representations are omitted
  whole to preserve valid content; plain text can be shortened.
- Native output ingestion: a separate 1 MiB hard limit; overflow closes the
  context. Native output returned to clients also shares the 256 KiB budget.
- Context: at most 15 minutes or the sandbox's remaining lease, whichever is less.
- A context holds one of the sandbox's four shared operation slots until closed.
- Each context runs one request at a time. Overlap returns `code_context_busy`.

Active execution renews idle activity; an idle interpreter does not keep a
sandbox alive. Timeout, request cancellation, interpreter death, stop, expiration,
or runtime recovery destroys the context. Context memory is not persisted,
snapshotted, or restored. Recovery kills the previous supervised process group;
if cleanup cannot be confirmed, it stops that generation rather than leaving an
unmanaged interpreter running.

List live contexts with `GET /containers/code-contexts`. Release one with
`DELETE /containers/code-contexts/{contextId}`. Listing and cleanup remain
available to the owner during billing outages. Cleanup does not remove files.

Execution is synchronous and is never automatically retried. A lost response
does not prove that code did not execute; reconcile side effects before trying
again. The interpreter provides no security isolation between snippets: code
has the same sandbox privileges as commands, and deliberately detached
processes remain bounded by the sandbox lease.

## SDK examples

```js
const context = await sandbox.code.create();
try {
  await context.run('values = [2, 3, 5]');
  const result = await context.run('sum(values)');
  if (result.error) throw new Error(result.error.message);
  console.log(result.results); // text/plain "10", application/json "10"
} finally {
  await context.close();
}
```

```python
with sandbox.code.create() as context:
    context.run('values = [2, 3, 5]')
    result = context.run('sum(values)', timeout_ms=1000)
    if result['error']:
        raise RuntimeError(result['error']['message'])
    print(result['results'])
```

Use `sandbox.code.list()` to inspect live context metadata and
`sandbox.code.attach(context_id)` to reconnect to a known context within the
same running generation. Attaching does not create or recover an interpreter.

## Verification

`node --test containers/code-contexts.test.mjs` exercises real Python state,
isolation, rich results, exceptions, native output, limits, timeout, concurrent
admission, generation fencing, cancellation, and recovery cleanup.
`npx tsx --test worker/app/code-contexts.test.ts` verifies authentication,
authorization, request limits, and billing-independent cleanup. SDK coverage is
in `sdk/javascript/code.test.mjs` and `sdk/python/test_code.py`.
