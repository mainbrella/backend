"""Local Git conveniences using bounded argv executions, without network operations."""
import hashlib
import re
import uuid

DEFAULTS = ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
            '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false',
            '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false']
ENVIRONMENT = {'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
               'GIT_CONFIG_COUNT': '0', 'GIT_CONFIG_PARAMETERS': '', 'GIT_ATTR_NOSYSTEM': '1',
               'GIT_LFS_SKIP_SMUDGE': '1', 'GIT_OPTIONAL_LOCKS': '0'}


def _bytes(value):
    return len(value.encode('utf-8'))


def _error(code, **details):
    from . import MainbrellaError
    error = MainbrellaError(code)
    for name, value in details.items():
        setattr(error, name, value)
    return error


def _branch(value):
    return (isinstance(value, str) and bool(value) and _bytes(value) <= 255 and value != 'HEAD'
            and not value.startswith('-') and not re.search(r'[\s\x00-\x1f\x7f~^:?*\[\\]', value)
            and '..' not in value and '@{' not in value
            and all(part and not part.startswith('.') and not part.endswith(('.', '.lock')) for part in value.split('/')))


class GitTools:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def _execute(self, operation, argv, cwd, timeout_ms=30000, idempotency_key=None, extra_env=None):
        key = str(uuid.uuid4()) if idempotency_key is None else idempotency_key
        if (not isinstance(cwd, str) or not cwd.startswith('/') or '\0' in cwd or _bytes(cwd) > 4096
                or cwd != '/' and any(part in ('', '.', '..') for part in cwd.split('/')[1:])
                or type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000
                or not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key)):
            raise _error('invalid_git_options')
        config_key = 'git_cfg_' + hashlib.sha256(('git-config:' + key).encode()).hexdigest()
        execution, configuration_execution_id, phase = None, None, 'configuration'
        def run(command, request_key, no_filters=False):
            nonlocal execution
            if _bytes('\0'.join(command)) > 16384:
                raise _error('git_configuration_too_large')
            execution = None
            execution = self.sandbox.commands.start(command, cwd=cwd, timeout_ms=timeout_ms,
                                                    idempotency_key=request_key, env=dict(ENVIRONMENT, **(extra_env or {})))
            result = execution.wait(timeout=timeout_ms / 1000 + 1, poll_interval=.1)
            if result.get('outputTruncated'):
                raise _error('git_output_limit')
            if result.get('timedOut'):
                raise _error('git_timeout')
            if not isinstance(result.get('stdout'), str) or not isinstance(result.get('stderr'), str) or _bytes(result['stdout']) > 1048576:
                raise _error('invalid_git_response')
            if not (result.get('status') == 'succeeded' and result.get('exitCode') == 0) and not (
                    no_filters and result.get('status') == 'failed' and result.get('exitCode') == 1 and not result['stdout'] and not result['stderr']):
                raise _error('git_command_failed', exit_code=result.get('exitCode'), stderr=result['stderr'][:8192])
            return result['stdout']
        try:
            configured = run(DEFAULTS + ['config', '--includes', '--null', '--name-only', '--get-regexp', r'^filter\..*\.(clean|smudge|process|required)$'], config_key, True)
            configuration_execution_id = execution.id
            filters = set()
            if configured and not configured.endswith('\0'):
                raise _error('invalid_git_response')
            for name in filter(None, configured.split('\0')):
                match = re.fullmatch(r'filter\.([^\x00-\x1f\x7f]{1,128})\.(clean|smudge|process|required)', name)
                if not match or len(filters) >= 32 and match[1] not in filters:
                    raise _error('git_configuration_too_large')
                filters.add(match[1])
            overrides = []
            for name in sorted(filters):
                for field in ('clean', 'smudge', 'process', 'required'):
                    overrides += ['-c', 'filter.' + name + '.' + field + '=' + ('false' if field == 'required' else '')]
            phase = 'operation'
            stdout = run(DEFAULTS + overrides + argv, key)
            return {'stdout': stdout, 'executionId': execution.id, 'idempotencyKey': key}
        except Exception as error:
            error.git_operation, error.idempotency_key, error.configuration_key = operation, key, config_key
            error.git_phase = phase
            if configuration_execution_id:
                error.configuration_execution_id = configuration_execution_id
            if execution:
                error.execution_id = execution.id
            raise

    def status(self, *, cwd, timeout_ms=30000, idempotency_key=None):
        result = self._execute('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], cwd, timeout_ms, idempotency_key)
        stdout = result.pop('stdout')
        if stdout and not stdout.endswith('\0'):
            raise _error('invalid_git_response', **result)
        fields, entries = stdout.split('\0')[:-1], []
        while fields:
            field = fields.pop(0)
            if not re.fullmatch(r'[ MADRCUT?!]{2} .+', field, re.S):
                raise _error('invalid_git_response', **result)
            entry = {'indexStatus': field[0], 'worktreeStatus': field[1], 'path': field[3:]}
            if 'R' in field[:2] or 'C' in field[:2]:
                if not fields or not fields[0]:
                    raise _error('invalid_git_response', **result)
                entry['originalPath'] = fields.pop(0)
            entries.append(entry)
        return dict(result, entries=entries)

    def branches(self, *, cwd, timeout_ms=30000, idempotency_key=None):
        result = self._execute('branches', ['for-each-ref', '--format=%(refname:lstrip=2)%00%(objectname)%00%(HEAD)', 'refs/heads/'], cwd, timeout_ms, idempotency_key)
        branches = []
        for line in result.pop('stdout').splitlines():
            parts = line.split('\0')
            if len(parts) != 3 or not _branch(parts[0]) or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', parts[1]) or parts[2] not in ('*', ' '):
                raise _error('invalid_git_response', **result)
            branches.append({'name': parts[0], 'commit': parts[1], 'current': parts[2] == '*'})
        return dict(result, branches=branches)

    def diff(self, *, cwd, staged=False, paths=None, timeout_ms=30000, idempotency_key=None):
        paths = [] if paths is None else paths
        if type(staged) is not bool or not isinstance(paths, list) or len(paths) > 64 or any(
                not isinstance(path, str) or not path or '\0' in path or _bytes(path) > 4096 for path in paths):
            raise _error('invalid_git_options')
        result = self._execute('diff', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'] + (['--cached'] if staged else []) + ['--'] + paths, cwd, timeout_ms, idempotency_key)
        result['patch'] = result.pop('stdout')
        return result

    def commit(self, *, cwd, message, author, idempotency_key, timeout_ms=30000):
        if (not isinstance(message, str) or not message.strip() or '\0' in message or _bytes(message) > 8192
                or not isinstance(author, dict) or not isinstance(author.get('name'), str) or not author['name'].strip()
                or _bytes(author['name']) > 256 or re.search(r'[<>\x00-\x1f\x7f]', author['name'])
                or not isinstance(author.get('email'), str) or not re.fullmatch(r'[^\s<>\x00-\x1f\x7f]+@[^\s<>\x00-\x1f\x7f]+', author['email'])
                or _bytes(author['email']) > 254 or idempotency_key is None):
            raise _error('invalid_git_options')
        result = self._execute('commit', ['commit', '--quiet', '--no-gpg-sign', '--no-verify', '--message', message], cwd, timeout_ms, idempotency_key,
                               {'GIT_AUTHOR_NAME': author['name'], 'GIT_AUTHOR_EMAIL': author['email'], 'GIT_COMMITTER_NAME': author['name'], 'GIT_COMMITTER_EMAIL': author['email']})
        result.pop('stdout')
        return dict(result, committed=True)

    def checkout(self, *, cwd, branch, idempotency_key, create=False, timeout_ms=30000):
        if not _branch(branch) or type(create) is not bool or idempotency_key is None:
            raise _error('invalid_git_options')
        argv = ['switch', '--no-guess', '--no-recurse-submodules'] + (['--no-track', '--create', branch, '--'] if create else ['--', branch])
        result = self._execute('checkout', argv, cwd, timeout_ms, idempotency_key)
        result.pop('stdout')
        return dict(result, branch=branch)
