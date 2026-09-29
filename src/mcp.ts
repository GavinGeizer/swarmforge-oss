import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Coordinator } from "./coordinator";
import { idSchema, spawnSchema, states } from "./domain";
import { WorkerFiles } from "./files";
import { publicWorker, redactorFor } from "./security";
export function createMcpServer(c: Coordinator, signal?: AbortSignal) {
  const server = new McpServer({ name: "swarmforge", version: "0.1.0" });
  const files = new WorkerFiles(c);
  const redactor = redactorFor(c);
  const worker = { worker_id: idSchema };
  const page = {
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
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
      async (args): Promise<CallToolResult> => {
        try {
          const data = redactor.value(
            await action(z.object(schema).parse(args)),
          );
          const json = JSON.stringify(data);
          if (Buffer.byteLength(json) > 131072)
            throw new Error("Response exceeds limit; request a smaller page");
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
                          e instanceof Error ? e.message : "Operation failed",
                        )
                        .slice(0, 2000),
              },
            ],
          };
        }
      },
    );
  }
  register(
    "spawn_worker",
    "Queue an isolated coding worker. Returns immediately; use request_id for safe retries.",
    spawnSchema.shape,
    (a) => {
      const w = c.spawn(a);
      return {
        worker_id: w.worker_id,
        task_id: w.task_id,
        team_id: w.team_id,
        state: w.state,
      };
    },
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
      const all = c.store
        .all()
        .filter(
          (w) =>
            (!a.team_id || w.team_id === a.team_id) &&
            (!a.task_id || w.task_id === a.task_id) &&
            (!a.state || w.state === a.state),
        );
      return {
        workers: all
          .slice(a.offset, a.offset + a.limit)
          .map((w) => publicWorker(c, w.worker_id)),
        total: all.length,
        next_offset:
          a.offset + a.limit < all.length ? a.offset + a.limit : null,
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
    "Permanently destroy a worker after persistence checks. force=true explicitly permits losing local work.",
    { ...worker, force: z.boolean().default(false) },
    async (a) => {
      await c.control(a.worker_id, "destroy", a.force);
      return publicWorker(c, a.worker_id);
    },
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
  server.registerTool(
    "get_worker_artifact",
    {
      description:
        "Return an MCP resource link for a bounded binary chunk. Read the resource explicitly; use next_offset for large files.",
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
        const handle = await files.artifact(
          a.worker_id,
          a.path,
          a.offset,
          a.length,
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
      states: counts(c.store.all().map((w) => w.state)),
      tokens: c.store.tokens(),
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
      const bytes = await files.readArtifact(
        decodeURIComponent(match[1]!),
        decodeURIComponent(match[2]!),
        Number(url.searchParams.get("offset") ?? 0),
        Number(url.searchParams.get("length") ?? 32768),
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
