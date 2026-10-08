import { z } from "zod";
export const githubIssuer = "https://github.com/login/oauth";
export interface ProviderCredentials {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}
export interface VerifiedIdentity {
  subject: string;
  login: string;
}
export interface IdentityProvider {
  verify(
    code: string,
    verifier: string,
    redirect: string,
    env: ProviderCredentials,
  ): Promise<VerifiedIdentity>;
}
const identitySchema = z.object({
  id: z.number().int().positive().safe(),
  login: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-zA-Z0-9-]+$/),
});
async function boundedJson(response: Response) {
  if (!response.ok) throw new Error("Provider rejected request");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned no data");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Provider response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export class GitHubIdentityProvider implements IdentityProvider {
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = (input, init) => fetch(input, init)) {
    this.request = request;
  }
  async verify(
    code: string,
    verifier: string,
    redirect: string,
    env: ProviderCredentials,
  ): Promise<VerifiedIdentity> {
    const exchange = await this.request(`${githubIssuer}/access_token`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
      }),
    });
    const result = z
      .object({
        access_token: z.string().min(1).max(4096),
        token_type: z.literal("bearer"),
      })
      .parse(await boundedJson(exchange));
    const user = await this.request("https://api.github.com/user", {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${result.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "swarmforge-cloud",
        "x-github-api-version": "2022-11-28",
      },
    });
    const identity = identitySchema.parse(await boundedJson(user));
    return { subject: String(identity.id), login: identity.login };
  }
}
