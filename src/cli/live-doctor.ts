import { Freestyle } from "freestyle";
import type { Config } from "../config";
import { quote } from "../providers/freestyle";

export interface ReadinessCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}
/** Explicitly invoked probes only. No worker provisioning, deployment mutation, or Git push. */
export async function liveDoctorChecks(
  config: Config,
  vmId?: string,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const timeout = Math.min(config.SWARMFORGE_API_TIMEOUT_MS, 30000);
  const providerAbort = new AbortController();
  const providerDeadline = setTimeout(
    () => providerAbort.abort(new Error("Provider readiness probe timed out")),
    timeout,
  );
  const origin = new URL(config.FREESTYLE_API_URL).origin;
  const client = new Freestyle({
    apiKey: config.FREESTYLE_API_TOKEN,
    baseUrl: config.FREESTYLE_API_URL,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin)
        throw new Error(
          "Provider probe refused a cross-origin background result URL",
        );
      const response = await fetch(input, {
        ...init,
        redirect: "error",
        signal: providerAbort.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) return response;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 65536)
            throw new Error("Provider probe response exceeds 64 KiB");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }) as typeof fetch,
  });
  const inspectProvider = async () => {
    const snapshot = await client.vms.snapshots.get(
      config.FREESTYLE_SNAPSHOT_ID,
    );
    checks.push({
      name: "Live snapshot access",
      status: "pass",
      message: `Snapshot ${snapshot.id} is accessible; boot permissions and contents are not proven by metadata access.`,
    });
    if (vmId) {
      const vm = await client.vms.get(vmId);
      if (vm.state !== "running")
        throw new Error(
          "Guest check requires an existing running VM; paused VMs are not resumed.",
        );
      if (vm.snapshotId !== snapshot.id)
        throw new Error(
          "Existing VM does not identify the configured snapshot; guest compatibility cannot be attributed to this snapshot.",
        );
      const guest = await client.vms.ref(vm.id).exec({
        command: `command -v opencode >/dev/null && command -v python3 >/dev/null && command -v git >/dev/null && command -v systemctl >/dev/null && test -d /run/systemd/system && test -d ${quote(config.SWARMFORGE_WORKSPACE)} && test -w ${quote(config.SWARMFORGE_WORKSPACE)}`,
        linuxUser: "root",
        timeoutMs: timeout,
      });
      checks.push({
        name: "Live guest prerequisites",
        status: guest.statusCode === 0 ? "pass" : "fail",
        message:
          guest.statusCode === 0
            ? "OpenCode, Python 3, Git, systemd and a writable workspace are available in the existing VM."
            : "Guest tools, running systemd, or writable workspace are missing; inspect the configured snapshot.",
      });
    } else
      checks.push({
        name: "Live guest prerequisites",
        status: "warn",
        message:
          "Snapshot contents and VM creation permissions remain unverified. Supply --vm ID from an existing running VM based on this snapshot to inspect guest prerequisites.",
      });
  };
  try {
    await Promise.race([
      inspectProvider(),
      new Promise<never>((_, reject) =>
        providerAbort.signal.addEventListener(
          "abort",
          () => reject(providerAbort.signal.reason),
          { once: true },
        ),
      ),
    ]);
  } catch (error) {
    checks.push({
      name: "Live provider readiness",
      status: "fail",
      message: error instanceof Error ? error.message : "Provider probe failed",
    });
  } finally {
    clearTimeout(providerDeadline);
    providerAbort.abort();
  }
  try {
    const url = new URL(config.SWARMFORGE_MODEL_BASE_URL);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
    url.username = "";
    url.password = "";
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: {
        authorization: `Bearer ${config.SWARMFORGE_MODEL_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.SWARMFORGE_MODEL_NAME,
        messages: [
          {
            role: "user",
            content:
              "Call swarmforge_readiness with ok=true. Do not return text.",
          },
        ],
        max_tokens: 64,
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "swarmforge_readiness",
              description: "Report readiness",
              parameters: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "swarmforge_readiness" },
        },
      }),
    });
    if (!response.ok)
      throw new Error(
        `Model probe returned HTTP ${response.status}; check endpoint, model access, and tool-call support.`,
      );
    // Refuse large diagnostic bodies; provider text is never emitted raw.
    if (Number(response.headers.get("content-length") ?? 0) > 65536)
      throw new Error("Model probe response exceeds 64 KiB");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Model probe returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536)
          throw new Error("Model probe response exceeds 64 KiB");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      choices?: {
        message?: {
          tool_calls?: { function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };
    const tool = data.choices?.[0]?.message?.tool_calls?.find(
      (call) => call.function?.name === "swarmforge_readiness",
    );
    if (
      !tool?.function?.arguments ||
      JSON.parse(tool.function.arguments).ok !== true
    )
      throw new Error(
        "Model did not return the required structured tool call; compatibility is unverified.",
      );
    checks.push({
      name: "Live model tool calls",
      status: "pass",
      message:
        "Configured model accepted a bounded inference request and returned a valid tool call. Full worker execution remains unverified.",
    });
  } catch (error) {
    checks.push({
      name: "Live model tool calls",
      status: "fail",
      message: error instanceof Error ? error.message : "Model probe failed",
    });
  }
  checks.push({
    name: "Git permissions",
    status: "warn",
    message:
      "Git push permissions are not exercised by readiness checks; source handoff remains checked during normal finalization.",
  });
  return checks;
}
