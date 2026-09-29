import type { Config } from "./config";
import type { Worker, WorkerProvider, WorkerResult } from "./domain";
import { branchFor, quote } from "./git-handoff";

// Local refs, remotes and reflogs are guest-writable, so they are never evidence that
// work is durable: only a push the control plane performed and verified counts.
function verifiedCommit(w: Worker, result: WorkerResult | null) {
  const git = result?.git;
  if (!git?.persisted || git.branch !== branchFor(w)) return null;
  return /^[0-9a-f]{40,64}$/.test(git.commit ?? "") ? git.commit! : null;
}

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
  const anchor = verifiedCommit(w, result) ?? "";
  const script = `# SWARMFORGE_GIT_CHECK
import os, subprocess, json
roots=json.loads(${JSON.stringify(JSON.stringify(roots))})
anchor=${JSON.stringify(anchor)}
facts={'clean':True,'stray':0,'unpushed':0,'repos':0,'notes':[]}
repos=set()
def git(path,*args):
 p=subprocess.run(['git','-C',path,*args],capture_output=True,text=True,timeout=15)
 return p.returncode,p.stdout
for root in roots:
 if not os.path.isdir(root):
  facts['clean']=False; facts['notes'].append('workspace unavailable'); continue
 code,top=git(root,'rev-parse','--show-toplevel')
 if code==0: repos.add(top.strip())
 else:
  for path,dirs,files in os.walk(root,followlinks=False):
   dirs[:]=[d for d in dirs if d not in ['.swarmforge','node_modules','.cache']]
   if '.git' in dirs or '.git' in files:
    repos.add(path); dirs[:]=[]; continue
   if files: facts['stray']+=len(files)
   if len(repos)+facts['stray']>200: break
for repo in repos:
 facts['repos']+=1
 code,out=git(repo,'status','--porcelain','--untracked-files=all','--','.',':(exclude).swarmforge',':(exclude)**/.swarmforge/**')
 if code!=0 or out.strip():
  facts['clean']=False; facts['notes'].append('dirty or unreadable Git workspace')
 code,head=git(repo,'rev-parse','--verify','--quiet','HEAD')
 if code!=0: continue
 args=['rev-list','--count','--all']+(['--not',anchor] if anchor else [])
 code,out=git(repo,*args)
 if code!=0:
  facts['clean']=False; facts['notes'].append('unreadable Git history')
 else: facts['unpushed']+=int(out.strip() or 0)
print(json.dumps(facts))`;
  try {
    const r = await provider.exec(w.vm_id, `python3 -c ${quote(script)}`);
    if (r.code !== 0) return { safe: false, reason: "Git safety check failed" };
    const facts: unknown = JSON.parse(r.stdout);
    const f = facts as Record<string, unknown> | null;
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.clean !== "boolean" ||
      !Array.isArray(f.notes) ||
      ![f.stray, f.unpushed, f.repos].every((n) => Number.isSafeInteger(n))
    )
      throw new Error("invalid safety response");
    const issues = [...new Set((f.notes as unknown[]).map(String))];
    if ((f.stray as number) > 0) issues.push("files outside a Git repository");
    if ((f.unpushed as number) > 0)
      issues.push(
        anchor
          ? "commits not covered by the verified remote branch"
          : "local commits are not verified by the control plane",
      );
    return {
      safe: issues.length === 0,
      reason: issues.join("; ") || "no obvious unpersisted work",
    };
  } catch {
    return { safe: false, reason: "Unable to verify persistence" };
  }
}
