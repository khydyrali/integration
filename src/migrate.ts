import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPool, tx, type Db } from './db.js';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const LOCK_ID = 727_001;

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  await tx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await c.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await c.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      log(`applied migration ${file}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createPool(process.env.DATABASE_URL ?? '');
  migrate(db)
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
