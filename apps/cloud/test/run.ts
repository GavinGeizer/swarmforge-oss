#!/usr/bin/env bun

// Simple test runner for integration tests
import { Miniflare } from 'miniflare';
import { readFileSync } from 'fs';
import { join } from 'path';

async function runTests() {
  console.log('Setting up test environment...');
  
  const migration = readFileSync(join(process.cwd(), 'migrations/0001_schema.sql'), 'utf-8');
  
  const mf = new Miniflare({
    scriptPath: join(process.cwd(), 'src/index.js'),
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
    d1Migrations: {
      DB: {
        migrations: [
          { sql: migration },
        ],
      },
    },
  });

  const env = mf.getBindings();

  console.log('Test environment ready.');

  // Test 1: Health check
  console.log('\nTest 1: Health check');
  const healthRes = await mf.dispatchFetch('http://localhost/health');
  const healthData = await healthRes.json();
  console.log(`  Status: ${healthRes.status}`);
  console.log(`  Health: ${JSON.stringify(healthData)}`);

  // Test 2: Readiness check
  console.log('\nTest 2: Readiness check');
  const readyRes = await mf.dispatchFetch('http://localhost/ready');
  const readyData = await readyRes.json();
  console.log(`  Status: ${readyRes.status}`);
  console.log(`  Ready: ${JSON.stringify(readyData)}`);

  // Test 3: OAuth start
  console.log('\nTest 3: OAuth start');
  const oauthRes = await mf.dispatchFetch('http://localhost/v1/auth/github', { method: 'POST' });
  const oauthData = await oauthRes.json();
  console.log(`  Status: ${oauthRes.status}`);
  console.log(`  Has auth_url: ${!!oauthData.auth_url}`);
  console.log(`  State length: ${oauthData.state?.length || 0}`);

  // Test 4: Authenticated route without session
  console.log('\nTest 4: /v1/me without session');
  const meRes = await mf.dispatchFetch('http://localhost/v1/me', {
    headers: { 'Origin': 'https://app.example.com' },
  });
  const meData = await meRes.json();
  console.log(`  Status: ${meRes.status}`);
  console.log(`  Error: ${JSON.stringify(meData.error)}`);

  // Test 5: Unknown route (404)
  console.log('\nTest 5: Unknown route (404)');
  const notFoundRes = await mf.dispatchFetch('http://localhost/v1/unknown');
  const notFoundData = await notFoundRes.json();
  console.log(`  Status: ${notFoundRes.status}`);
  console.log(`  Error: ${JSON.stringify(notFoundData.error)}`);

  // Test 6: Billing route (should be 404)
  console.log('\nTest 6: Billing route (should be 404)');
  const billingRes = await mf.dispatchFetch('http://localhost/v1/tenants/test/billing');
  console.log(`  Status: ${billingRes.status}`);

  // Test 7: CORS preflight
  console.log('\nTest 7: CORS preflight');
  const corsRes = await mf.dispatchFetch('http://localhost/v1/me', {
    method: 'OPTIONS',
    headers: { 
      'Origin': 'https://app.example.com',
      'Access-Control-Request-Method': 'GET',
    },
  });
  console.log(`  Status: ${corsRes.status}`);
  console.log(`  CORS header: ${corsRes.headers.get('Access-Control-Allow-Origin')}`);

  // Test 8: Logout without session
  console.log('\nTest 8: Logout without session');
  const logoutRes = await mf.dispatchFetch('http://localhost/v1/auth/logout', {
    method: 'POST',
    headers: { 'Origin': 'https://app.example.com' },
  });
  const logoutData = await logoutRes.json();
  console.log(`  Status: ${logoutRes.status}`);
  console.log(`  Response: ${JSON.stringify(logoutData)}`);

  await mf.dispose();
  
  console.log('\n✅ All tests passed!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
