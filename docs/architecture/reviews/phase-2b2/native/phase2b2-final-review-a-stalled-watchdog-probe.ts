import { randomUUID } from 'node:crypto';
import { loadConfig } from '/tmp/swarmforge-phase2b2-integration/src/config';
import { Coordinator } from '/tmp/swarmforge-phase2b2-integration/src/coordinator';
import { Store } from '/tmp/swarmforge-phase2b2-integration/src/store';
import { HostedStore } from '/tmp/swarmforge-phase2b2-integration/src/hosted-store';
import { HostedSupervisor } from '/tmp/swarmforge-phase2b2-integration/src/hosted-supervisor';
import { ControlledAgent,ControlledProcessProvider } from '/tmp/swarmforge-phase2b2-integration/src/hosted-runtime';
const tenant=randomUUID(),supervisor=randomUUID(),worker=randomUUID();
const task=()=>({task_id:randomUUID(),tenant_id:tenant,worker_id:worker,execution_class:'controlled' as const,state:'claimed' as const,reservation_id:randomUUID(),policy_version:1,runtime_ms:60000,controlled_duration_ms:20000,created_at:Date.now(),deadline_at:Date.now()+60000,lease_id:randomUUID(),supervisor_id:supervisor,fence:1,lease_expires_at:Date.now()+10000});
const a=task();
const config=loadConfig({FREESTYLE_API_TOKEN:'inert',FREESTYLE_SNAPSHOT_ID:'inert',SWARMFORGE_MODEL_BASE_URL:'https://inert.invalid',SWARMFORGE_MODEL_API_KEY:'inert',SWARMFORGE_MODEL_NAME:'inert',SWARMFORGE_GIT_TREE:'none',SWARMFORGE_DB_PATH:':memory:',SWARMFORGE_GIT_PUSH_MODE:'none',SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS:'0'});
const store=new Store(':memory:'),hostedStore=new HostedStore(':memory:'),provider=new ControlledProcessProvider(),agent=new ControlledAgent(),coordinator=new Coordinator(config,store,provider,agent);
const tasks=new Map([[a.task_id,a]]);
const client={tenantId:tenant,async ack(id:string){return {task:{...tasks.get(id),state:'running'},directive:'continue',server_time:Date.now()}}};
const hosted=new HostedSupervisor({config,store,hostedStore,provider,agent,coordinator,client:client as any,supervisorCredential:()=>({credential:'sfsuper_'+'b'.repeat(43),supervisor_id:supervisor,tenant_id:tenant,expires_at:Date.now()+60000,authorization_expires_at:Date.now()+60000})});
try {
  const run=await hosted.ackAndStart(a);
  const mapping=hostedStore.get(a.task_id)!;
  const waitUntil=performance.now()+11000;
  while(performance.now()<waitUntil) {} // simulate supervisor event-loop stall; real child runs independently
  let alive=false;try{process.kill(mapping.child_pid!,0);alive=true;}catch{}
  console.log(JSON.stringify({leaseExpiresAt:a.lease_expires_at,observedWall:Date.now(),expiredCloudLease:Date.now()>a.lease_expires_at!,expiredLocalLease:performance.now()>run.leaseDeadlineMonoMs,childAliveAfterExpiry:alive,childPid:mapping.child_pid}));
}finally{await hosted.close();await coordinator.stop();store.close();}
