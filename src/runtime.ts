import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Coordinator } from "./coordinator";
import { redactorFor } from "./security";
export function acquireProcessLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const claim = () => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    claim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid database lock; inspect it before removing");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("Another SwarmForge process owns this database");
    unlinkSync(path);
    claim();
  }
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid))
      unlinkSync(path);
  };
}
export function eventLogger(c: Coordinator, path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let after = Number(c.store.setting("logged_event") ?? 0);
  const redactor = redactorFor(c);
  return () => {
    for (const event of c.store.events(undefined, after, 100)) {
      const w = c.store.get(event.worker_id);
      const line = JSON.stringify(
        redactor.value({
          ...event,
          team_id: w.team_id,
          task_id: w.task_id,
          vm_id: w.vm_id,
          session_id: w.opencode_session_id,
        }),
      );
      if (
        existsSync(path) &&
        statSync(path).size + Buffer.byteLength(line) > 1048576
      )
        renameSync(path, `${path}.1`);
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
      after = event.id;
      c.store.setting("logged_event", String(after));
    }
  };
}
