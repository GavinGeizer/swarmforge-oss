import { Miniflare } from 'miniflare';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupTestEnv() {
  const mf = new Miniflare({
    scriptPath: join(__dirname, '../src/index.ts'),
    modules: true,
    d1Databases: { DB: 'test-db' },
    bindings: {
      APP_ORIGIN: 'https://app.example.com',
      WEBSITE_ORIGIN: 'https://website.example.com',
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
      AUTH_SECRET: 'a'.repeat(32),
      ENVIRONMENT: 'local',
    },
  });

  const env = mf.getBindings();
  const migration = readFileSync(join(__dirname, '../migrations/0001_schema.sql'), 'utf-8');
  await mf.d1('DB').exec(migration);

  return { mf, env };
}

async function cleanupTestEnv({ mf }: { mf: Miniflare }) {
  await mf.dispose();
}

export { setupTestEnv, cleanupTestEnv };
