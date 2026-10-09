import { localFixture } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/test/local-fixture.ts';
import { hostedAuthorityRoute } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-authority.ts';
import { hostedAdmissionRoute } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-admission.ts';
import { hostedStatusRoute } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-status.ts';
import { allowanceReserveStatement } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-entitlements.ts';
import { supervisorRoute } from '/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-supervisors.ts';
const policy={capabilities:{hosted_control_plane:true,remote_worker_enrollment:true,hosted_task_execution:true},max_concurrent_workers:8,max_active_tasks:8,max_task_runtime:60000,maximum_resource_reservations:16,valid_for_ms:3600000};
const fixture=()=>localFixture({handlers:[hostedAuthorityRoute,hostedAdmissionRoute,hostedStatusRoute,supervisorRoute]});
{
 const h=await fixture();try {
  const a=await h.login(),linked=await h.linked(a);
  await h.db.prepare('UPDATE sessions SET expires_at=? WHERE session_id=?').bind(Date.now()+50,a.sessionId).run();
  h.db.beforeBatch=async()=>{h.db.beforeBatch=undefined;await Bun.sleep(75);};
  const r=await h.request(`/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,{...a.headers,'idempotency-key':crypto.randomUUID()},'POST',{});
  console.log(JSON.stringify({probe:'execution_grant_issued_after_browser_expiry',status:r.status,grants:h.db.sqlite.query('SELECT count(*) n FROM hosted_execution_grants').get(),session:h.db.sqlite.query('SELECT expires_at FROM sessions WHERE session_id=?').get(a.sessionId),dbClock:h.db.sqlite.query("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) now").get()}));
 }finally{h.close();}
}
{
 const h=await fixture();try {
  const a=await h.login(),w=await h.enrolledWorker(a),admin=await h.login(200),now=Date.now();
  await h.db.prepare("INSERT INTO memberships VALUES(?,?,'admin','active',?,?)").bind(a.tenant,admin.user,now,now).run();
  await h.seedPolicy(a.tenant,policy);
  const s=await h.registerSupervisor({...admin,tenant:a.tenant},w.worker_id);
  await h.db.prepare("UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?").bind(a.tenant,a.user).run();
  const r=await h.request(`/v1/tenants/${a.tenant}/hosted-status`,admin.headers);
  const correct=await h.request(`/v1/tenants/${a.tenant}/hosted-status`,{...admin.headers});
  // admin's cookie is valid; tenant URL selects the membership just seeded.
  const reply=await correct.json();
  console.log(JSON.stringify({probe:'status_worker_enroller_loss',status:correct.status,supervisors:reply.supervisors}));
 }finally{h.close();}
}
{
 const h=await fixture();try {
  const a=await h.login(),p=await h.seedPolicy(a.tenant,{...policy,allowances:[{resource:'compute_ms',unit:'millisecond',resource_class:'controlled',allowed_quantity:'10000'}]});
  const row=h.db.sqlite.query('SELECT * FROM hosted_allowances').get() as any;
  const start=Date.now()-2000,end=Date.now()-1000;
  await h.db.prepare('UPDATE hosted_allowances SET period_start=?,period_end=? WHERE allowance_id=?').bind(start,end,row.allowance_id).run();
  const r=await allowanceReserveStatement(h.context('/'),{allowanceId:row.allowance_id,tenant:a.tenant,entitlementId:p.entitlement_id,resource:'compute_ms',unit:'millisecond',resourceClass:'controlled',periodStart:start,periodEnd:end,expectedReserved:'0',expectedConsumed:'0',newReserved:'1000',newConsumed:'0'}).run();
  console.log(JSON.stringify({probe:'explicit_reserve_past_period',changes:r.meta.changes,row:h.db.sqlite.query('SELECT period_start,period_end,reserved_quantity FROM hosted_allowances').get()}));
 }finally{h.close();}
}
{
 const h=await fixture();try {
  const a=await h.login(),w=await h.enrolledWorker(a);
  await h.seedPolicy(a.tenant,{...policy,allowances:[{resource:'compute_ms',unit:'millisecond',resource_class:'controlled',allowed_quantity:'10000'}]});
  const originalPrepare=h.db.prepare.bind(h.db);let maxArgs=0;
  h.db.prepare=(sql)=>{const st=originalPrepare(sql),bind=st.bind.bind(st);st.bind=(...args)=>{maxArgs=Math.max(maxArgs,args.length);return bind(...args);};return st;};
  const measurements:Record<string,unknown>={};
  async function measured(name:string,request:()=>Promise<Response>){const start=h.db.queryCalls;maxArgs=0;const response=await request();measurements[name]={status:response.status,statements:h.db.queryCalls-start,maxArgs};return response;}
  const r=await measured('metered_admission',()=>h.request(`/v1/tenants/${a.tenant}/tasks`,{...a.headers,'idempotency-key':crypto.randomUUID()},'POST',{request_id:crypto.randomUUID(),worker_id:w.worker_id,execution_class:'controlled',runtime_ms:1000,controlled_duration_ms:10}));
  const task=(await r.json() as any).task;
  await measured('metered_cancel',()=>h.request(`/v1/tenants/${a.tenant}/tasks/${task.task_id}/cancel`,{...a.headers,'idempotency-key':crypto.randomUUID()},'POST',{}));
  await measured('status',()=>h.request(`/v1/tenants/${a.tenant}/hosted-status`,a.headers));
  console.log(JSON.stringify({probe:'independent_admission_budget',measurements}));
 }finally{h.close();}
}
