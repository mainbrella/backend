import { z } from 'zod';

export const repoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]));
export const repoRef = z.string().min(1).max(200).refine(value => !/[\x00-\x20\x7f]/.test(value));
export const repoCwd = z.string().max(200).refine(value => value === '.' ||
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..'));
const command = z.string().trim().min(1).max(4096).refine(value => !value.includes('\0'));
export const launchOptionsSchema = z.object({
  repo: repoName, ref: repoRef.optional(), catalogId: z.enum(['node', 'python', 'rust', 'go', 'devops']).optional(),
  size: z.enum(['lite', 'small', 'medium', 'large', 'xl']).default('small'), cwd: repoCwd.default('.'),
  setupCommand: command.optional(), startCommand: command.optional(), port: z.number().int().min(1024).max(65535).optional(),
}).strict().refine(value => Boolean(value.startCommand) === (value.port !== undefined), { message: 'startCommand and port must be supplied together' });
export type LaunchOptions = z.infer<typeof launchOptionsSchema>;
export interface ResolvedRepo { repo: string; ref: string; commit: string; suggestedCatalogId: string; manifests: string[] }
interface GithubDiagnostic {
  dependency: 'github'; operation: 'repository' | 'commit' | 'tree';
  upstreamStatus?: number; upstreamRequestId?: string | null;
  rateLimitRemaining?: string | null; rateLimitReset?: string | null; retryAfter?: string | null;
  upstreamMessage?: string; reason?: string;
}
export class LaunchError extends Error {
  constructor(message: string, public status = 503, options?: ErrorOptions & { diagnostics?: GithubDiagnostic }) {
    super(message, options);
    this.name = 'LaunchError';
    this.diagnostics = options?.diagnostics;
  }
  readonly diagnostics?: GithubDiagnostic;
}

// Keep full diagnostics in Worker logs, never in the public error response.
export function launchErrorDetails(error: unknown, redactions: string[] = [], depth = 0): Record<string, unknown> {
  const scrub = (text: string) => {
    for (const value of redactions) if (value) text = text.replaceAll(value, '[redacted]');
    return text.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:mb_[a-f0-9]{64}|sk_(?:live|test)_[A-Za-z0-9_]+)\b/gi, '[redacted]').slice(0, 4000);
  };
  if (!(error instanceof Error)) return { name: 'UnknownError', message: 'Non-Error exception' };
  return { name: error.name, message: scrub(error.message), ...(error.stack ? { stack: scrub(error.stack) } : {}),
    ...(error instanceof LaunchError && error.diagnostics ? { diagnostics: Object.fromEntries(Object.entries(error.diagnostics)
      .map(([key, value]) => [key, typeof value === 'string' ? scrub(value) : value])) } : {}),
    ...(error.cause !== undefined && depth < 3 ? { cause: launchErrorDetails(error.cause, redactions, depth + 1) } : {}) };
}

async function github(path: string, missing: string): Promise<any> {
  const diagnostics: GithubDiagnostic = { dependency: 'github',
    operation: path.includes('/git/trees/') ? 'tree' : path.includes('/commits/') ? 'commit' : 'repository' };
  let response;
  try {
    // Workers supports manual redirects; non-2xx responses below remain failures.
    response = await fetch(`https://api.github.com${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella-repo-launch', 'X-GitHub-Api-Version': '2026-03-10' } });
  } catch (cause) { throw new LaunchError('github_unavailable', 503, { cause, diagnostics }); }
  Object.assign(diagnostics, { upstreamStatus: response.status, upstreamRequestId: response.headers.get('x-github-request-id'),
    rateLimitRemaining: response.headers.get('x-ratelimit-remaining'), rateLimitReset: response.headers.get('x-ratelimit-reset'),
    retryAfter: response.headers.get('retry-after') });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    if (typeof body?.message === 'string') diagnostics.upstreamMessage = body.message.slice(0, 1000);
    const error = response.status === 404 || response.status === 409 || response.status === 422 ? missing
      : response.status === 403 || response.status === 429 ? 'github_rate_limited' : 'github_unavailable';
    throw new LaunchError(error, error === missing ? 400 : error === 'github_rate_limited' ? 429 : 503, { diagnostics });
  }
  try { return await response.json(); }
  catch (cause) { throw new LaunchError('github_unavailable', 503, { cause, diagnostics: { ...diagnostics, reason: 'invalid_json' } }); }
}

export async function resolvePublicRepo(repo: string, ref?: string, cwd = '.'): Promise<ResolvedRepo> {
  const metadata = await github(`/repos/${repo}`, 'public_repo_not_found');
  if (metadata.private !== false || metadata.disabled || !repoName.safeParse(metadata.full_name).success) throw new LaunchError('public_repo_not_found', 400);
  const canonical = metadata.full_name as string;
  const resolvedRef = ref ?? metadata.default_branch;
  if (!repoRef.safeParse(resolvedRef).success) throw new LaunchError('repo_ref_not_found', 400);
  const commit = await github(`/repos/${canonical}/commits/${encodeURIComponent(resolvedRef)}?per_page=1`, 'repo_ref_not_found');
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha)) throw new LaunchError('github_unavailable');
  let tree = await github(`/repos/${canonical}/git/trees/${commit.commit.tree.sha}`, 'repo_ref_not_found');
  if (cwd !== '.') {
    for (const part of cwd.split('/')) {
      const directory = tree.tree?.find((entry: any) => entry.path === part && entry.type === 'tree');
      if (!directory || !/^[a-f0-9]{40}$/.test(directory.sha)) throw new LaunchError('repo_directory_not_found', 400);
      tree = await github(`/repos/${canonical}/git/trees/${directory.sha}`, 'repo_directory_not_found');
    }
  }
  if (!Array.isArray(tree.tree)) throw new LaunchError('github_unavailable');
  const files = new Set<string>(tree.tree.filter((entry: any) => entry.type === 'blob').map((entry: any) => entry.path));
  const candidates = [ ['node', ['package.json']], ['python', ['pyproject.toml', 'requirements.txt', 'Pipfile']],
    ['rust', ['Cargo.toml']], ['go', ['go.mod']], ['devops', ['main.tf', 'terraform.tf']] ] as const;
  const matches = candidates.filter(([, manifests]) => manifests.some(file => files.has(file)));
  return { repo: canonical, ref: resolvedRef, commit: commit.sha, suggestedCatalogId: matches.length === 1 ? matches[0][0] : 'node',
    manifests: candidates.flatMap(([, manifests]) => [...manifests]).filter(file => files.has(file)) };
}

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function cloneCommand(repo: ResolvedRepo): string {
  return `set -eu
export GIT_TERMINAL_PROMPT=0
mkdir -p /workspace/repo
cd /workspace/repo
git init -q
git remote add origin ${shellQuote(`https://github.com/${repo.repo}.git`)}
git -c credential.helper= fetch --depth=1 origin ${shellQuote(repo.commit)}
git checkout -q --detach FETCH_HEAD
tmux new-session -d -s main -c /workspace/repo /bin/bash
printf 'Repository ready at %s\\n' ${shellQuote(repo.commit)}`;
}
const directory = (options: LaunchOptions) => `/workspace/repo${options.cwd === '.' ? '' : '/' + options.cwd}`;
const inDirectory = (options: LaunchOptions) => `set -eu\ncd ${shellQuote(directory(options))}\ncase "$(pwd -P)" in /workspace/repo|/workspace/repo/*) ;; *) exit 1 ;; esac\n`;
export function setupCommand(options: LaunchOptions): string {
  return inDirectory(options) + `exec /bin/bash -lc ${shellQuote(options.setupCommand!)}`;
}
export function previewCommand(options: LaunchOptions): string {
  const server = `/bin/bash -lc ${shellQuote(options.startCommand!)} >> /workspace/.mainbrella-preview.log 2>&1`;
  return inDirectory(options) + `tmux new-session -d -s mainbrella-preview -c ${shellQuote(directory(options))} /bin/bash -lc ${shellQuote(server)}
for attempt in $(seq 1 60); do
  if curl --fail --silent --output /dev/null --max-time 2 http://127.0.0.1:${options.port}/; then
    printf 'Preview ready on port ${options.port}\\n'
    exit 0
  fi
  if ! tmux has-session -t mainbrella-preview 2>/dev/null; then break; fi
  sleep 1
done
tail -c 16384 /workspace/.mainbrella-preview.log || true
printf 'Preview did not become ready. Check /workspace/.mainbrella-preview.log\\n' >&2
exit 1`;
}
