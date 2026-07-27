#!/usr/bin/env node
import config from '../server/lib/config.js';
import { getStore } from '../server/lib/store.js';

/** Apply any pending SQL migrations. Idempotent — safe to run on every deploy. */

if (!config.db.url) {
  console.error('DATABASE_URL is not set. Nothing to migrate.');
  console.error('Set it in .env, or run without it to use the in-memory store for local development.');
  process.exit(1);
}

const store = await getStore();
try {
  const applied = await store.migrate();
  if (applied.length === 0) console.log('Database is up to date — no migrations to apply.');
  else console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (store.close) await store.close();
}
