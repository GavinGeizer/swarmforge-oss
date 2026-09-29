import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

export interface WorkerDetail {
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

export async function connectSwarmForge(url: string, token?: string) {
  const client = new Client({ name: "swarmforge-cli", version: "0.1.0" });
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown>) =>
    structured<T>(await client.callTool({ name, arguments: args }));
  return {
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
        url,
        metrics: status.metrics,
        states: status.states,
        tokens: status.tokens,
        workers,
      };
    },
    async inspect(workerId: string): Promise<WorkerDetail> {
      const [worker, result, logs] = await Promise.all([
        call<WorkerDetail["worker"]>("get_worker", { worker_id: workerId }),
        call<{ result: WorkerDetail["result"] }>("get_worker_result", {
          worker_id: workerId,
        }),
        call<{ events: WorkerDetail["events"]; opencode: string | null }>(
          "get_worker_logs",
          { worker_id: workerId, limit: 100 },
        ),
      ]);
      return {
        worker,
        result: result.result,
        events: logs.events,
        serviceLog: logs.opencode,
      };
    },
    async control(
      workerId: string,
      action: "pause" | "resume" | "cancel" | "destroy",
    ) {
      return call<WorkerDetail["worker"]>(`${action}_worker`, {
        worker_id: workerId,
        ...(action === "destroy" ? { force: false } : {}),
      });
    },
    close: () => client.close(),
  };
}
