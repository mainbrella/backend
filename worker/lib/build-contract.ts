import { z } from 'zod';

export const BUILD_MODEL = '@cf/zai-org/glm-5.3';
export const BUILD_MAX_APPS = 50;
export const BUILD_MAX_TURNS = 100;
export const BUILD_MAX_SOURCE_BYTES = 256 * 1024;
export const BUILD_MAX_FILE_BYTES = 64 * 1024;
export const BUILD_MAX_FILES = 80;
export const BUILD_MAX_ROUNDS = 16;
export const BUILD_OUTPUT_BUDGET = 24_000;
export const BUILD_INPUT_BUDGET = 240_000;
export const buildPrompt = z.string().trim().min(1).max(6000);
const modelOptions = { model: z.string().min(1).max(120).optional(), effort: z.string().min(1).max(20).optional() };
export const buildCreateSchema = z.object({ prompt: buildPrompt, ...modelOptions }).strict();
export const buildTurnSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('build'), prompt: buildPrompt, ...modelOptions, revision: z.number().int().min(0) }).strict(),
  z.object({ mode: z.literal('preview'), revision: z.number().int().min(1) }).strict(),
]);
export const buildRenameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type BuildFiles = Record<string, string>;
export type BuildContainer = { id: string; createdAt: string; expiresAt: string };
export type BuildPreview = { id: string; url: string; expiresAt: number };
export type BuildParams = { appId: string; userId: string; turnId: string };
export interface BuildAppRow {
  id: string; user_id: string; name: string; initial_prompt: string; create_key: string;
  source_json: string; revision: number; active_turn_id: string | null;
  container_json: string | null; preview_json: string | null; created_at: string; updated_at: string;
}
export interface BuildTurnRow {
  id: string; app_id: string; user_id: string; request_key: string; prompt: string; mode: 'build' | 'preview';
  base_revision: number; log: string; failure_operation_id?: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed'; stage: string; summary: string | null; error: string | null;
  model: string; effort?: string | null; input_tokens: number; output_tokens: number; created_at: string; finished_at: string | null;
}
export class BuildError extends Error {
  classification: 'provider' | 'parser' | 'infrastructure' | 'validation' = 'infrastructure';
  providerCode?: string;
  operationId?: string;
  constructor(message: string, public status = 503, public details?: string) { super(message); }
}
export const ownedBuildApp = (env: Env, userId: string, id: string) => env.DB.prepare('SELECT * FROM build_apps WHERE user_id = ? AND id = ?').bind(userId, id).first<BuildAppRow>();
export function buildName(prompt: string) {
  const first = prompt.split(/\r?\n/)[0].replace(/\s+/g, ' ');
  return first.length > 64 ? `${first.slice(0, 61).trimEnd()}…` : first;
}
export function validBuildPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 160 && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
    && !path.split('/').some(part => ['node_modules', 'dist', 'package-lock.json'].includes(part));
}
export function validateBuildFiles(files: unknown): asserts files is BuildFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new BuildError('invalid_source', 400);
  const entries = Object.entries(files);
  const encoder = new TextEncoder();
  if (entries.length > BUILD_MAX_FILES || entries.some(([path, content]) => !validBuildPath(path)
    || typeof content !== 'string' || encoder.encode(content).length > BUILD_MAX_FILE_BYTES)
    || encoder.encode(JSON.stringify(files)).length > BUILD_MAX_SOURCE_BYTES) throw new BuildError('source_limit', 413);
}
export const buildStarter: BuildFiles = {
  'package.json': JSON.stringify({ name: 'mainbrella-app', version: '1.0.0', private: true, type: 'module',
    scripts: { dev: 'vite --host 0.0.0.0', build: 'tsc --noEmit && vite build', preview: 'vite preview --host 0.0.0.0' },
    dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0', 'lucide-react': '^0.468.0' },
    devDependencies: { '@types/react': '^19.2.0', '@types/react-dom': '^19.2.0', typescript: '^5.9.3', vite: '^7.1.4' },
  }, null, 2),
  'index.html': '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>My app</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true,
    allowImportingTsExtensions: true, esModuleInterop: true }, include: ['src'] }, null, 2),
  'src/main.tsx': "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n",
  'src/App.tsx': "export default function App() { return <main><h1>My app</h1></main>; }\n",
  'src/style.css': '* { box-sizing: border-box; } body { margin: 0; font-family: system-ui, sans-serif; } button, input, select, textarea { font: inherit; }',
};
