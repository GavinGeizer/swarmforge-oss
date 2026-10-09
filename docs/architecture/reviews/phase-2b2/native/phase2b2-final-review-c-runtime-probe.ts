import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { ControlledProcessProvider, procBootId, procExe, procStarttime } from '/tmp/swarmforge-phase2b2-integration/src/hosted-runtime.ts';
import { HostedStore } from '/tmp/swarmforge-phase2b2-integration/src/hosted-store.ts';
process.env.SWARMFORGE_HOSTED_ENTRY='1';process.env.GITHUB_TOKEN='synthetic-parent-github';process.env.ANTHROPIC_API_KEY='synthetic-parent-model';process.env.NODE_OPTIONS='--trace-warnings';
const provider=new ControlledProcessProvider();const worker={worker_id:'review-c-child',vm_id:'controlled-review-c-child'} as any;
let resolveExit: (x:unknown)=>void;const exited=new Promise(r=>resolveExit=r);let rec:any;
try {
await provider.startControlled(worker,1500,c=>resolveExit(c),r=>rec=r);
const env=readFileSync(`/proc/${rec.pid}/environ`,'utf8').split('\0').filter(Boolean);
assert(env.every(s=>/^(PATH|TZ|SWARMFORGE_HOSTED_DURATION)=/.test(s)));
assert(!env.join('\n').includes('synthetic-parent'));assert(!env.some(s=>s.startsWith('NODE_OPTIONS=')));
await provider.stopWorkerRuntime(worker);await exited;
let refused=false;
try {await provider.stopPidWithProof('fabricated',{pid:process.pid,starttime:String(BigInt(procStarttime(process.pid)!)+1n),exe:procExe(process.pid)!,bootId:procBootId()!,durationMs:10,startedAtMonoMs:0});} catch {refused=true;}
assert(refused);process.kill(process.pid,0);
const dir=mkdtempSync('/tmp/phase2b2-review-c-private-');let storage='not_run';try { const store=new HostedStore(dir+'/journal.sqlite');store.close();storage='opened'; } catch(e) {storage=String((e as Error).message); } finally {rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({probe:'actual_inert_child_minimal_environment',child_environment_keys:env.map(s=>s.split('=')[0]),unrelated_live_pid_refused:refused,private_journal_result:storage}));
} finally {try {await provider.stopWorkerRuntime(worker);} catch {}}
