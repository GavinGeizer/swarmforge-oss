import { Miniflare } from 'miniflare';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TestEnv {
  DB: D1Database;
  APP_ORIGIN: string;
  WEBSITE_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  AUTH_SECRET: string;
  ENVIRONMENT: 'local';
}

describe('Cloud Identity API', () => {
  let mf: Miniflare;
  let env: TestEnv;

  beforeAll(async () => {
    const workerPath = join(__dirname, '../src/index.ts');
    
    mf = new Miniflare({
      scriptPath: workerPath,
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

    env = mf.getBindings();

    // Run migration
    const migration = readFileSync(join(__dirname, '../migrations/0001_schema.sql'), 'utf-8');
    await mf.d1('DB').exec(migration);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  describe('GET /health', () => {
    it('returns health status', async () => {
      const res = await mf.dispatchFetch('http://localhost/health');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('GET /ready', () => {
    it('returns readiness status', async () => {
      const res = await mf.dispatchFetch('http://localhost/ready');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.checks.database).toBe(true);
      expect(data.checks.schema).toBe(true);
    });
  });

  describe('POST /v1/auth/github', () => {
    it('returns OAuth authorization URL', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/auth/github', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.auth_url).toContain('github.com/login/oauth/authorize');
      expect(data.state).toBeDefined();
      expect(data.browser_id).toBeDefined();
    });
  });

  describe('GET /v1/me without session', () => {
    it('returns 401 unauthenticated', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('unauthenticated');
    });
  });

  describe('GET /v1/sessions without session', () => {
    it('returns 401 unauthenticated', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/sessions', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/session without session', () => {
    it('returns 401 unauthenticated', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/session', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/unknown');
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('not_found');
    });

    it('returns 404 for billing routes', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/tenants/test/billing');
      expect(res.status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('rejects requests without Origin header for protected routes', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me');
      expect(res.status).toBe(401);
    });

    it('allows preflight OPTIONS', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me', {
        method: 'OPTIONS',
        headers: { 
          'Origin': 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });
      expect(res.status).toBe(200);
    });
  });
});
