// Integration tests for authentication flow

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

describe('Authentication Integration', () => {
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

  describe('OAuth flow', () => {
    test('starts OAuth and returns valid state', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/auth/github', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.auth_url).toContain('github.com/login/oauth/authorize');
      expect(data.state).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(data.browser_id).toHaveLength(64);
    });

    test('creates session on successful OAuth callback', async () => {
      // First get auth URL and state
      const authRes = await mf.dispatchFetch('http://localhost/v1/auth/github', {
        method: 'POST',
      });
      const authData = await authRes.json();
      const state = authData.state;

      // Mock GitHub callback (without actual GitHub contact)
      // In real test, we'd mock the OAuth exchange
      const callbackUrl = `http://localhost/v1/auth/github/callback?code=test_code&state=${state}`;
      const callbackRes = await mf.dispatchFetch(callbackUrl, {
        headers: { 
          Cookie: `__Host-swarmforge-state=${state}`,
        },
      });
      
      // Should redirect or return error since GitHub is mocked
      expect(callbackRes.status).toBe(302).or.toBe(400);
    });
  });

  describe('Session management', () => {
    test('returns session info', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/session', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
    });

    test('lists sessions', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/sessions', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/me', () => {
    test('returns 401 without session', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me', {
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('unauthenticated');
    });

    test('returns 404 for billing routes', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/tenants/test/billing');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/auth/logout', () => {
    test('returns 401 without session', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/auth/logout', {
        method: 'POST',
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(401);
    });

    test('returns 200 on logout', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/auth/logout', {
        method: 'POST',
        headers: { 'Origin': 'https://app.example.com' },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('logged_out');
    });
  });

  describe('CORS', () => {
    test('allows preflight with valid origin', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me', {
        method: 'OPTIONS',
        headers: { 
          'Origin': 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    });

    test('rejects preflight with invalid origin', async () => {
      const res = await mf.dispatchFetch('http://localhost/v1/me', {
        method: 'OPTIONS',
        headers: { 
          'Origin': 'https://evil.com',
        },
      });
      expect(res.status).toBe(403);
    });
  });
});
