import type { Config } from "./config";
import type { Worker, WorkerProvider, WorkerResult } from "./domain";
import { quote } from "./providers/freestyle";
// Inspect local state only. Remote refs are a conservative hint, not proof of durable storage.
export async function inspectPersistence(
  provider: WorkerProvider,
  c: Config,
  w: Worker,
  result: WorkerResult | null,
) {
  if (!w.vm_id) return { safe: true, reason: "no VM" };
  const roots = [
    c.SWARMFORGE_WORKSPACE,
    ...(c.SWARMFORGE_GIT_TREE.startsWith("/") ? [c.SWARMFORGE_GIT_TREE] : []),
    ...(result?.git?.workspace ? [result.git.workspace] : []),
  ];
  const script = `# SWARMFORGE_GIT_CHECK
import os, subprocess, json
roots=json.loads(${JSON.stringify(JSON.stringify(roots))})
issues=[]
repos=set()
def git(path,*args):
 p=subprocess.run(['git','-C',path,*args],capture_output=True,text=True,timeout=15)
 return p.returncode,p.stdout
for root in roots:
 if not os.path.isdir(root):
  issues.append('workspace unavailable'); continue
 code,top=git(root,'rev-parse','--show-toplevel')
 if code==0: repos.add(top.strip())
 else:
  for path,dirs,files in os.walk(root,followlinks=False):
   dirs[:]=[d for d in dirs if d not in ['.swarmforge','node_modules','.cache']]
   if '.git' in dirs or '.git' in files:
    repos.add(path); dirs[:]=[]; continue
   if files: issues.append('files outside a Git repository')
   if len(repos)+len(issues)>200: break
for repo in repos:
 code,out=git(repo,'status','--porcelain','--untracked-files=all','--','.',':(exclude).swarmforge',':(exclude)**/.swarmforge/**')
 if code!=0 or out.strip(): issues.append('dirty or unreadable Git workspace')
 code,out=git(repo,'rev-list','--count','--branches','HEAD','--not','--remotes')
 if code!=0 or out.strip()!='0': issues.append('commits not represented by remote refs')
print(json.dumps({'safe':not issues,'reason':'; '.join(sorted(set(issues))) or 'no obvious unpersisted work'}))`;
  try {
    const r = await provider.exec(w.vm_id, `python3 -c ${quote(script)}`);
    if (r.code !== 0) return { safe: false, reason: "Git safety check failed" };
    const parsed = JSON.parse(r.stdout);
    if (typeof parsed.safe !== "boolean")
      throw new Error("invalid safety response");
    return { safe: parsed.safe, reason: String(parsed.reason).slice(0, 1000) };
  } catch {
    return { safe: false, reason: "Unable to verify persistence" };
  }
}
