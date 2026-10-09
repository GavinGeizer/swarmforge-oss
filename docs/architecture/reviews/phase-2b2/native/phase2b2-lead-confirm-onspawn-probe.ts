import { randomUUID } from 'node:crypto';
import { loadConfig } from '/tmp/swarmforge-phase2b2-integration/src/config';
import { Coordinator } from '/tmp/swarmforge-phase2b2-integration/src/coordinator';
import { Store } from '/tmp/swarmforge-phase2b2-integration/src/store';
import { HostedStore } from '/tmp/swarmforge-phase2b2-integration/src/hosted-store';
import { HostedSupervisor } from '/tmp/swarmforge-phase2b2-integration/src/hosted-supervisor';
import { ControlledAgent,ControlledProcessProvider } from '/tmp/swarmforge-phase2b2-integration/src/hosted-runtime';
const tenant=randomUUID(),supervisor=randomUUID(),worker=randomUUID();
const task=()=>({task_id:randomUUID(),tenant_id:tenant,worker_id:worker,execution_class:'controlled' as const,state:'claimed' as const,reservation_id:randomUUID(),policy_version:1,runtime_ms:60000,controlled_duration_ms:5000,created_at:Date.now(),deadline_at:Date.now()+60000,lease_id:randomUUID(),supervisor_id:supervisor,fence:1,lease_expires_at:Date.now()+30000});
const a=task(),b=task(); let releaseB!:()=>void;
const waitB=new Promise<void>(resolve=>releaseB=resolve);
class DelayedProvider extends ControlledProcessProvider {
  calls=0;
  override async startControlled(...args:Parameters<ControlledProcessProvider['startControlled']>) {
    this.calls++;
    if(this.calls===2)await waitB;
    else await Bun.sleep(50); // allow second task to install its callback
    return super.startControlled(...args);
  }
}
const config=loadConfig({FREESTYLE_API_TOKEN:'inert',FREESTYLE_SNAPSHOT_ID:'inert',SWARMFORGE_MODEL_BASE_URL:'https://inert.invalid',SWARMFORGE_MODEL_API_KEY:'inert',SWARMFORGE_MODEL_NAME:'inert',SWARMFORGE_GIT_TREE:'none',SWARMFORGE_DB_PATH:':memory:',SWARMFORGE_GIT_PUSH_MODE:'none',SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS:'0'});
const store=new Store(':memory:'),hostedStore=new HostedStore(':memory:'),provider=new DelayedProvider(),agent=new ControlledAgent(),coordinator=new Coordinator(config,store,provider,agent);
const tasks=new Map([[a.task_id,a],[b.task_id,b]]);
const client={tenantId:tenant,async ack(id:string){return {task:{...tasks.get(id),state:'running'},directive:'continue',server_time:Date.now()}}};
const hosted=new HostedSupervisor({config,store,hostedStore,provider,agent,coordinator,client:client as any,supervisorCredential:()=>({credential:'sfsuper_'+'b'.repeat(43),supervisor_id:supervisor,tenant_id:tenant,expires_at:Date.now()+60000,authorization_expires_at:Date.now()+60000}),minLifetimeMs:1,safetyMarginMs:0});
try {
  const pa=hosted.ackAndStart(a);const pb=hosted.ackAndStart(b);
  await pa;releaseB();await pb;
  const ma=hostedStore.get(a.task_id)!,mb=hostedStore.get(b.task_id)!;
  const actualB=provider.recordFor(store.get(mb.local_worker_id).vm_id!)!;
  console.log(JSON.stringify({mappingA:ma.child_pid,mappingB:mb.child_pid,actualB:actualB.pid,distinctChildRecords:ma.child_pid!==mb.child_pid,taskBJournalMatches:mb.child_pid===actualB.pid}));
}finally{await hosted.close();await coordinator.stop();store.close();}
