import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redact } from "../settings/inspect";
import type { OverviewData, WorkerSummary } from "./overview";

interface SwarmStatus {
  states: Record<string, number>;
  tokens: { total: number };
  metrics: { enabled: boolean; port: number };
}

interface WorkerPage {
  workers: WorkerSummary[];
  total: number;
  next_offset: number | null;
}

export interface ArtifactSummary {
  artifact_id: string;
  filename: string;
  state: string;
  size: number | null;
  sha256: string | null;
}
export interface WorkerDetail {
  artifacts?: ArtifactSummary[];
  artifactsNextOffset?: number | null;
  worker: WorkerSummary & {
    vm_id?: string | null;
    opencode_session_id?: string | null;
    pending_messages?: number;
    excerpt?: string;
    excerpt_partial?: boolean;
    excerpt_at?: number;
  };
  result: { status?: string; summary?: string; warnings?: string[] } | null;
  events: { id: number; type: string; at: number; data: string }[];
  serviceLog: string | null;
}

function structured<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  if (!("content" in result) || !Array.isArray(result.content))
    throw new Error("MCP tool returned an unsupported task response");
  if (result.isError) {
    const message = result.content
      .filter(
        (item): item is { type: "text"; text: string } =>
          !!item &&
          typeof item === "object" &&
          item.type === "text" &&
          typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");
    throw new Error(message || "MCP tool failed");
  }
  if (!result.structuredContent)
    throw new Error("MCP tool returned no structured content");
  return result.structuredContent as T;
}

export async function connectSwarmForge(
  url: string,
  token?: string,
  scrubText: (text: string) => string = (text) => redact(text, [token ?? ""]),
) {
  const client = new Client({ name: "swarmforge-cli", version: "0.1.0" });
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const attempt = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw new Error(
        scrubText(
          error instanceof Error ? error.message : "MCP request failed",
        ),
      );
    }
  };
  // The raw URL is used only by the transport. Every display and error surface,
  // including dashboard refresh/control calls, retains the credential context.
  await attempt(() =>
    client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: headers ? { headers } : undefined,
      }),
    ),
  );
  const call = async <T>(name: string, args: Record<string, unknown>) =>
    attempt(async () =>
      structured<T>(await client.callTool({ name, arguments: args })),
    );
  const artifacts = (workerId: string) =>
    call<{ artifacts: ArtifactSummary[]; next_offset: number | null }>(
      "list_artifacts",
      { worker_id: workerId, limit: 3 },
    );
  let settledCleanupSupported: Promise<boolean> | undefined;
  return {
    artifacts,
    retryPreservation: (workerId: string) =>
      call("retry_worker_finalization", { worker_id: workerId }),
    worker: (workerId: string) =>
      call<WorkerDetail["worker"]>("get_worker", { worker_id: workerId }),
    async result(workerId: string): Promise<WorkerDetail["result"]> {
      const response = await call<{ result: WorkerDetail["result"] }>(
        "get_worker_result",
        { worker_id: workerId },
      );
      return response.result;
    },
    async overview(): Promise<OverviewData> {
      const status = await call<SwarmStatus>("get_swarm_status", {});
      const workers: WorkerSummary[] = [];
      let offset = 0;
      while (true) {
        const page = await call<WorkerPage>("list_workers", {
          offset,
          limit: 100,
        });
        workers.push(...page.workers);
        if (page.next_offset === null) break;
        if (page.next_offset <= offset)
          throw new Error("MCP worker pagination did not advance");
        offset = page.next_offset;
      }
      return {
        url: scrubText(url),
        metrics: status.metrics,
        states: status.states,
        tokens: status.tokens,
        workers,
      };
    },
    async inspect(workerId: string): Promise<WorkerDetail> {
      const [worker, result, logs, preserved] = await Promise.all([
        call<WorkerDetail["worker"]>("get_worker", { worker_id: workerId }),
        call<{ result: WorkerDetail["result"] }>("get_worker_result", {
          worker_id: workerId,
        }),
        call<{ events: WorkerDetail["events"]; opencode: string | null }>(
          "get_worker_logs",
          { worker_id: workerId, limit: 100 },
        ),
        artifacts(workerId),
      ]);
      return {
        worker,
        result: result.result,
        events: logs.events,
        serviceLog: logs.opencode,
        artifacts: preserved.artifacts,
        artifactsNextOffset: preserved.next_offset,
      };
    },
    async control(
      workerId: string,
      action: "pause" | "resume" | "cancel" | "destroy",
      options: { settledOnly?: boolean } = {},
    ) {
      if (options.settledOnly) {
        if (action !== "destroy")
          throw new Error("Settled cleanup only supports destruction");
        settledCleanupSupported ??= attempt(async () => {
          const tools = await client.listTools();
          const destroy = tools.tools.find(
            (tool) => tool.name === "destroy_worker",
          );
          return (
            !!destroy?.inputSchema.properties &&
            Object.hasOwn(destroy.inputSchema.properties, "settled_only")
          );
        });
        let supported: boolean;
        try {
          supported = await settledCleanupSupported;
        } catch (error) {
          settledCleanupSupported = undefined;
          throw error;
        }
        if (!supported)
          throw new Error(
            "This server does not support settled cleanup. Update/restart the server and reopen the dashboard.",
          );
      }
      return call<WorkerDetail["worker"]>(`${action}_worker`, {
        worker_id: workerId,
        ...(action === "destroy"
          ? {
              force: false,
              ...(options.settledOnly ? { settled_only: true } : {}),
            }
          : {}),
      });
    },
    close: () => attempt(() => client.close()),
  };
}
