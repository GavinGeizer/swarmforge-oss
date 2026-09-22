import {
  createOpencodeClient,
  type Config as OpenCodeConfig,
} from "@opencode-ai/sdk/v2";
import { type Config, gitTree } from "../config";
import {
  type AgentSnapshot,
  type CodingAgent,
  type Dispatch,
  resultSchema,
  type Worker,
} from "../domain";
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
    ? `The source repository was cloned to ${c.SWARMFORGE_WORKSPACE}/repo; work there and persist changes back to that remote.`
    : `SWARMFORGE_GIT_TREE identifies the externally managed source tree; inspect that environment variable and use the existing tools to access it. It may be a mount, repository URL, or prepared tree. SwarmForge does not clone it.`;
  return `Worker ${w.worker_id}, task ${w.task_id}, role ${w.role}. Run ID: ${d.run_id}.
Your starting workspace is ${c.SWARMFORGE_WORKSPACE}. ${source}
Run relevant tests and report failures honestly. Persist source changes to the supplied durable Git location before declaring coding work complete; a local commit alone may not be durable. Report git.workspace if you work elsewhere, branch/commit/dirty/persisted when known. Never report credentials.
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
    const [status, messages] = await Promise.all([
      client.session.status(),
      client.session.messages({ sessionID: w.opencode_session_id, limit: 100 }),
    ]);
    if (!messages.data) throw new Error("Missing OpenCode messages");
    const all = [...messages.data];
    let page = messages.data;
    const cursors = new Set<string>();
    while (page.length === 100) {
      const before = page.map((m) => m.info.id).sort()[0];
      if (!before || cursors.has(before))
        throw new Error("OpenCode message pagination did not advance");
      cursors.add(before);
      const older = await client.session.messages({
        sessionID: w.opencode_session_id,
        limit: 100,
        before,
      });
      if (!older.data) throw new Error("Missing OpenCode message page");
      page = older.data;
      all.unshift(...page);
    }
    const mapped = all.map(({ info, parts }) =>
      info.role === "assistant"
        ? {
            id: info.id,
            parent_id: info.parentID,
            role: info.role,
            completed: !!info.time.completed,
            result:
              info.structured ??
              parseJsonText(
                parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
              ),
            error: info.error?.name,
            model: info.modelID,
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
          },
    );
    return {
      status: status.data?.[w.opencode_session_id]?.type ?? "idle",
      messages: mapped,
      inference_active: mapped.some(
        (m) => m.role === "assistant" && !m.completed,
      )
        ? 1
        : 0,
    };
  }
  async abort(w: Worker) {
    if (w.opencode_session_id)
      await this.client(w).session.abort({ sessionID: w.opencode_session_id });
  }
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
