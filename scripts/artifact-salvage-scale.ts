#!/usr/bin/env bun

// Independent artifact-salvage scale probe. One of the two files this worker owns.
//
// It measures the properties that matter at volume and that the package suites
// never reach: many worker records, well over a hundred artifacts, streamed
// files, peak heap and RSS sampled WHILE the captures run, and bounded guest
// helper concurrency.
//
// WHAT IS REAL AND WHAT IS NOT
//
//   Real: the production capture path end to end. The real
//   `src/providers/artifact-helper.py` is executed as a subprocess by the real
//   `HelperArtifactTransport`, which drives the real `ArtifactService` and the
//   real `ArtifactStore` on the filesystem, over a real SQLite store and the real
//   `Finalizer`. There is no reimplemented helper and no reimplemented store.
//
//   Local, by design: the guest is NOT a live Freestyle VM. It is the repository's
//   own `tests/local-artifact-provider` fixture, which stands in for one worker
//   guest with a directory on this host. The helper subprocess, the transport and
//   the store are production code; only the guest is simulated. Do not read this
//   report as evidence about a live Freestyle VM.
//
// No model is involved, nothing is base64'd, and no artifact body is printed:
// the report carries counts, digests, sizes and states only.
//
//   bun scripts/artifact-salvage-scale.ts
//   PROBE_WORKERS=24 PROBE_PER_WORKER=8 bun scripts/artifact-salvage-scale.ts
//
// Everything it creates lives in temporary directories that are removed on exit,
// including on failure.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { localHarness } from "../tests/local-artifact-provider";

const WORKERS = Number(process.env.PROBE_WORKERS ?? "12");
const PER_WORKER = Number(process.env.PROBE_PER_WORKER ?? "9");
const BIG_MIB = Number(process.env.PROBE_BIG_MIB ?? "8");
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? "4");
const MIB = 1024 * 1024;
/** Sampling cadence for the in-flight heap/RSS measurements. */
const SAMPLE_MS = Number(process.env.PROBE_SAMPLE_MS ?? "25");
/** Bounds the probe enforces on what it measured. Generous, but they are real. */
const MAX_HEAP_MIB = Number(process.env.PROBE_MAX_HEAP_MIB ?? "768");
const MAX_RSS_MIB = Number(process.env.PROBE_MAX_RSS_MIB ?? "2048");

const gib = (n: number) => Math.round((n / 2 ** 30) * 1000) / 1000;
const mib = (n: number) => Math.round(n / MIB);
const heap = () => process.memoryUsage().heapUsed;

class ProbeFailure extends Error {}

/** One record as the duplicate scan sees it. */
export interface DuplicateKeyable {
  worker_id: string;
  run_id?: string | null;
  original_path: string;
  kind?: string | null;
}

/**
 * Group records by worker/run/path, the identity the repository uses for one
 * stored artifact. `kind` is deliberately NOT part of the key: the repository key
 * includes it, which is why a file that is both declared and swept by the default
 * target is stored twice under one path. That is the duplication this finds.
 */
export function duplicateFindings(records: DuplicateKeyable[]) {
  const byPath = new Map<string, DuplicateKeyable[]>();
  for (const record of records) {
    const key = `${record.worker_id}|${record.run_id ?? ""}|${record.original_path}`;
    const bucket = byPath.get(key);
    if (bucket) bucket.push(record);
    else byPath.set(key, [record]);
  }
  const duplicates = [...byPath.entries()].filter(
    ([, group]) => group.length > 1,
  );
  return {
    paths: duplicates.length,
    records: duplicates.reduce((n, [, group]) => n + group.length, 0),
    kinds: duplicates
      .slice(0, 3)
      .map(([, group]) => group.map((r) => r.kind ?? "?").sort()),
  };
}

/**
 * Samples process memory on a timer for the whole window in which captures are in
 * flight, so the reported peaks are observations taken DURING the workload rather
 * than two samples taken either side of it. `samples` is reported alongside, so a
 * peak that could not have been observed cannot be passed off as a measurement.
 */
class MemorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  samples = 0;
  heapPeak = 0;
  rssPeak = 0;
  constructor(private readonly intervalMs: number) {}
  start() {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // One last observation, so the sample count always covers the whole window.
    this.sample();
  }
  private sample() {
    const usage = process.memoryUsage();
    this.samples++;
    if (usage.heapUsed > this.heapPeak) this.heapPeak = usage.heapUsed;
    if (usage.rss > this.rssPeak) this.rssPeak = usage.rss;
  }
}

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

    // Every capture really runs the production helper as a subprocess over the
    // guest ArtifactHost, so the overlap of `host.exec` calls is the real helper
    // concurrency. It is named for exactly what it measures, because it counts
    // guest helper process execs and nothing else.
    let active = 0;
    let peak = 0;
    let execs = 0;
    const exec = h.workspace.host.exec.bind(h.workspace.host);
    h.workspace.host.exec = async (...args: Parameters<typeof exec>) => {
      active++;
      execs++;
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
    // Sampling is armed immediately before the captures start and disarmed the
    // instant the last one settles, so every reported peak comes from inside the
    // capture window.
    const sampler = new MemorySampler(SAMPLE_MS);
    sampler.start();
    let peakHeap = sampler.heapPeak;
    let peakRss = sampler.rssPeak;
    const started = Date.now();
    let results: Awaited<ReturnType<typeof h.coordinator.finalize>>[];
    try {
      results = await Promise.all(
        ids.map((id) => {
          h.store.beginFinalization(id, null);
          return h.coordinator.finalize(id);
        }),
      );
    } finally {
      sampler.stop();
      peakHeap = Math.max(peakHeap, sampler.heapPeak);
      peakRss = Math.max(peakRss, sampler.rssPeak);
    }

    report.elapsed_ms = Date.now() - started;
    report.guest_helper_exec_total = execs;
    report.peak_guest_helper_exec_concurrency = peak;
    report.memory_samples_in_capture_window = sampler.samples;
    report.sample_interval_ms = SAMPLE_MS;
    report.heap_before_gib = gib(before);
    report.heap_peak_sampled_during_captures_gib = gib(peakHeap);
    report.rss_peak_sampled_during_captures_gib = gib(peakRss);
    report.heap_peak_sampled_during_captures_mib = mib(peakHeap);
    report.rss_peak_sampled_during_captures_mib = mib(peakRss);
    report.heap_growth_gib = gib(peakHeap - before);
    report.bounds = {
      max_heap_mib: MAX_HEAP_MIB,
      max_rss_mib: MAX_RSS_MIB,
      max_helper_exec_concurrency: CONCURRENCY,
    };

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
    // Duplicate detection, the confirmed kind-keyed duplication finding. The same
    // worker/run/path appearing twice is a real storage duplication, because the
    // repository key includes `kind` and a file written directly into
    // `.swarmforge/artifacts` is both declared and swept by the default target.
    // This is counted AND enforced: a duplicated record means the same bytes were
    // stored twice, so the probe fails rather than reporting it and exiting 0. It
    // stays failing until the idempotency key is keyed the same way as the
    // repository, and the assertion is never weakened to make the probe green.
    const duplicate = duplicateFindings(records);
    report.duplicate_worker_run_paths = duplicate.paths;
    report.duplicate_records = duplicate.records;
    report.duplicate_kinds = duplicate.kinds;
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
    // Every gate below refuses rather than merely reporting, so a defect can
    // never reach an exit code of 0. `fail` attaches the measured counters to the
    // failure, so a refusal still shows the evidence that caused it.
    const fail = (message: string): never => {
      throw Object.assign(new ProbeFailure(message), { report });
    };
    if (peak > CONCURRENCY)
      fail(
        `guest helper exec concurrency ${peak} exceeded the configured bound ${CONCURRENCY}`,
      );
    if (execs === 0)
      fail(
        "no guest helper exec was observed; the concurrency figure proved nothing",
      );
    if (sampler.samples < 2)
      fail(
        `only ${sampler.samples} memory samples were taken during the capture window; the peaks are not measurements`,
      );
    if (peakHeap > MAX_HEAP_MIB * MIB)
      fail(
        `sampled heap peak ${mib(peakHeap)} MiB exceeded the bound ${MAX_HEAP_MIB} MiB`,
      );
    if (peakRss > MAX_RSS_MIB * MIB)
      fail(
        `sampled RSS peak ${mib(peakRss)} MiB exceeded the bound ${MAX_RSS_MIB} MiB`,
      );
    if (mismatched)
      fail(`${mismatched} preserved checksums did not match the guest bytes`);
    if (report.artifacts_preserved === 0)
      fail("nothing was preserved; the probe proved nothing");
    // Enforced, not merely reported: the same bytes stored twice is a defect, and
    // the probe keeps failing here until the idempotency key matches the
    // repository key.
    if (duplicate.paths > 0)
      fail(
        `${duplicate.paths} duplicated worker/run/paths (${String(duplicate.records)} records) across ${records.length} artifacts`,
      );
    return report;
  } finally {
    await h.cleanup();
  }
}

// Only probe when this file is the entry point. Importing it exposes the helpers
// above for tests without running a workload.
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(), null, 2));
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "scale_probe_failed",
        error: error instanceof Error ? error.message : String(error),
        // The counters that caused the refusal stay visible.
        ...((error as { report?: Record<string, unknown> }).report ?? {}),
      }),
    );
    process.exitCode = 1;
  }
}
