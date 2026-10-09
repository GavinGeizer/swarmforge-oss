import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/config';
import { Coordinator } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/coordinator';
import { Store } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/store';
import { HostedStore } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/hosted-store';
import { HostedSupervisor } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/hosted-supervisor';
import { ControlledAgent,ControlledProcessProvider } from '/tmp/phase2b2-final-review-a-baseline-f1d/src/hosted-runtime';
import {localFixture} from '/tmp/phase2b2-final-review-a-baseline-f1d/apps/cloud/test/local-fixture.ts';
import {HostedTaskClient,SupervisorClient} from '/tmp/phase2b2-final-review-a-baseline-f1d/src/hosted-client';
const cloud=await localFixture();
const user=await cloud.login();const enrolled=await cloud.enrolledWorker(user);
await cloud.seedPolicy(user.tenant,{capabilities:{hosted_control_plane:true,remote_worker_enrollment:true,hosted_task_execution:true},max_concurrent_workers:1,max_active_tasks:1,max_task_runtime:120000,maximum_resource_reservations:1,valid_for_ms:3600000,allowances:[{resource:'compute_ms',unit:'millisecond',resource_class:'controlled',allowed_quantity:'240000'}]});
const linked=await cloud.linked(user);
const granted=await cloud.request(`/v1/tenants/${user.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,{...user.headers,'idempotency-key':randomUUID()},'POST',{});
if(granted.status!==201)throw new Error('grant failed');
const grant=await granted.json() as any;
const supervisorView=await cloud.registerSupervisor(user,enrolled.worker_id);
const transport=Object.assign(async(input:any,init:any)=>cloud.fetch(new Request(input,init)),{preconnect:()=>{}}) as typeof fetch;
const taskClient=new HostedTaskClient(cloud.env.APP_ORIGIN,grant.credential,user.tenant,transport);
await taskClient.submitTask(enrolled.worker_id,120000,45000);
const client=new SupervisorClient(cloud.env.APP_ORIGIN,supervisorView.credential,user.tenant,transport);
const config=loadConfig({FREESTYLE_API_TOKEN:'inert',FREESTYLE_SNAPSHOT_ID:'inert',SWARMFORGE_MODEL_BASE_URL:'https://inert.invalid',SWARMFORGE_MODEL_API_KEY:'inert',SWARMFORGE_MODEL_NAME:'inert',SWARMFORGE_GIT_TREE:'none',SWARMFORGE_DB_PATH:':memory:',SWARMFORGE_GIT_PUSH_MODE:'none',SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS:'0'});
const store=new Store(':memory:'),hostedStore=new HostedStore(':memory:'),provider=new ControlledProcessProvider(),agent=new ControlledAgent(),coordinator=new Coordinator(config,store,provider,agent);
const hosted=new HostedSupervisor({config,store,hostedStore,provider,agent,coordinator,client,supervisorCredential:()=>supervisorView});
const a=(await hosted.claimOnce())!;
// Genuine 30-second production claim lease: let 10 seconds of authority elapse before ACK.
await Bun.sleep(10000);
try {
  console.log(JSON.stringify({claimLeaseRemaining:a.lease_expires_at!-Date.now(),taskRemaining:a.deadline_at-Date.now()}));
  const run=await hosted.ackAndStart(a);
  const mapping=hostedStore.get(a.task_id)!;
  const before=readFileSync(`/proc/${mapping.child_pid}/stat`,'utf8').split(') ')[1]!.split(' ')[0];
  assert.notEqual(before,'Z');
  console.log(JSON.stringify({phase:'before_stall',pid:mapping.child_pid,procState:before,leaseRemaining:a.lease_expires_at!-Date.now()}));
  const waitUntil=performance.now()+Math.max(0,a.lease_expires_at!-Date.now()+1000);
  while(performance.now()<waitUntil) {} // simulate supervisor event-loop stall; real child runs independently
  let alive=false;try{process.kill(mapping.child_pid!,0);alive=true;}catch{}
  let after:string|null=null;try{after=readFileSync(`/proc/${mapping.child_pid}/stat`,'utf8').split(') ')[1]!.split(' ')[0]!;}catch{}
  assert(Date.now()>a.lease_expires_at!);
  assert(after===null||after==='Z',`child still executing: ${after}`);
  console.log(JSON.stringify({phase:'after_stall',pid:mapping.child_pid,procState:after,nonexecuting:after===null||after==='Z'}));
  assert.equal(await run.completion,'cancelled');
  const proof=await hosted.stopAndConfirm(a.task_id,'independent expired child proof');
  assert.equal(proof.stop_confirmed,true);
  console.log(JSON.stringify({completion:'cancelled',stopConfirmed:proof.stop_confirmed,journalRetained:proof.child_pid===mapping.child_pid}));
  console.log(JSON.stringify({leaseExpiresAt:a.lease_expires_at,observedWall:Date.now(),expiredCloudLease:Date.now()>a.lease_expires_at!,expiredLocalLease:performance.now()>run.leaseDeadlineMonoMs,childAliveAfterExpiry:alive,childPid:mapping.child_pid}));
}finally{await hosted.close();await coordinator.stop();store.close();cloud.close();}
