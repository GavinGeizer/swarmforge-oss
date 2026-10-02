import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { localHarness } from "./local-artifact-provider";

/**
 * The end-to-end property the salvage exists for: nested worker output declared
 * as `results/**` survives a real finalization cycle and the destruction of the
 * guest that produced it.
 *
 * The lifecycle package owns the Finalizer, so this runs where that package is
 * present - the integrated checkout - and is skipped rather than faked where it
 * is not. It never stands in for production: every capture still runs the real
 * helper over the real guest tree.
 */
const lifecycle = join(
  import.meta.dir,
  "..",
  "src",
  "finalization.ts",
) as string;
const hasLifecycle = existsSync(lifecycle);

test.skipIf(!hasLifecycle)(
  "nested declared output survives finalization and the destruction of the guest",
  async () => {
    // The specifier is computed so this file type-checks on the data plane's own
    // branch, where the lifecycle package is not present, and loads the real
    // module where it is.
    const specifier = "../src/finalization";
    const lifecycle = (await import(specifier)) as {
      FinalizationGate: new (limit: number) => unknown;
      Finalizer: new (
        config: unknown,
        store: unknown,
        artifacts: unknown,
        gate: unknown,
      ) => { run(id: string): Promise<void> };
    };
    const { FinalizationGate, Finalizer } = lifecycle;
    const h = await localHarness();
    try {
      // `artifacts` on spawn belongs to the lifecycle package's schema; the cast
      // keeps the request visible here without duplicating that schema.
      const spawn = h.spawn as unknown as (input: {
        artifacts?: { path: string; required?: boolean }[];
      }) => ReturnType<typeof h.spawn>;
      const created = spawn({
        artifacts: [{ path: ".swarmforge/artifacts/**", required: false }],
      });
      await h.provider.createWorker(created);
      const deep = join(
        h.workspace.root,
        ".swarmforge",
        "artifacts",
        "results",
        "deep",
      );
      mkdirSync(join(deep, "deeper"), { recursive: true, mode: 0o700 });
      const marker = '{"verdict":"salvage","nested":true}\n';
      writeFileSync(join(deep, "findings.json"), marker);
      writeFileSync(join(deep, "deeper", "detail.txt"), "deep detail\n");
      // The lifecycle owns when a finalization record exists; this drives the one
      // public entry point it uses to create it, so the record under test is the
      // real shape and not a fixture's invention.
      (
        h.store as unknown as {
          beginFinalization(id: string, run_id: string | null): unknown;
        }
      ).beginFinalization(created.worker_id, "run-1");
      const finalizer = new Finalizer(
        h.config,
        h.store,
        h.artifacts,
        new FinalizationGate(2),
      );
      await finalizer.run(created.worker_id);
      const listed = h.artifacts
        .list({ worker_id: created.worker_id })
        .artifacts.map((record) => ({
          path: record.original_path,
          kind: record.kind,
          state: record.state,
          size: record.size,
          sha256: record.sha256,
          key: record.storage_key,
        }));
      // The nested tree is collected, not dropped: a declared `results/**` and
      // the default collection of the same directory are one artifact, and the
      // whole nested tree is carried by one bounded archive.
      expect(
        listed.filter(
          (record) =>
            record.path === "snapshot:.swarmforge/artifacts/results" &&
            record.state === "preserved",
        ),
      ).toHaveLength(1);
      // One current record per source: the declaration and the default did not
      // produce two kinds, two records or two stored objects.
      expect(new Set(listed.map((record) => record.path)).size).toBe(
        listed.length,
      );
      // Every collected record is complete: nothing claims to be whole when it is
      // not, and nothing is left mid-flight.
      for (const record of h.artifacts.list({ worker_id: created.worker_id })
        .artifacts) {
        expect(record.state).toBe("preserved");
        expect(record.incomplete).toBeNull();
      }
      const archive = h.artifacts
        .list({ worker_id: created.worker_id })
        .artifacts.find(
          (record) =>
            record.original_path === "snapshot:.swarmforge/artifacts/results",
        )!;
      const chunks: Uint8Array[] = [];
      for await (const chunk of (await h.artifacts.download(
        archive.artifact_id,
      )) as unknown as AsyncIterable<Uint8Array>)
        chunks.push(chunk);
      const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      expect(createHash("sha256").update(joined).digest("hex")).toBe(
        archive.sha256 ?? "",
      );
      const unpacked = gunzipSync(joined).toString("latin1");
      expect(unpacked).toContain(
        ".swarmforge/artifacts/results/deep/findings.json",
      );
      expect(unpacked).toContain(marker.trim());
      expect(unpacked).toContain("deeper/detail.txt");
      // The guest is destroyed. The bytes, the record and the hash are not.
      await h.provider.destroyWorker(created.vm_id!);
      const after = await h.artifacts.download(archive.artifact_id);
      const again: Uint8Array[] = [];
      for await (const chunk of after as unknown as AsyncIterable<Uint8Array>)
        again.push(chunk);
      expect(
        createHash("sha256")
          .update(Buffer.concat(again.map((chunk) => Buffer.from(chunk))))
          .digest("hex"),
      ).toBe(archive.sha256 ?? "");
      expect(h.artifacts.metadata(archive.artifact_id).storage_key).toBe(
        archive.storage_key,
      );
    } finally {
      await h.cleanup();
    }
  },
  120000,
);

test.skipIf(hasLifecycle)(
  "the finalization survival regression runs only where the lifecycle package exists",
  () => {
    // Named so a skipped run is visible rather than silent: this branch carries
    // the data plane alone, and the integrated checkout runs the test above
    // against the real Finalizer.
    expect(hasLifecycle).toBe(false);
  },
);
