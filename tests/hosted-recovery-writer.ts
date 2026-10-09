// New-process recovery writer: writes one claim row via the real HostedStore
// and exits. Used by the D1 new-PROCESS recovery test to prove on-disk
// durability across a real process boundary (not same-process reopen).
import { randomUUID } from "node:crypto";
import { HostedStore } from "../src/hosted-store";

const [dbPath, taskId] = process.argv.slice(2);
if (!dbPath || !taskId) {
  console.error("usage: hosted-recovery-writer.ts <db> <task>");
  process.exit(2);
}
// Fixed deterministic UUIDs matching the test harness constants are passed
// via argv for task only; the rest are fresh (schema validity is what matters).
const store = new HostedStore(dbPath);
store.claimMapping({
  task_id: taskId,
  tenant_id: randomUUID(),
  worker_id: randomUUID(),
  local_worker_id: `pending-${taskId}`,
  lease_id: "11111111-1111-4111-8111-111111111111",
  fence: 7,
  supervisor_id: randomUUID(),
  reservation_id: randomUUID(),
  stop_confirmed: false,
  consumed_runtime_ms: 0,
  idempotency_key: randomUUID(),
  rotation_key: null,
  settlement_key: null,
});
store.close();
process.exit(0);
