import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type ArtifactRecord,
  safeReadLimit,
  validateRelativePath,
} from "./artifact-types";
import type { Coordinator } from "./coordinator";
import { idSchema, spawnSchema, states } from "./domain";
import { WorkerFiles } from "./files";
import { notificationFeed } from "./notifications";
import { usageEstimate } from "./operator-insights";
import { retentionPreview } from "./retention";
import { publicWorker, redactorFor } from "./security";
import { applyTaskTemplate, taskTemplates } from "./task-templates";

// Model-facing artifact reads stay bounded and credential screened: a lead sees at most
// safeReadLimit bytes of screened text per call, never raw bytes and never a whole binary
// payload. Large or binary payloads are described by metadata plus a download handle.
// A capture response is budgeted by serialized bytes, not by a record count: records with
// 1024-byte paths are far larger than short ones. The budget is half of the tool response
// ceiling, because an MCP result carries the payload twice (structured content and text), and
// the remainder stays reachable through list_artifacts instead of failing the whole call after
// the capture already succeeded.
const collectedLimit = 100;
const collectedBytes = 49152;
type PublicArtifact = Pick<
  ArtifactRecord,
  | "artifact_id"
  | "task_id"
  | "worker_id"
  | "run_id"
  | "original_path"
  | "filename"
  | "kind"
  | "size"
  | "sha256"
  | "state"
  | "attempts"
  | "error"
  | "created_at"
  | "retrieved_at"
>;
// Advancing display clocks do not turn every row into a changed worker.
const workerFingerprint = (value: ReturnType<typeof publicWorker>) =>
  JSON.stringify({
    ...value,
    progress: { ...value.progress, queue_ms: 0, run_ms: 0, idle_ms: 0 },
  });
const dashboardSnapshots = new WeakMap<
  Coordinator,
  Map<string, { revision: string; workers: ReturnType<typeof publicWorker>[] }>
>();
export function createMcpServer(c: Coordinator, signal?: AbortSignal) {
  const server = new McpServer(
    { name: "swarmforge", version: "0.1.0" },
    {
      instructions:
        "For artifact text, use read_worker_artifact for live worker files or read_artifact for preserved artifact IDs. These return bounded plaintext directly: do not decode base64 or run Python to read text. For complete, large or binary artifacts, preserve the file if needed, then run swarmforge artifacts download ARTIFACT_ID --output PATH to stream and verify it locally. Keep file bytes out of model context. get_worker_artifact/resources-read is a legacy binary resource interface.",
    },
  );
  const files = new WorkerFiles(c);
  const redactor = redactorFor(c);
  const worker = { worker_id: idSchema };
  const page = {
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  };
  // Storage locators, staging paths and transfer internals are never part of a lead-facing
  // projection: only the fields a lead can act on are returned.
  const publicArtifact = (record: ArtifactRecord): PublicArtifact => ({
    artifact_id: record.artifact_id,
    task_id: record.task_id,
    worker_id: record.worker_id,
    run_id: record.run_id,
    original_path: record.original_path,
    filename: record.filename,
    kind: record.kind,
    size: record.size,
    sha256: record.sha256,
    state: record.state,
    attempts: record.attempts,
    error: record.error,
    created_at: record.created_at,
    retrieved_at: record.retrieved_at,
  });
  const artifactPath = z.string().min(1).max(1024);
  // One path rule for every artifact surface, owned by the shared contract module: workspace
  // relative, at most 1024 bytes and 32 components, no traversal, no control characters.
  const checkedPath = (path: string) => {
    if (redactor.text(path) !== path)
      throw new Error("Artifact path contains credentials");
    return validateRelativePath(path);
  };
  const runId = (value: string | undefined) => (value ? { runId: value } : {});
  const collected = (records: ArtifactRecord[]) => {
    const artifacts: PublicArtifact[] = [];
    let bytes = 0;
    for (const record of records) {
      const view = publicArtifact(record);
      const size = Buffer.byteLength(JSON.stringify(view));
      if (
        artifacts.length &&
        (artifacts.length >= collectedLimit || bytes + size > collectedBytes)
      )
        break;
      artifacts.push(view);
      bytes += size;
    }
    const truncated = artifacts.length < records.length;
    return {
      artifacts,
      total: records.length,
      truncated,
      // The cut records are not lost: they are in the repository and paged by list_artifacts.
      ...(truncated ? { next: "list_artifacts" as const } : {}),
    };
  };

  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    action: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>,
    readOnly = false,
  ) {
    server.registerTool<z.ZodRawShape, z.ZodRawShape>(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: true,
        },
      },
      async (args): Promise<CallToolResult> =>
        c
          .operation(async (): Promise<CallToolResult> => {
            try {
              const data = redactor.value(
                await action(z.object(schema).parse(args)),
              );
              const json = JSON.stringify(data);
              if (Buffer.byteLength(json) > 131072)
                throw new Error(
                  "Response exceeds limit; request a smaller page",
                );
              return {
                structuredContent: data as Record<string, unknown>,
                content: [{ type: "text", text: json }],
              } satisfies CallToolResult;
            } catch (e) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      e instanceof z.ZodError
                        ? "Invalid tool arguments"
                        : redactor
                            .text(
                              e instanceof Error
                                ? e.message
                                : "Operation failed",
                            )
                            .slice(0, 2000),
                  },
                ],
              };
            }
          })
          .catch(() => ({
            isError: true,
            content: [{ type: "text", text: "Coordinator stopped" }],
          })),
    );
  }
  register(
    "spawn_worker",
    "Queue an isolated coding worker. Returns immediately; use request_id for safe retries.",
    {
      ...spawnSchema.shape,
      template: z.enum(["code", "review", "research", "docs"]).optional(),
    },
    (a) => {
      const w = c.spawn(applyTaskTemplate(a, a.template));
      return {
        worker_id: w.worker_id,
        task_id: w.task_id,
        team_id: w.team_id,
        state: w.state,
      };
    },
  );
  register(
    "list_task_templates",
    "List built-in task recipes and required deliverables; viewing never spawns a worker.",
    {},
    () => ({ templates: taskTemplates }),
    true,
  );
  register(
    "get_retention_preview",
    "Read-only paginated retention preview; automatic cleanup is off by default and uses normal Git/artifact gates.",
    page,
    (a) => retentionPreview(c, a.offset, a.limit),
    true,
  );
  register(
    "list_notifications",
    "Durable task, preservation, retention and budget notifications; pass next_cursor to resume without replaying earlier events.",
    {
      ...worker,
      worker_id: idSchema.optional(),
      team_id: idSchema.optional(),
      task_id: idSchema.optional(),
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    (a) => notificationFeed(c, a),
    true,
  );
  register(
    "get_worker",
    "Get worker lifecycle, session metadata, token accounting and a bounded live response excerpt.",
    worker,
    (a) => publicWorker(c, a.worker_id, true),
    true,
  );
  register(
    "list_workers",
    "List worker metadata using offset/limit pagination.",
    {
      ...page,
      team_id: idSchema.optional(),
      task_id: idSchema.optional(),
      state: z.enum(states).optional(),
    },
    (a) => {
      const listed = c.store.queryWorkers(a);
      return {
        ...listed,
        workers: listed.workers.map((w) => publicWorker(c, w.worker_id)),
      };
    },
    true,
  );
  register(
    "send_worker_message",
    "Queue a follow-up in the same OpenCode session. Running turns finish before queued messages.",
    { ...worker, message: z.string().min(1).max(32000) },
    (a) => c.message(a.worker_id, a.message),
  );
  for (const [tool, intent] of [
    ["pause_worker", "pause"],
    ["resume_worker", "resume"],
    ["cancel_worker", "cancel"],
  ] as const)
    register(
      tool,
      `${intent} worker; cancellation retains the environment for inspection.`,
      worker,
      async (a) => {
        await c.control(a.worker_id, intent);
        return publicWorker(c, a.worker_id);
      },
    );
  register(
    "destroy_worker",
    "Permanently destroy a worker after persistence checks. settled_only=true also requires a settled task, preserved outputs and no pending work/control. force=true explicitly permits losing local work.",
    {
      ...worker,
      force: z.boolean().default(false),
      settled_only: z.boolean().default(false),
    },
    async (a) => {
      await c.control(a.worker_id, "destroy", a.force, a.settled_only);
      return publicWorker(c, a.worker_id);
    },
  );
  register(
    "get_dashboard_view",
    "Bounded dashboard snapshot. Filters/sorting run in SQLite. Send revision from the same query/page for an unchanged reply; a new process always has a new revision. Global totals remain independent of filters.",
    {
      ...page,
      query: z.string().max(128).optional(),
      team_id: idSchema.optional(),
      task_id: idSchema.optional(),
      state: z.enum(states).optional(),
      preservation: z
        .enum([
          "none",
          "pending",
          "collecting",
          "preserved",
          "failed",
          "abandoned",
        ])
        .optional(),
      retained_only: z.boolean().default(false),
      sort: z.enum(["recent", "idle", "age"]).default("recent"),
      revision: z.string().max(200).optional(),
    },
    (a) => {
      const revision = c.store.revision();
      const { revision: previousRevision, ...query } = a;
      const key = JSON.stringify(query);
      let snapshots = dashboardSnapshots.get(c);
      if (!snapshots) {
        snapshots = new Map();
        dashboardSnapshots.set(c, snapshots);
      }
      const previous = snapshots.get(key);
      if (a.revision === revision && previous?.revision === revision)
        return { unchanged: true, revision };
      const listed = c.store.queryWorkers(a);
      const summary = c.store.summary();
      const workers = listed.workers.map((w) => {
        const view = publicWorker(c, w.worker_id);
        return {
          ...view,
          progress: {
            ...view.progress,
            activity: c.excerpt(w.worker_id)?.text ?? null,
          },
        };
      });
      const delta =
        !!previousRevision && previous?.revision === previousRevision;
      const prior = new Map(
        previous?.workers.map((w) => [w.worker_id, workerFingerprint(w)]),
      );
      const currentIds = new Set(workers.map((w) => w.worker_id));
      const payload = delta
        ? {
            delta: true,
            changed_workers: workers.filter(
              (w) => prior.get(w.worker_id) !== workerFingerprint(w),
            ),
            worker_ids: workers.map((w) => w.worker_id),
            removed_ids: previous!.workers
              .filter((w) => !currentIds.has(w.worker_id))
              .map((w) => w.worker_id),
          }
        : { delta: false, workers };
      snapshots.delete(key);
      snapshots.set(key, { revision, workers });
      while (snapshots.size > 64)
        snapshots.delete(snapshots.keys().next().value!);
      return {
        unchanged: false,
        revision,
        ...summary,
        usage: usageEstimate(c.store, c.config),
        metrics: {
          enabled: c.config.SWARMFORGE_METRICS_ENABLED,
          port: c.config.SWARMFORGE_METRICS_PORT,
        },
        ...payload,
        page: {
          offset: a.offset,
          limit: a.limit,
          total: listed.total,
          next_offset: listed.next_offset,
        },
      };
    },
    true,
  );
  register(
    "get_worker_result",
    "Get the latest persisted structured result or a particular run; results survive VM destruction.",
    { ...worker, run_id: z.string().optional() },
    (a) => {
      c.store.get(a.worker_id);
      return {
        worker_id: a.worker_id,
        result: c.store.result(a.worker_id, a.run_id),
      };
    },
    true,
  );
  register(
    "get_worker_logs",
    "Get bounded control-plane events and the last 16 KiB of OpenCode service logs.",
    {
      ...worker,
      after: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    },
    (a) => files.logs(a.worker_id, a.after, a.limit),
    true,
  );
  register(
    "list_worker_artifacts",
    "List a worker artifact directory without returning file contents.",
    { ...worker, ...page, directory: z.string().max(1024).default("") },
    (a) => files.artifacts(a.worker_id, a.directory, a.offset, a.limit),
    true,
  );
  register(
    "read_worker_artifact",
    "Preferred reader for live text artifacts: returns credential-screened plaintext directly, without base64 or Python decoding. Paths are relative to .swarmforge/artifacts. Defaults to a 4 KiB excerpt; use the verified CLI download for the whole file or binary data.",
    {
      ...worker,
      path: artifactPath,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(safeReadLimit).default(4096),
    },
    async (a) => {
      const handle = await files.artifact(
        a.worker_id,
        a.path,
        a.offset,
        a.length,
      );
      const bytes = await files.readArtifact(
        a.worker_id,
        a.path,
        a.offset,
        a.length,
      );
      const view = screen(bytes);
      return {
        worker_id: a.worker_id,
        path: handle.name,
        size: handle.size,
        offset: a.offset,
        returned_bytes: bytes.length,
        binary: view.binary,
        text: view.binary ? null : view.text,
        next_offset:
          a.offset + bytes.length < handle.size
            ? a.offset + bytes.length
            : null,
        truncated: a.offset + bytes.length < handle.size,
        full_file: {
          tool: "preserve_artifact",
          arguments: {
            worker_id: a.worker_id,
            path: `.swarmforge/artifacts/${handle.name}`,
          },
          next: "Use the returned artifact_id with swarmforge artifacts download ARTIFACT_ID --output PATH; no base64 decoding is needed.",
        },
      };
    },
    true,
  );
  server.registerTool(
    "get_worker_artifact",
    {
      description:
        "Legacy binary resource link (resources/read yields base64). Prefer read_worker_artifact for plaintext, or preserve_artifact plus swarmforge artifacts download for complete/binary files. Do not use base64/Python decoding to read ordinary text.",
      inputSchema: {
        ...worker,
        path: z.string().min(1).max(1024),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(32768).default(32768),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        const handle = await c.operation(() =>
          files.artifact(a.worker_id, a.path, a.offset, a.length),
        );
        return {
          structuredContent: handle,
          content: [
            {
              type: "resource_link",
              uri: handle.uri,
              name: handle.name,
              mimeType: handle.mimeType,
              size: handle.length,
            },
            { type: "text", text: JSON.stringify(handle) },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            { type: "text", text: "Artifact unavailable or invalid path" },
          ],
        };
      }
    },
  );
  register(
    "list_artifacts",
    "List artifacts preserved from workers, with metadata only. Survives worker destruction and never returns contents. state filters the returned page without changing the repository paging, so a filtered page can be shorter than limit.",
    {
      ...page,
      worker_id: idSchema.optional(),
      task_id: idSchema.optional(),
      state: z.enum(["preserving", "preserved", "failed"]).optional(),
    },
    async (a) => {
      const listed = await c.artifacts.list({
        offset: a.offset,
        limit: a.limit,
        ...(a.worker_id ? { worker_id: a.worker_id } : {}),
        ...(a.task_id ? { task_id: a.task_id } : {}),
      });
      const artifacts = listed.artifacts.filter(
        (record) => !a.state || record.state === a.state,
      );
      return {
        artifacts: artifacts.map(publicArtifact),
        next_offset: listed.next_offset,
      };
    },
    true,
  );
  register(
    "search_artifacts",
    "Search preserved artifact metadata across workers using filename/path substring and kind/state filters before pagination.",
    {
      ...page,
      worker_id: idSchema.optional(),
      task_id: idSchema.optional(),
      query: z.string().max(128).optional(),
      kind: z.string().max(64).optional(),
      state: z.enum(["preserving", "preserved", "failed"]).optional(),
    },
    async (a) => {
      const listed = await c.artifacts.list(a);
      return { ...listed, artifacts: listed.artifacts.map(publicArtifact) };
    },
    true,
  );
  register(
    "get_usage_summary",
    "Measured token categories and configured USD estimates; retained VM hours include paused time, estimates are not provider billing or a spending limit.",
    { worker_id: idSchema.optional() },
    (a) => {
      if (a.worker_id) c.store.get(a.worker_id);
      return {
        tokens: c.store.tokens(a),
        usage: usageEstimate(c.store, c.config, a.worker_id),
      };
    },
    true,
  );
  register(
    "get_artifact_metadata",
    "Get size, checksum, state and origin of one preserved artifact. Raw bytes are only available through the authenticated download path.",
    { artifact_id: idSchema },
    (a) => publicArtifact(c.artifacts.metadata(a.artifact_id)),
    true,
  );
  register(
    "preserve_artifact",
    "Capture a worker file or directory into coordinator storage before its VM is destroyed. Paths are workspace relative; the worker needs no cooperation.",
    {
      worker_id: idSchema,
      path: artifactPath,
      kind: z.enum(["file", "directory"]).default("file"),
      run_id: idSchema.optional(),
    },
    async (a) => {
      checkedPath(a.path);
      const preserved =
        a.kind === "directory"
          ? await c.artifacts.collectDirectory(a.worker_id, a.path, {
              signal,
              ...runId(a.run_id),
            })
          : [
              await c.artifacts.preserve(a.worker_id, a.path, {
                signal,
                kind: a.kind,
                ...runId(a.run_id),
              }),
            ];
      return collected(preserved);
    },
  );
  register(
    "read_artifact",
    "Preferred preserved-text reader: returns bounded credential-screened plaintext directly, with no base64 or Python decoding. Binary/complete files should use swarmforge artifacts download ARTIFACT_ID --output PATH.",
    {
      artifact_id: idSchema,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(safeReadLimit).default(safeReadLimit),
    },
    async (a) => {
      const record = c.artifacts.metadata(a.artifact_id);
      const bytes = await c.artifacts.safeRead(
        a.artifact_id,
        a.offset,
        Math.min(a.length, safeReadLimit),
      );
      const view = screen(bytes);
      const end = a.offset + bytes.length;
      return {
        artifact_id: record.artifact_id,
        filename: record.filename,
        kind: record.kind,
        state: record.state,
        size: record.size,
        sha256: record.sha256,
        offset: a.offset,
        length: a.length,
        returned_bytes: bytes.length,
        binary: view.binary,
        text: view.binary ? null : view.text,
        next_offset: end < record.size ? end : null,
        truncated: end < record.size,
        download_path: `/artifacts/${record.artifact_id}/download`,
        download_command: `swarmforge artifacts download ${record.artifact_id} --output ./artifact-download`,
      };
    },
    true,
  );
  register(
    "snapshot_worker",
    "Archive a worker workspace into coordinator storage as a regular-file tar.gz, excluding .git and node_modules by default.",
    {
      worker_id: idSchema,
      paths: z.array(artifactPath).max(50).optional(),
      run_id: idSchema.optional(),
    },
    async (a) => {
      const paths = a.paths?.map(checkedPath);
      const record = await c.artifacts.snapshot(a.worker_id, {
        signal,
        ...(paths ? { paths } : {}),
        ...runId(a.run_id),
      });
      return collected([record]);
    },
  );
  register(
    "retry_worker_finalization",
    "Retry artifact preservation for a retained worker whose collection failed or exhausted its automatic attempts. The worker VM must still exist.",
    { worker_id: idSchema },
    async (a) => {
      await c.retryFinalization(a.worker_id);
      const w = c.store.get(a.worker_id);
      const listed = await c.artifacts.list({
        worker_id: a.worker_id,
        offset: 0,
        limit: 100,
      });
      return {
        worker_id: w.worker_id,
        state: w.state,
        finalization: w.finalization ?? null,
        artifacts: listed.artifacts.map(publicArtifact),
        next_offset: listed.next_offset,
      };
    },
  );
  register(
    "list_worker_files",
    "List a live worker workspace directory without returning contents. Paths are workspace relative; symlinks and special files are never listed. Depth and entry bounds come from the artifact limits configuration.",
    {
      ...worker,
      path: z.string().max(1024).default(""),
      ...page,
    },
    async (a) => {
      const path = a.path ? checkedPath(a.path) : "";
      const listing = await c.artifacts.listWorkerFiles(a.worker_id, path, {
        offset: a.offset,
        limit: a.limit,
        signal,
      });
      return {
        worker_id: a.worker_id,
        path,
        entries: listing.entries,
        next_offset: listing.next_offset,
        // Entries beyond the configured bound exist and were not described.
        truncated: listing.truncated ?? false,
        ...(listing.total === undefined ? {} : { total: listing.total }),
      };
    },
    true,
  );
  register(
    "get_task",
    "Get task ownership, state counts and token usage.",
    { team_id: idSchema.default("default"), task_id: idSchema },
    (a) => {
      const all = c.store
        .all()
        .filter((w) => w.team_id === a.team_id && w.task_id === a.task_id);
      if (!all.length) throw new Error("Task not found");
      return {
        ...a,
        states: counts(all.map((w) => w.state)),
        workers: all.length,
        tokens: c.store.tokens(a),
      };
    },
    true,
  );
  register(
    "list_tasks",
    "List persisted task metadata.",
    { ...page, team_id: idSchema.optional() },
    (a) => {
      const all = c.store.tasks(a.team_id);
      return {
        tasks: all.slice(a.offset, a.offset + a.limit),
        next_offset:
          a.offset + a.limit < all.length ? a.offset + a.limit : null,
      };
    },
    true,
  );
  register(
    "get_team_status",
    "Get team worker counts and aggregate token usage.",
    { team_id: idSchema },
    (a) => {
      const workers = c.store.all().filter((w) => w.team_id === a.team_id);
      return {
        team_id: a.team_id,
        workers: workers.length,
        states: counts(workers.map((w) => w.state)),
        tokens: c.store.tokens(a),
      };
    },
    true,
  );
  register(
    "get_swarm_status",
    "Get aggregate lifecycle counts, capacity and token usage across all teams.",
    {},
    () => ({
      usage: usageEstimate(c.store, c.config),
      states: c.store.summary().states,
      tokens: c.store.summary().tokens,
      limits: {
        workers: c.config.SWARMFORGE_MAX_WORKERS,
        provisioning: c.config.SWARMFORGE_MAX_PROVISIONING,
      },
      metrics: {
        enabled: c.config.SWARMFORGE_METRICS_ENABLED,
        port: c.config.SWARMFORGE_METRICS_PORT,
      },
      inference_requests_active: [...c.inference.values()].reduce(
        (a, b) => a + b,
        0,
      ),
    }),
    true,
  );
  register(
    "wait_for_state_change",
    "Wait for the next worker lifecycle transition without polling. Filter by worker, team, task or target states. Omit cursor to wait for future changes, or pass the previous next_cursor to replay later ones. Returns changed=false when the wait times out.",
    {
      worker_id: idSchema.optional(),
      team_id: idSchema.optional(),
      task_id: idSchema.optional(),
      states: z.array(z.enum(states)).max(states.length).optional(),
      cursor: z.number().int().min(0).optional(),
      timeout_ms: z.number().int().min(0).max(25000).default(10000),
    },
    (a) =>
      c.waitForStateChange(
        {
          worker_id: a.worker_id,
          team_id: a.team_id,
          task_id: a.task_id,
          states: a.states,
          cursor: a.cursor,
        },
        { timeoutMs: a.timeout_ms, signal },
      ),
    true,
  );
  server.registerResource(
    "worker-artifact",
    new ResourceTemplate(
      "swarmforge://workers/{worker_id}/artifacts/{path}{?offset,length}",
      { list: undefined },
    ),
    {
      description: "Bounded worker artifact chunk",
      mimeType: "application/octet-stream",
    },
    async (url) => {
      const match = url.pathname.match(/^\/([^/]+)\/artifacts\/(.+)$/);
      if (!match) throw new Error("Invalid resource URI");
      const bytes = await c.operation(() =>
        files.readArtifact(
          decodeURIComponent(match[1]!),
          decodeURIComponent(match[2]!),
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("length") ?? 32768),
        ),
      );
      return {
        contents: [
          {
            uri: url.href,
            mimeType: "application/octet-stream",
            blob: Buffer.from(bytes).toString("base64"),
          },
        ],
      };
    },
  );
  return server;
}
function counts(values: string[]) {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
// Artifact bytes are untrusted input: only printable text is inlined, terminal escapes and
// invisible or bidirectional code points are removed, and anything else is reported as
// binary metadata so a lead fetches raw bytes through the authenticated download instead.
function screen(bytes: Uint8Array): { binary: boolean; text: string } {
  if (!bytes.length) return { binary: false, text: "" };
  for (let trim = 0; trim < 4 && bytes.length - trim > 0; trim++) {
    const end = bytes.length - trim;
    if (trim) {
      const lead = bytes[end]!;
      const width =
        lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 0;
      if (
        !width ||
        trim >= width ||
        !bytes.subarray(end + 1).every((byte) => byte >= 0x80 && byte <= 0xbf)
      )
        continue;
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, end),
      );
    } catch {
      // A range boundary can split one UTF-8 code point; retry without its last bytes.
      continue;
    }
    // Terminal output is text: its escape sequences are removed first, so colouring never
    // turns a log into binary metadata and no inert "[31m" fragment is left behind.
    const escaped = stripEscapes(decoded);
    const text = scrub(escaped);
    return controlRatio(escaped) > controlAllowance(bytes.length)
      ? { binary: true, text: "" }
      : { binary: false, text };
  }
  return { binary: true, text: "" };
}
// CSI sequences, OSC strings terminated by BEL or ST, and single-character escapes. Built from
// runtime code points so no control character is written into the source.
const introducer = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const slash = String.fromCharCode(92);
const escapes = new RegExp(
  [
    `${introducer}\\[[0-?]*[ -/]*[@-~]`,
    `${introducer}\\][^${introducer}${bell}]*(?:${bell}|${introducer}${slash}${slash})`,
    `${introducer}[@-Z${slash}${slash}\\]^_]`,
  ].join("|"),
  "g",
);
function stripEscapes(text: string) {
  return text.replace(escapes, "");
}
// After escape removal, text is binary only if it is mostly non-printable: a single stray
// control character in a log must not turn the whole artifact into metadata.
function controlRatio(text: string) {
  let controls = 0;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable++;
      continue;
    }
    if (
      code < 32 ||
      code === 127 ||
      (code >= 128 && code <= 159) ||
      code === 0xfffd
    )
      controls++;
    else printable++;
  }
  return printable + controls === 0 ? 1 : controls / (printable + controls);
}
const controlAllowance = (length: number) =>
  Math.max(2 / Math.max(1, length), 0.02);
// Whatever survives escape removal is still scrubbed before it can reach a model: escape
// introducers, C0/C1 controls, soft hyphens, zero-width and bidirectional overrides go away.
function scrub(text: string) {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13) {
      out += char;
      continue;
    }
    if (
      code === 27 ||
      code < 32 ||
      code === 127 ||
      (code >= 128 && code <= 159) ||
      code === 0xad ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    )
      out += " ";
    else out += char;
  }
  return out;
}
