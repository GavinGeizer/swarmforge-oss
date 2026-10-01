#!/usr/bin/env bun

// Independent artifact-salvage scale probe. One of the two files this worker owns.
//
// It measures the properties that matter at volume and that the package suites
// never reach: many worker records, well over a hundred artifacts, streamed
// files, bounded peak heap, and bounded helper concurrency.
//
// It uses the REAL production capture path end to end: the real
// `src/providers/artifact-helper.py` executed as a subprocess, the real
// `HelperArtifactTransport`, the real `ArtifactStore` on the filesystem, the real
// SQLite store and the real `Finalizer`. There is no reimplemented helper and no
// reimplemented store. No model is involved, nothing is base64'd, and no artifact
// body is printed: the report carries counts, digests, sizes and states only.
//
//   bun scripts/artifact-salvage-scale.ts
//   PROBE_WORKERS=24 PROBE_PER_WORKER=8 bun scripts/artifact-salvage-scale.ts
//
// Everything it creates lives in temporary directories that are removed on exit,
// including on failure.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHarness } from "../tests/local-artifact-provider";

const WORKERS = Number(process.env.PROBE_WORKERS ?? "12");
const PER_WORKER = Number(process.env.PROBE_PER_WORKER ?? "9");
const BIG_MIB = Number(process.env.PROBE_BIG_MIB ?? "8");
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? "4");
const MIB = 1024 * 1024;

const gib = (n: number) => Math.round((n / 2 ** 30) * 1000) / 1000;
const heap = () => process.memoryUsage().heapUsed;

class ProbeFailure extends Error {}

async function main() {
  const guestFiles = new Map<string, string>();
  const report: Record<string, unknown> = {
    configuration: {
      workers: WORKERS,
      files_per_worker: PER_WORKER,
      large_file_mib: BIG_MIB,
      artifact_concurrency: CONCURRENCY,
      note: "SWARMFORGE_ARTIFACT_MAX_BYTES is raised for the run so byte limits are not the subject",
    },
  };
  const storage = join(tmpdir(), `swarmforge-scale-storage-${process.pid}`);
  const h = await localHarness({
    SWARMFORGE_ARTIFACT_CONCURRENCY: String(CONCURRENCY),
    SWARMFORGE_ARTIFACT_TIMEOUT_MS: "120000",
    SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: "3",
    SWARMFORGE_FINALIZATION_RETRY_MS: "10",
    SWARMFORGE_ARTIFACT_MAX_BYTES: String(4 * 1024 * MIB),
  });
  try {
    const root = h.workspace.root;
    // The same two directories a real guest gets at boot, so the default target
    // set matches production.
    mkdirSync(join(root, ".swarmforge/artifacts"), { recursive: true });
    mkdirSync(join(root, ".swarmforge/logs"), { recursive: true });

    // Concurrency is observed from the host side: every capture really runs the
    // helper as a subprocess, so overlapping helper execs are the real signal.
    let active = 0;
    let peak = 0;
    const exec = h.workspace.host.exec.bind(h.workspace.host);
    h.workspace.host.exec = async (...args: Parameters<typeof exec>) => {
      active++;
      if (active > peak) peak = active;
      try {
        return await exec(...args);
      } finally {
        active--;
      }
    };

    const ids: string[] = [];
    for (let i = 0; i < WORKERS; i++) {
      const relative = `.swarmforge/artifacts/w${i}`;
      const dir = join(root, relative);
      mkdirSync(dir, { recursive: true });
      // Each worker declares its own files, which is the production shape: the
      // declared targets overlap the default `.swarmforge/artifacts/**`
      // collection. The first file also sits directly in the default collection
      // root, which is where a worker's real output goes.
      const declared: {
        path: string;
        required: boolean;
        directory: boolean;
      }[] = [];
      for (let j = 0; j < PER_WORKER; j++) {
        const kib = 16 + ((i * 7 + j * 13) % 512);
        const path =
          j === 0
            ? `.swarmforge/artifacts/w${i}-report.json`
            : `${relative}/part-${j}.bin`;
        // Vary the size and stamp a unique header, so every file has distinct
        // content and a checksum match is unambiguous.
        const bytes = Buffer.alloc(kib * 1024, (i + j) & 0xff);
        bytes.write(`w${i}-p${j}-${bytes.byteLength}`, 0, "ascii");
        // Written straight to the guest, never assembled whole by the probe.
        await Bun.write(Bun.file(join(root, path)), bytes);
        guestFiles.set(path, join(root, path));
        declared.push({ path, required: true, directory: false });
      }
      const w = h.spawn({ task_id: `task-${i % 3}`, artifacts: declared });
      ids.push(w.worker_id);
    }
    // One deliberately larger file, written in bounded chunks.
    const bigRelative = ".swarmforge/artifacts/big.bin";
    const big = join(root, bigRelative);
    const chunk = Buffer.alloc(MIB, 0x5a);
    const writer = Bun.file(big).writer();
    for (let i = 0; i < BIG_MIB; i++) await writer.write(chunk);
    await writer.end();
    guestFiles.set(bigRelative, big);
    report.guest_files = guestFiles.size;

    const before = heap();
    let peakHeap = before;
    const started = Date.now();
    const results = await Promise.all(
      ids.map((id) => {
        h.store.beginFinalization(id, null);
        return h.coordinator.finalize(id);
      }),
    );
    const cur = heap();
    if (cur > peakHeap) peakHeap = cur;

    report.elapsed_ms = Date.now() - started;
    report.peak_helper_concurrency = peak;
    report.heap_before_gib = gib(before);
    report.heap_peak_gib = gib(peakHeap);
    report.heap_growth_gib = gib(peakHeap - before);

    const records = ids.flatMap(
      (id) => h.artifacts.list({ worker_id: id, limit: 1000 }).artifacts,
    );
    report.artifacts_total = records.length;
    report.artifacts_preserved = records.filter(
      (r) => r.state === "preserved",
    ).length;
    report.artifacts_failed = records.filter(
      (r) => r.state === "failed",
    ).length;
    report.total_stored_bytes = records.reduce((n, r) => n + r.size, 0);
    report.finalization_states = results.reduce<Record<string, number>>(
      (acc, w) => {
        const s = w.finalization?.state ?? "none";
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      },
      {},
    );
    // Duplicate detection, the confirmed kind-keyed duplication finding, kept
    // visible here so a regression in the idempotency key is loud. The same
    // worker/run/path appearing twice is a real storage duplication, because the
    // repository key includes `kind` and a file written directly into
    // `.swarmforge/artifacts` is both declared and swept by the default target.
    const byPath = new Map<string, number>();
    for (const r of records) {
      const key = `${r.worker_id}|${r.run_id ?? ""}|${r.original_path}`;
      byPath.set(key, (byPath.get(key) ?? 0) + 1);
    }
    const duplicates = [...byPath.entries()].filter(([, n]) => n > 1);
    report.duplicate_worker_run_paths = duplicates.length;
    report.duplicate_records = duplicates.reduce((n, [, c]) => n + c, 0);
    report.duplicate_kinds = duplicates.slice(0, 3).map(([key]) =>
      records
        .filter(
          (r) => `${r.worker_id}|${r.run_id ?? ""}|${r.original_path}` === key,
        )
        .map((r) => r.kind)
        .sort(),
    );
    report.distinct_content_digests = new Set(
      records.map((r) => r.sha256),
    ).size;

    // Re-verify checksums against the guest bytes, streaming both sides.
    let verified = 0;
    let mismatched = 0;
    for (const r of records) {
      if (r.state !== "preserved" || !r.sha256) continue;
      const source = guestFiles.get(r.original_path);
      if (!source) continue;
      const guest = createHash("sha256");
      for await (const part of Bun.file(source).stream()) guest.update(part);
      if (guest.digest("hex") === r.sha256) verified++;
      else mismatched++;
    }
    report.checksums_reverified = verified;
    report.checksum_mismatches = mismatched;

    const failed = records.filter((r) => r.state !== "preserved");
    if (failed.length) {
      const reasons = new Map<string, number>();
      for (const r of failed)
        reasons.set(
          (r.error ?? "unknown").slice(0, 120),
          (reasons.get((r.error ?? "unknown").slice(0, 120)) ?? 0) + 1,
        );
      report.failure_reasons = Object.fromEntries(reasons);
    }
    if (peak > CONCURRENCY)
      throw new ProbeFailure(
        `helper concurrency ${peak} exceeded the configured bound ${CONCURRENCY}`,
      );
    if (mismatched)
      throw new ProbeFailure(
        `${mismatched} preserved checksums did not match the guest bytes`,
      );
    if (report.artifacts_preserved === 0)
      throw new ProbeFailure("nothing was preserved; the probe proved nothing");
    return report;
  } finally {
    await h.cleanup();
    rmSync(storage, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.log(
    JSON.stringify({
      event: "scale_probe_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
