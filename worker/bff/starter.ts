import { checksum, type Project } from './contracts';
import { ProjectDatabase } from './database';
import { migrate } from './migrations';

export const messageBoardMigration = {
  sequence: 1,
  name: 'message_board',
  sql: `CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX messages_user ON messages(user_id);
CREATE INDEX messages_created ON messages(created_at);
INSERT INTO users(id,name) VALUES('alice','Alice'),('bob','Bob');
INSERT INTO messages(id,user_id,body) VALUES
  ('welcome','alice','Welcome to the message board! Everyone can read messages. Try editing this as Alice.'),
  ('reply','bob','Hi Alice! Switch to Bob to edit or delete this message. Each user can only change their own posts.');`,
};

const functions = [
  { name: 'list_messages', access: 'read', source: `export default async function(input, ctx) {
  return (await ctx.db.select('messages', {}, 100)).results;
}` },
  { name: 'post_message', access: 'write', source: `export default async function(input, ctx) {
  if (!ctx.user) throw new Error('Sign in to post a message.');
  if (typeof input?.body !== 'string' || !input.body.trim() || input.body.trim().length > 2000) throw new Error('Enter a message of 1–2000 characters.');
  return (await ctx.db.insert('messages', { user_id: ctx.user.id, body: input.body.trim() })).results;
}` },
  { name: 'edit_message', access: 'write', source: `export default async function(input, ctx) {
  if (!ctx.user) throw new Error('Sign in to edit a message.');
  if (typeof input?.id !== 'string' || !input.id) throw new Error('Choose a message.');
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.trim().length > 2000) throw new Error('Enter a message of 1–2000 characters.');
  return (await ctx.db.update('messages', { id: input.id }, { body: input.body.trim() })).results;
}` },
  { name: 'delete_message', access: 'write', source: `export default async function(input, ctx) {
  if (!ctx.user) throw new Error('Sign in to delete a message.');
  if (typeof input?.id !== 'string' || !input.id) throw new Error('Choose a message.');
  return ctx.db.remove('messages', { id: input.id });
}` },
];

export async function installMessageBoard(env: Env, project: Project, db: ProjectDatabase) {
  await migrate(db, messageBoardMigration);
  const created = new Date().toISOString();
  // Provisioning can resume after either database has committed. Do not replace
  // policies or immutable function versions on retries.
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO bff_table_policies
      (project_id,table_name,select_access,insert_access,update_access,delete_access,owner_column,updated_at)
      VALUES(?,'users','public','none','none','none',NULL,?)`).bind(project.id, created),
    env.DB.prepare(`INSERT OR IGNORE INTO bff_table_policies
      (project_id,table_name,select_access,insert_access,update_access,delete_access,owner_column,updated_at)
      VALUES(?,'messages','public','own','own','own','user_id',?)`).bind(project.id, created),
  ];
  for (const fn of functions) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO bff_function_versions
    (project_id,name,version,source,checksum,database_access,created_at) VALUES(?,?,1,?,?,?,?)`)
    .bind(project.id, fn.name, fn.source, await checksum(fn.source), fn.access, created));
  await env.DB.batch(statements);
}
