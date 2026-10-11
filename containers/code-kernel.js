// The protocol stream is separate from guest stdout. Code executes with the
// sandbox's privileges, not in a Python security sandbox. No dependency install
// or guest file is needed; compatible images need python3 and GNU timeout.
export const PYTHON_KERNEL = String.raw`
import ast, base64, contextlib, io, json, os, sys, traceback
protocol = os.fdopen(os.dup(1), 'w', buffering=1)
requests = sys.stdin
os.dup2(2, 1)
sys.stdin = io.StringIO('')
namespace = {'__name__': '__main__'}
LIMIT = 262144

class Budget:
    def __init__(self):
        self.remaining = LIMIT
        self.truncated = False
    def take(self, value):
        data = value.encode('utf-8', errors='replace')
        allowed = data[:self.remaining]
        self.truncated = self.truncated or len(data) > len(allowed)
        self.remaining -= len(allowed)
        return allowed.decode('utf-8', errors='ignore')

class Output(io.TextIOBase):
    def __init__(self, budget):
        self.budget = budget
        self.parts = []
    def write(self, text):
        value = self.budget.take(str(text))
        if value:
            self.parts.append(value)
        return len(text)
    def flush(self):
        pass

def display(value, budget):
    if value is None:
        return []
    items = [{'mimeType': 'text/plain', 'data': budget.take(repr(value))}]
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode('utf-8')) <= budget.remaining:
            items.append({'mimeType': 'application/json', 'data': budget.take(encoded)})
    except (TypeError, ValueError, OverflowError, RecursionError):
        pass
    for name, mime in [('_repr_html_', 'text/html'), ('_repr_png_', 'image/png')]:
        formatter = getattr(value, name, None)
        if callable(formatter):
            data = formatter()
            if isinstance(data, bytes) and mime == 'image/png':
                data = base64.b64encode(data).decode('ascii')
            if isinstance(data, str):
                if len(data.encode('utf-8')) <= budget.remaining:
                    items.append({'mimeType': mime, 'data': budget.take(data)})
                else:
                    budget.truncated = True
    return items

protocol.write(json.dumps({'ready': True}) + '\n')
for line in requests:
    request = json.loads(line)
    budget = Budget()
    out, err = Output(budget), Output(budget)
    result, error = [], None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            tree = ast.parse(request['code'], filename='<mainbrella>')
            last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, '<mainbrella>', 'exec'), namespace)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), '<mainbrella>', 'eval'), namespace)
                namespace['_'] = value
                result = display(value, budget)
        except BaseException as failure:
            error = {'name': budget.take(type(failure).__name__), 'message': budget.take(str(failure)),
                     'traceback': budget.take(''.join(traceback.format_exception(type(failure), failure, failure.__traceback__)))}
    # The native-output pipe and result pipe can arrive in either order. A
    # per-request boundary lets the host wait for all native output before reply.
    os.write(2, ('\x1e' + request['requestId'] + '\x1f').encode('ascii'))
    protocol.write(json.dumps({'requestId': request['requestId'], 'stdout': ''.join(out.parts),
        'stderr': ''.join(err.parts), 'results': result, 'error': error,
        'outputTruncated': budget.truncated}, ensure_ascii=False) + '\n')
`;
