// Cloud Identity Worker - Single file implementation
// @cloudflare/workers-types compatible

function generateRandomHex(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createHmac(key, data) {
  const encoder = new TextEncoder();
  const keyBuffer = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', keyBuffer, encoder.encode(data));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateRequestId() {
  return generateRandomHex(32);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, x-csrf-token, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function getValidOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  
  const appOrigin = env.APP_ORIGIN.replace(/\/$/, '');
  const websiteOrigin = env.WEBSITE_ORIGIN.replace(/\/$/, '');
  
  if (origin === appOrigin || origin === websiteOrigin) {
    return origin;
  }
  return null;
}

async function handleHealth() {
  return new Response(
    JSON.stringify({ status: 'ok', version: '0.1.0' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleReady(env, db) {
  const checks = { schema: true, database: true, oauth_config: true };

  try {
    await db.query('SELECT 1');
  } catch {
    checks.database = false;
  }

  try {
    await db.query('SELECT name FROM sqlite_master WHERE type="table"');
  } catch {
    checks.schema = false;
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.AUTH_SECRET) {
    checks.oauth_config = false;
  }

  const status = checks.schema && checks.database && checks.oauth_config ? 'ok' : 'unavailable';
  const statusCode = status === 'ok' ? 200 : 503;

  return new Response(
    JSON.stringify({ status, checks }),
    { status: statusCode, headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleGitHubAuth(env) {
  console.log('handleGitHubAuth called');
  const state = generateRandomHex(32);
  const browserId = generateRandomHex(32);
  const verifier = generateRandomHex(64);
  const createdAt = Date.now();
  const expiresAt = createdAt + 10 * 60 * 1000;

  console.log('Generated state/browser/verifier');
  const stateData = `${state}:${browserId}`;
  const stateHash = await sha256(stateData);
  const verifierEncrypted = await createHmac(env.AUTH_SECRET, verifier);

  console.log('Inserting into DB');
  await env.DB.prepare(
    'INSERT INTO oauth_transactions (id, state_hash, browser_id, verifier_encrypted, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(generateRandomHex(16), stateHash, browserId, verifierEncrypted, expiresAt, createdAt).run();

  console.log('Generating auth URL');
  const challenge = await sha256(verifier);
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${env.APP_ORIGIN}/v1/auth/github/callback`)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=read:user`;

  console.log('Returning response');
  return new Response(
    JSON.stringify({ auth_url: authUrl, state, browser_id: browserId }),
    { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Set-Cookie': `__Host-swarmforge-state=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      } 
    }
  );
}

async function handleGitHubCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const requestState = request.headers.get('Cookie');

  if (!code || !state) {
    return new Response(
      JSON.stringify({ error: { code: 'invalid_callback', message: 'Missing code or state' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stateMatch = requestState?.match(/__Host-swarmforge-state=([^;]+)/);
  if (!stateMatch || stateMatch[1] !== state) {
    return new Response(
      JSON.stringify({ error: { code: 'invalid_state', message: 'State mismatch' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ redirect: `${env.APP_ORIGIN}/v1/me` }),
    { 
      status: 302, 
      headers: { 
        'Location': `${env.APP_ORIGIN}/v1/me`,
        'Content-Type': 'application/json',
      } 
    }
  );
}

async function getSessionFromCookie(cookieHeader, db) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/__Host-swarmforge=([^;]+)/);
  if (!match) return null;

  const token = match[1];
  const session = await db.queryOne(
    'SELECT id, user_id, csrf_token, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
    [await sha256(token)]
  );

  if (!session) return null;
  if (session.revoked_at !== null || session.expires_at < Date.now()) return null;

  return { session, token };
}

async function handleMe(env, request, db, validOrigin, cookieHeader) {
  if (!validOrigin) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthenticated', message: 'Missing Origin header' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const session = await getSessionFromCookie(cookieHeader, db);
  if (!session) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthenticated', message: 'Invalid or expired session' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const user = await db.queryOne(
    'SELECT id, status FROM users WHERE id = ?',
    [session.session.user_id]
  );

  if (!user || user.status === 'disabled') {
    return new Response(
      JSON.stringify({ error: { code: 'account_disabled', message: 'Account is disabled' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const memberships = await db.query(
    'SELECT o.id as tenant_id, m.role FROM org_memberships m JOIN organizations o ON m.org_id = o.id WHERE m.user_id = ? AND m.status = ? AND o.status = ?',
    [session.session.user_id, 'active', 'active']
  );

  return new Response(
    JSON.stringify({
      subject_id: user.id,
      display_name: user.id,
      memberships,
      next_cursor: null,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleLogout(env, request, db, validOrigin, cookieHeader) {
  if (!validOrigin) {
    return new Response(
      JSON.stringify({ error: { code: 'unauthenticated', message: 'Missing Origin header' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const session = await getSessionFromCookie(cookieHeader, db);
  if (session) {
    await db.exec('DELETE FROM sessions WHERE id = ?', [session.session.id]);
  }

  return new Response(
    JSON.stringify({ status: 'logged_out' }),
    { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Set-Cookie': '__Host-swarmforge=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
      } 
    }
  );
}

function handleNotFound() {
  const requestId = generateRequestId();
  return new Response(
    JSON.stringify({
      error: {
        code: 'not_found',
        message: 'Route not found',
        request_id: requestId,
      },
    }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleRequest(request, env) {
  const validOrigin = getValidOrigin(request, env);
  const cookieHeader = request.headers.get('Cookie');
  const db = new Database(env.DB);

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health') return handleHealth();
  if (path === '/ready') return handleReady(env, db);
  if (path === '/v1/auth/github' && request.method === 'POST') return handleGitHubAuth(env);
  if (path === '/v1/auth/github/callback' && request.method === 'GET') return handleGitHubCallback(env, request);
  if (path === '/v1/auth/logout' && request.method === 'POST') return handleLogout(env, request, db, validOrigin, cookieHeader);
  if (path === '/v1/me') return handleMe(env, request, db, validOrigin, cookieHeader);
  
  return handleNotFound();
}

class Database {
  constructor(db) { this.db = db; }
  async query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const result = params.length > 0 ? stmt.bind(...params) : stmt.bind();
    return (await result.all()).results;
  }
  async queryOne(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return (params.length > 0 ? stmt.bind(...params) : stmt.bind()).first();
  }
  async exec(sql, params = []) {
    return params.length > 0 ? this.db.prepare(sql).bind(...params).run() : this.db.exec(sql);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      const validOrigin = getValidOrigin(request, env);
      if (!validOrigin) return new Response(null, { status: 403 });
      return new Response(null, { headers: { ...corsHeaders(validOrigin), ...securityHeaders() } });
    }

    try {
      const response = await handleRequest(request, env);
      const validOrigin = getValidOrigin(request, env);
      const headers = { ...response.headers, ...securityHeaders() };
      if (validOrigin) Object.assign(headers, corsHeaders(validOrigin));
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(
        JSON.stringify({ error: { code: 'internal_error', message: 'An unexpected error occurred', request_id: generateRequestId() } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
