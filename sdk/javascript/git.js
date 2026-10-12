const bytes = value => new TextEncoder().encode(value).length;
const defaults = ['git', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-c', 'submodule.recurse=false',
  '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false'];
const environment = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_ATTR_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' };
const validPath = path => typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && bytes(path) <= 4096
  && (path === '/' || path.split('/').slice(1).every(part => part && part !== '.' && part !== '..'));
const validBranch = branch => typeof branch === 'string' && bytes(branch) <= 255 && branch && branch !== 'HEAD'
  && !branch.startsWith('-') && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) && !branch.includes('..') && !branch.includes('@{')
  && branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));

export function gitTools(sandbox, ErrorType) {
  const error = (code, details = {}) => Object.assign(new ErrorType(code), details);
  async function execute(operation, argv, options, extraEnv = {}) {
    const { cwd, timeoutMs = 30000, idempotencyKey = crypto.randomUUID() } = options;
    if (!validPath(cwd) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
      || typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) throw error('invalid_git_options');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`git-config:${idempotencyKey}`));
    const configKey = 'git_cfg_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    let execution, configurationExecutionId, phase = 'configuration';
    async function run(command, key, noFilters = false) {
      if (bytes(command.join('\0')) > 16384) throw error('git_configuration_too_large');
      execution = undefined;
      execution = await sandbox.commands.start(command, { cwd, timeoutMs, idempotencyKey: key, env: { ...environment, ...extraEnv } });
      const result = await execution.wait({ timeoutMs: timeoutMs + 1000, pollIntervalMs: 100 });
      if (result.outputTruncated) throw error('git_output_limit');
      if (result.timedOut) throw error('git_timeout');
      if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || bytes(result.stdout) > 1048576) throw error('invalid_git_response');
      if (!(result.status === 'succeeded' && result.exitCode === 0)
        && !(noFilters && result.status === 'failed' && result.exitCode === 1 && !result.stdout && !result.stderr)) {
        throw error('git_command_failed', { exitCode: result.exitCode, stderr: result.stderr.slice(0, 8192) });
      }
      return result.stdout;
    }
    try {
      // Read names only: credential values never enter SDK output or filter overrides.
      const configured = await run([...defaults, 'config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], configKey, true);
      configurationExecutionId = execution.id;
      const filters = new Set();
      if (configured && !configured.endsWith('\0')) throw error('invalid_git_response');
      for (const name of configured.split('\0').filter(Boolean)) {
        const match = /^filter\.([^\x00-\x1f\x7f]{1,128})\.(clean|smudge|process|required)$/.exec(name);
        if (!match || filters.size >= 32 && !filters.has(match[1])) throw error('git_configuration_too_large');
        filters.add(match[1]);
      }
      const overrides = [...filters].sort().flatMap(name => ['clean', 'smudge', 'process', 'required'].flatMap(field =>
        ['-c', `filter.${name}.${field}=${field === 'required' ? 'false' : ''}`]));
      phase = 'operation';
      const stdout = await run([...defaults, ...overrides, ...argv], idempotencyKey);
      return { stdout, executionId: execution.id, idempotencyKey };
    } catch (failure) {
      failure.gitOperation = operation; failure.idempotencyKey = idempotencyKey;
      failure.configurationKey = configKey;
      failure.gitPhase = phase;
      if (configurationExecutionId) failure.configurationExecutionId = configurationExecutionId;
      if (execution) failure.executionId = execution.id;
      throw failure;
    }
  }
  return {
    async status(options = {}) {
      const { stdout, ...identity } = await execute('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], options);
      if (stdout && !stdout.endsWith('\0')) throw error('invalid_git_response', identity);
      const fields = stdout.split('\0'); fields.pop();
      const entries = [];
      while (fields.length) {
        const field = fields.shift();
        if (!/^[ MADRCUT?!]{2} .+$/s.test(field)) throw error('invalid_git_response', identity);
        const entry = { indexStatus: field[0], worktreeStatus: field[1], path: field.slice(3) };
        if (/[RC]/.test(field.slice(0, 2))) {
          entry.originalPath = fields.shift();
          if (!entry.originalPath) throw error('invalid_git_response', identity);
        }
        entries.push(entry);
      }
      return { entries, ...identity };
    },
    async branches(options = {}) {
      const { stdout, ...identity } = await execute('branches', ['for-each-ref', '--format=%(refname:lstrip=2)%00%(objectname)%00%(HEAD)', 'refs/heads/'], options);
      const branches = stdout.split('\n').filter(Boolean).map(line => {
        const [name, commit, current, ...extra] = line.split('\0');
        if (extra.length || !validBranch(name) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !['*', ' '].includes(current)) throw error('invalid_git_response', identity);
        return { name, commit, current: current === '*' };
      });
      return { branches, ...identity };
    },
    async diff({ staged = false, paths = [], ...options } = {}) {
      if (typeof staged !== 'boolean' || !Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || !path || path.includes('\0') || bytes(path) > 4096)) throw error('invalid_git_options');
      const { stdout: patch, ...identity } = await execute('diff', ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', ...(staged ? ['--cached'] : []), '--', ...paths], options);
      return { patch, ...identity };
    },
    async commit({ message, author, ...options } = {}) {
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || bytes(message) > 8192 || !author
        || typeof author.name !== 'string' || !author.name.trim() || bytes(author.name) > 256 || /[<>\x00-\x1f\x7f]/.test(author.name)
        || typeof author.email !== 'string' || !/^[^\s<>\x00-\x1f\x7f]+@[^\s<>\x00-\x1f\x7f]+$/.test(author.email) || bytes(author.email) > 254
        || options.idempotencyKey === undefined) throw error('invalid_git_options');
      const { stdout, ...identity } = await execute('commit', ['commit', '--quiet', '--no-gpg-sign', '--no-verify', '--message', message], options,
        { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email });
      return { committed: true, ...identity };
    },
    async checkout({ branch, create = false, ...options } = {}) {
      if (!validBranch(branch) || typeof create !== 'boolean' || options.idempotencyKey === undefined) throw error('invalid_git_options');
      const { stdout, ...identity } = await execute('checkout', ['switch', '--no-guess', '--no-recurse-submodules', ...(create ? ['--no-track', '--create', branch, '--'] : ['--', branch])], options);
      return { branch, ...identity };
    },
  };
}
