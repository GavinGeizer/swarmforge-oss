import {
  createOpencodeClient,
  type Message,
  type Config as OpenCodeConfig,
  type Part,
} from "@opencode-ai/sdk/v2";
import { type Config, gitTree } from "../config";
import {
  type AgentSnapshot,
  type CodingAgent,
  type Dispatch,
  resultSchema,
  type Worker,
} from "../domain";
import { branchFor } from "../git-handoff";
export function openCodeConfig(c: Config): OpenCodeConfig {
  return {
    model: `swarmforge/${c.SWARMFORGE_MODEL_NAME}`,
    small_model: `swarmforge/${c.SWARMFORGE_MODEL_NAME}`,
    share: "disabled",
    autoupdate: false,
    permission: { "*": "allow", question: "deny" },
    provider: {
      swarmforge: {
        npm: "@ai-sdk/openai-compatible",
        name: "SwarmForge inference",
        options: {
          baseURL: c.SWARMFORGE_MODEL_BASE_URL,
          apiKey: "{env:SWARMFORGE_MODEL_API_KEY}",
        },
        models: {
          [c.SWARMFORGE_MODEL_NAME]: { name: c.SWARMFORGE_MODEL_NAME },
        },
      },
    },
  };
}
export function bootstrap(c: Config, w: Worker, d: Dispatch) {
  const tree = gitTree(c.SWARMFORGE_GIT_TREE);
  const source = tree.clone
    ? c.SWARMFORGE_GIT_PUSH_MODE !== "none"
      ? `The source repository was cloned to ${c.SWARMFORGE_WORKSPACE}/repo on branch ${branchFor(w)}. Work there, run tests, and commit all source changes on that branch. SwarmForge will push and verify the branch after your result. Report persisted=false until SwarmForge verifies the push. Do not put credentials in Git remotes or result output.`
      : `The source repository was cloned to ${c.SWARMFORGE_WORKSPACE}/repo; work there and persist changes back to that remote.`
    : `SWARMFORGE_GIT_TREE identifies the externally managed source tree; inspect that environment variable and use the existing tools to access it. It may be a mount, repository URL, or prepared tree. SwarmForge does not clone it.`;
  const persistence =
    c.SWARMFORGE_GIT_PUSH_MODE === "none"
      ? "Persist source changes to the supplied durable Git location before declaring coding work complete; a local commit alone may not be durable."
      : "Commit source changes locally before declaring coding work complete; SwarmForge handles remote persistence.";
  return `Worker ${w.worker_id}, task ${w.task_id}, role ${w.role}. Run ID: ${d.run_id}.
Your starting workspace is ${c.SWARMFORGE_WORKSPACE}. ${source}
Run relevant tests and report failures honestly. ${persistence} Report git.workspace if you work elsewhere, branch/commit/dirty/persisted when known. Never report credentials.
Return the requested structured result with worker_id=${w.worker_id}, task_id=${w.task_id}, run_id=${d.run_id}. Also atomically write the same JSON to ${c.SWARMFORGE_WORKSPACE}/.swarmforge/result.json before your final response. Put non-source artifacts under .swarmforge/artifacts and task logs under .swarmforge/logs. Preserve failures and warnings; don't claim tests you didn't run.
Respond with exactly one JSON object and no markdown. It must match this JSON Schema: ${JSON.stringify(resultSchema.toJSONSchema())}
The team lead's task follows.`;
}
export class OpenCodeAgent implements CodingAgent {
  constructor(
    readonly config: Config,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  client(w: Worker) {
    if (!w.endpoint) throw new Error("OpenCode endpoint missing");
    return createOpencodeClient({
      baseUrl: w.endpoint,
      directory: this.config.SWARMFORGE_WORKSPACE,
      throwOnError: true,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${w.server_password}`).toString("base64")}`,
      },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        this.fetcher(
          new Request(input, {
            ...init,
            signal: AbortSignal.timeout(this.config.SWARMFORGE_API_TIMEOUT_MS),
          }),
        )) as typeof fetch,
    });
  }
  async ensureSession(w: Worker) {
    const client = this.client(w);
    if (w.opencode_session_id) {
      await client.session.get({ sessionID: w.opencode_session_id });
      return w.opencode_session_id;
    }
    const title = `swarmforge:${w.worker_id}`;
    const list = await client.session.list({ search: title, limit: 100 });
    const existing = list.data?.find((s) => s.title === title);
    if (existing) return existing.id;
    const created = await client.session.create({ title });
    if (!created.data)
      throw new Error("OpenCode session creation returned no session");
    return created.data.id;
  }
  async submit(w: Worker, d: Dispatch) {
    if (!w.opencode_session_id) throw new Error("OpenCode session missing");
    await this.client(w).session.promptAsync({
      sessionID: w.opencode_session_id,
      messageID: d.message_id,
      model: {
        providerID: "swarmforge",
        modelID: this.config.SWARMFORGE_MODEL_NAME,
      },
      system: bootstrap(this.config, w, d),
      parts: [{ type: "text", text: d.message }],
    });
  }
  async inspect(w: Worker): Promise<AgentSnapshot> {
    if (!w.opencode_session_id) throw new Error("OpenCode session missing");
    const client = this.client(w);
    // /session/status and the message window are settled independently. A history fault used
    // to reject this whole Promise.all, which froze the reported status, the usage rows and
    // the completion signal for a turn the server was still running.
    const [status, history] = await Promise.allSettled([
      client.session.status(),
      this.messageWindow(w),
    ]);
    // A status this call could not read is never guessed: it stays a retryable failure.
    if (status.status === "rejected") throw status.reason;
    // Only a rejected window that is not a degraded read reaches this point, and those are
    // retryable faults the coordinator must see.
    if (history.status === "rejected") throw history.reason;
    const window = history.value;
    const mapped = window.map(({ info, parts }) => {
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return info.role === "assistant"
        ? {
            id: info.id,
            parent_id: info.parentID,
            role: info.role,
            completed: !!info.time.completed,
            result: info.structured ?? parseJsonText(text),
            error: info.error?.name,
            model: info.modelID,
            text: tailText(text),
            input: info.tokens.input,
            output: info.tokens.output,
            reasoning: info.tokens.reasoning,
            cache_read: info.tokens.cache.read,
            cache_write: info.tokens.cache.write,
          }
        : {
            id: info.id,
            role: info.role,
            completed: true,
            input: 0,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_write: 0,
          };
    });
    const inference_active = mapped.some(
      (m) => m.role === "assistant" && !m.completed,
    );
    return {
      status: sessionStatus(status.value.data?.[w.opencode_session_id]?.type),
      messages: mapped,
      inference_active: inference_active ? 1 : 0,
    };
  }
  // The newest page of a session, and only that page. OpenCode 1.18.31 accepts `limit` and
  // nothing else on this route: there is no before, offset or cursor, `before` is rejected
  // with HTTP 400 and an omitted limit returns the whole history unbounded. Walking older
  // pages is therefore impossible, and inventing a cursor is worse than being bounded.
  private async messageWindow(
    w: Worker,
  ): Promise<{ info: Message; parts: Part[] }[]> {
    const client = this.client(w);
    try {
      return await newestPage(client, w, MESSAGE_WINDOW);
    } catch (error) {
      // 400 means this server rejected the query, not that the session is gone, so the one
      // supported knob is retried once at a smaller bound: a fixed ladder, never a loop.
      if (httpStatus(error) !== 400) throw error;
      try {
        return await newestPage(client, w, MESSAGE_WINDOW_FALLBACK);
      } catch (retry) {
        if (httpStatus(retry) !== 400) throw retry;
        // Neither bound is accepted, so the history is degraded rather than failed: the
        // reported status is still authoritative and keeps flowing.
        return [];
      }
    }
  }
  async abort(w: Worker) {
    if (w.opencode_session_id)
      await this.client(w).session.abort({ sessionID: w.opencode_session_id });
  }
}

// One bounded page, newest first, exactly as the server returns it. A full page means older
// history exists and is unreachable through the supported route; it is never claimed as read.
const MESSAGE_WINDOW = 100;
const MESSAGE_WINDOW_FALLBACK = 20;

async function newestPage(
  client: ReturnType<OpenCodeAgent["client"]>,
  w: Worker,
  limit: number,
): Promise<{ info: Message; parts: Part[] }[]> {
  const page = await client.session.messages({
    sessionID: w.opencode_session_id as string,
    limit,
  });
  if (!page.data) throw new Error("Missing OpenCode messages");
  return page.data;
}

// With throwOnError the SDK raises an Error whose cause carries the HTTP status.
function httpStatus(error: unknown): number | undefined {
  const status = (error as { cause?: { status?: number } })?.cause?.status;
  return typeof status === "number" ? status : undefined;
}

// /session/status is polled for the whole OpenCode server and lists only sessions with
// work, so an absent entry is the normal shape of a finished turn and is read as idle. A
// reported type this version does not recognize is not read as idle either: it becomes
// unknown, which never settles a turn. Message history never decides the status: an
// assistant message without time.completed is left behind by a restart, an OOM or an abort
// and is estimated through inference_active alone.
function sessionStatus(reported: string | undefined): AgentSnapshot["status"] {
  if (reported === undefined) return "idle";
  return reported === "idle" || reported === "busy" || reported === "retry"
    ? reported
    : "unknown";
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Assistant text is unbounded; keep only its tail, on code point boundaries, for the live excerpt.
function tailText(text: string, limit = 4096) {
  const chars = [...text];
  if (chars.length <= limit) return text;
  return chars.slice(chars.length - limit).join("");
}
