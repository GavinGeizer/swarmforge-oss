/** Local guest fixture compiled with the shipping flags. No provider/model calls. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../../src/coordinator";
import { Store } from "../../src/store";
import { LocalAgent, localHarness } from "../local-artifact-provider";

const db = process.argv[2]!;
const artifactDir = process.argv[3]!;
const h = await localHarness({
  SWARMFORGE_DB_PATH: db,
  SWARMFORGE_ARTIFACT_DIR: artifactDir,
});
const store = new Store(db);
const coordinator = new Coordinator(
  h.config,
  store,
  h.provider,
  new LocalAgent(),
);
try {
  const worker = store.create({
    team_id: "compiled",
    task_id: "salvage",
    role: "coder",
    prompt: "local fixture",
    timeout_seconds: 60,
    artifacts: [
      { path: "outputs/findings.bin", required: true, directory: false },
    ],
  });
  const vm = await h.provider.createWorker(worker);
  store.patch(worker.worker_id, { vm_id: vm.id, state: "failed" });
  mkdirSync(join(h.workspace.root, "outputs"));
  const bytes = Buffer.from([0, 1, 255, 10, 13, 128, 42]);
  writeFileSync(join(h.workspace.root, "outputs/findings.bin"), bytes);
  store.beginFinalization(worker.worker_id, null);
  await coordinator.finalize(worker.worker_id);
  if (store.get(worker.worker_id).finalization?.state !== "preserved")
    throw new Error("Preservation failed");
  const record = coordinator.artifacts
    .list({ worker_id: worker.worker_id })
    .artifacts.find((a) => a.filename === "findings.bin")!;
  await coordinator.control(worker.worker_id, "destroy");
  if (
    store.get(worker.worker_id).state !== "destroyed" ||
    existsSync(h.workspace.root)
  )
    throw new Error("Safe destruction failed");
  await coordinator.stop();
  store.close();
  const reopened = new Store(db);
  const recovered = new Coordinator(
    h.config,
    reopened,
    h.provider,
    new LocalAgent(),
  );
  const saved = await recovered.artifacts.read(record.artifact_id, 0, 7);
  if (!Buffer.from(saved).equals(bytes))
    throw new Error("Restart changed artifact bytes");
  await recovered.stop();
  reopened.close();
  process.stdout.write(
    `${JSON.stringify({ artifact_id: record.artifact_id, worker_id: worker.worker_id, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.toString("base64") })}\n`,
  );
} finally {
  await h.cleanup();
}
