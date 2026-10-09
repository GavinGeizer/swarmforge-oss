import assert from 'node:assert/strict';
import { localFixture } from '/tmp/swarmforge-phase2b2-integration/apps/cloud/test/local-fixture.ts';
const h=await localFixture();
const results: unknown[]=[];
const policy={capabilities:{hosted_control_plane:true,remote_worker_enrollment:true,hosted_task_execution:true},max_concurrent_workers:3,max_active_tasks:3,max_task_runtime:60000,maximum_resource_reservations:3,valid_for_ms:3600000,allowances:[{resource:'compute_ms',unit:'millisecond',resource_class:'controlled',allowed_quantity:'180000'}]};
try {
const a=await h.login(), b=await h.login(101), w=await h.enrolledWorker(a), wb=await h.enrolledWorker(b), cli=await h.linked(a);
await h.seedPolicy(a.tenant,policy);
const grantResponse=await h.request(`/v1/tenants/${a.tenant}/cli-installations/${cli.installation_id}/execution-authorizations`,{...a.headers,'idempotency-key':crypto.randomUUID()},'POST',{});assert.equal(grantResponse.status,201);
const grant=await grantResponse.json() as any, s=await h.registerSupervisor(a,w.worker_id), sb=await h.registerSupervisor(b,wb.worker_id);
const e={authorization:`Bearer ${grant.credential}`}, sh={authorization:`Bearer ${s.credential}`};
let checks=0;
for(const raw of [cli.credential,w.credential,s.credential,'sfexec_'+'x'.repeat(43)]) for(const suffix of ['entitlements','hosted-status','tasks/'+crypto.randomUUID()]) { const r=await h.request(`/v1/tenants/${a.tenant}/${suffix}`,{...a.headers,authorization:`Bearer ${raw}`});assert.equal(r.status,401);checks++; }
for(const raw of [cli.credential,w.credential,grant.credential]) {assert.equal((await h.request('/v1/supervisor/claim',{authorization:`Bearer ${raw}`,'idempotency-key':crypto.randomUUID()},'POST',{})).status,401);checks++;}
for(const suffix of ['entitlements','hosted-status','tasks/'+crypto.randomUUID()]) {assert.equal((await h.request(`/v1/tenants/${b.tenant}/${suffix}`,e)).status,404);checks++;}
results.push({probe:'audience_cookie_fallback_and_cross_tenant',checks});
const input={request_id:crypto.randomUUID(),worker_id:w.worker_id,execution_class:'controlled',runtime_ms:60000,controlled_duration_ms:500};
const response=await h.request(`/v1/tenants/${a.tenant}/tasks`,{...e,'idempotency-key':crypto.randomUUID()},'POST',input);assert.equal(response.status,202);const task=(await response.json() as any).task;
assert.equal((await h.request(`/v1/tenants/${a.tenant}/tasks/${task.task_id}/recover`,{...b.headers,'idempotency-key':crypto.randomUUID()},'POST',{})).status,404);
const claimed=await h.request('/v1/supervisor/claim',{...sh,'idempotency-key':crypto.randomUUID()},'POST',{});assert.equal(claimed.status,200);const lease=(await claimed.json() as any).task;
assert.equal((await h.request(`/v1/supervisor/tasks/${task.task_id}`,{authorization:`Bearer ${sb.credential}`})).status,404);
assert.equal((await h.request(`/v1/supervisor/tasks/${task.task_id}/settle`,{authorization:`Bearer ${sb.credential}`,'idempotency-key':crypto.randomUUID()},'POST',{lease_id:lease.lease_id,fence:lease.fence,outcome:'completed',stop_confirmed:true,consumed_runtime_ms:1})).status,404);
results.push({probe:'cross_tenant_dispatch_and_recovery',checks:3});
const rotate=await h.request('/v1/supervisor/me/rotate',{...sh,'idempotency-key':crypto.randomUUID()},'POST',{});assert.equal(rotate.status,200);
for(const route of ['/v1/supervisor/me','/v1/supervisor/tasks/'+task.task_id]) assert.equal((await h.request(route,sh)).status,401);
const epoch=h.db.sqlite.query('SELECT epoch FROM cli_installations WHERE installation_id=?').get(cli.installation_id) as any;
h.db.sqlite.query('UPDATE cli_installations SET epoch=epoch+1 WHERE installation_id=?').run(cli.installation_id);
assert.equal((await h.request(`/v1/tenants/${a.tenant}/hosted-status`,e)).status,401);
h.db.sqlite.query('UPDATE cli_installations SET epoch=? WHERE installation_id=?').run(epoch.epoch,cli.installation_id);
const scopes=h.db.sqlite.query('SELECT scopes FROM hosted_execution_grants WHERE grant_id=?').get(grant.grant_id) as any;
h.db.sqlite.query('UPDATE hosted_execution_grants SET scopes=? WHERE grant_id=?').run(JSON.stringify(['tasks:create']),grant.grant_id);
assert.equal((await h.request(`/v1/tenants/${a.tenant}/entitlements`,e)).status,401);
h.db.sqlite.query('UPDATE hosted_execution_grants SET scopes=? WHERE grant_id=?').run(scopes.scopes,grant.grant_id);
results.push({probe:'old_supervisor_epoch_installation_epoch_exact_scopes',checks:4});
for(const secret of [grant.credential,s.credential,sb.credential,cli.credential,w.credential,a.tenant,task.task_id]) assert(!JSON.stringify(h.logs).includes(secret));
results.push({probe:'default_worker_log_secret_and_identifier_exclusion',checks:7});
console.log(JSON.stringify(results));
} finally {h.close();}
