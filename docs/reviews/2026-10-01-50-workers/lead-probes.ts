import { config, FakeProvider, FakeAgent, harness, runToRunning } from '/tmp/swarmforge-integration-20260930/tests/helpers.ts';
import { Store } from '/tmp/swarmforge-integration-20260930/src/store.ts';
import { Coordinator } from '/tmp/swarmforge-integration-20260930/src/coordinator.ts';
import { WorkerFiles } from '/tmp/swarmforge-integration-20260930/src/files.ts';
import { Redactor, excerptText } from '/tmp/swarmforge-integration-20260930/src/security.ts';

const store = new Store(':memory:');
const provider = new FakeProvider();
const agent = new FakeAgent();
const c = new Coordinator({...config, SWARMFORGE_API_TOKEN:'z'.repeat(5000)},store,provider,agent);
const w=c.spawn({task_id:'artifact-probe',prompt:'local fake-only diagnostic'});
store.patch(w.worker_id,{state:'running',vm_id:'vm-probe'});
provider.files.set('vm-probe:/workspace/.swarmforge/artifacts/blob.bin','z'.repeat(5000)+'x'.repeat(55000));
const bytes=await new WorkerFiles(c).readArtifact(w.worker_id,'blob.bin',4196,32768);
console.log(JSON.stringify({probe:'artifact-long-token',leakedCredentialBytes:Buffer.from(bytes).subarray(0,804).equals(Buffer.from('z'.repeat(804)))}));
store.close();

const s2=new Store(':memory:');
const p2=new FakeProvider();
const a2=new FakeAgent();
const c2=new Coordinator(config,s2,p2,a2);
const original={task_id:'retry-probe',prompt:'local fake-only diagnostic',request_id:'same-request'};
c2.spawn(original);
const changed=new Coordinator({...config,SWARMFORGE_DEFAULT_TIMEOUT_SECONDS:config.SWARMFORGE_DEFAULT_TIMEOUT_SECONDS+1},s2,p2,a2);
let rejected=false;
try{changed.spawn(original);}catch{rejected=true;}
console.log(JSON.stringify({probe:'default-timeout-idempotency',identicalCallerRetryRejected:rejected}));
s2.close();

const h=harness();
const running=h.coordinator.spawn({task_id:'busy-fallback',prompt:'local fake-only diagnostic'});
await runToRunning(h,running.worker_id);
const rw=h.store.get(running.worker_id);
const dispatch=h.store.dispatch(running.worker_id)!;
h.provider.files.set(`${rw.vm_id}:/workspace/.swarmforge/result.json`,JSON.stringify({run_id:dispatch.run_id,status:'completed',summary:'written before session settled'}));
h.agent.broken=true;
await h.coordinator.tick();
console.log(JSON.stringify({probe:'busy-fallback',completedWithoutIdleEvidence:h.store.get(running.worker_id).state==='completed'}));
await h.coordinator.stop();h.store.close();

const h2=harness();
const pending=h2.coordinator.spawn({task_id:'failed-control',prompt:'local fake-only diagnostic'});
await runToRunning(h2,pending.worker_id);
h2.provider.pauseWorker=async()=>{throw new Error('synthetic provider failure');};
await h2.coordinator.control(pending.worker_id,'pause');
h2.store.patch(pending.worker_id,{deadline_at:Date.now()-1000,token_progress_at:Date.now()-3600000});
await h2.coordinator.tick();
const after=h2.store.get(pending.worker_id);
let cancelRefused=false;try{await h2.coordinator.control(pending.worker_id,'cancel');}catch{cancelRefused=true;}
console.log(JSON.stringify({probe:'failed-control',deadlineBypassed:after.state==='running'&&after.intent==='pause',cancelRefused}));
await h2.coordinator.stop();h2.store.close();

const canary='synthetic-credential-for-local-probe';
const split=canary.slice(0,10)+'\u200b'+canary.slice(10);
const redactor=new Redactor(()=>[canary]);
const excerpt=excerptText(split,text=>redactor.text(text));
console.log(JSON.stringify({probe:'excerpt-invisible-character',credentialRejoinedAfterRedaction:excerpt.includes(canary)}));

const statusProbe=Bun.spawnSync(['bash','-c','set -eu; git() { return 128; }; test -z "$(git status --porcelain --untracked-files=all)"'],{stdout:'pipe',stderr:'pipe'});
console.log(JSON.stringify({probe:'git-clean-guard',failedGitStatusPassedAsClean:statusProbe.exitCode===0}));
