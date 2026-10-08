import { execSync } from "node:child_process";
import { CloudClient } from "../cloud-client";
import {
  deleteCloudCredential,
  getCloudCredentialOpt,
  saveCloudCredential,
} from "../cloud-credentials";
import type { ParsedCommand } from "./arguments";

function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
  } catch {
    // Browser open failed silently
  }
}

function validateCloudUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        throw new Error("Cloud URL must use HTTPS or be localhost/127.0.0.1");
      }
    }
    return parsed.origin;
  } catch {
    throw new Error("Invalid cloud URL format");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function cloudCommand(
  command: Extract<ParsedCommand, { kind: "cloud" }>,
  write: (message: string) => void,
): Promise<number> {
  const env = process.env;
  const cloudUrl = command.cloudUrl ?? env.SWARMFORGE_CLOUD_URL;

  if (command.action === "status") {
    const cred = getCloudCredentialOpt(env);
    if (!cred) {
      write(
        "Not logged in to cloud. Run `swarmforge cloud login` to authenticate.",
      );
      return 1;
    }

    const now = Date.now();
    const expired = cred.expires_at <= now + 60000;
    const authExpired = cred.authorization_expires_at <= now + 60000;

    if (command.json) {
      write(
        JSON.stringify({
          logged_in: true,
          tenant_id: cred.tenant_id,
          subject_id: cred.subject_id,
          expires_at: cred.expires_at,
          authorization_expires_at: cred.authorization_expires_at,
          expired,
          authorization_expired: authExpired,
        }),
      );
    } else {
      write(`Cloud login: authenticated`);
      write(`Tenant: ${cred.tenant_id}`);
      write(`Subject: ${cred.subject_id}`);
      write(`Expires: ${new Date(cred.expires_at).toISOString()}`);
      write(
        `Authorization expires: ${new Date(cred.authorization_expires_at).toISOString()}`,
      );
    }

    return expired ? 1 : 0;
  }

  if (command.action === "logout") {
    deleteCloudCredential(command.credentials, env);
    write(
      "Cloud credentials removed. Run `swarmforge cloud login` to authenticate again.",
    );
    return 0;
  }

  if (command.action === "organizations") {
    if (!cloudUrl) {
      throw new Error(
        "Cloud URL required. Set --cloud-url or SWARMFORGE_CLOUD_URL.",
      );
    }

    const cred = getCloudCredentialOpt(env);
    if (!cred) {
      throw new Error(
        "Not logged in to cloud. Run `swarmforge cloud login` to authenticate.",
      );
    }

    const client = new CloudClient(validateCloudUrl(cloudUrl), cred.credential);

    if (command.action === "organizations") {
      const result = await client.organizations();
      if (command.json) {
        write(JSON.stringify({ items: result.items }));
      } else {
        write("Organizations:");
        for (const org of result.items) {
          write(`  ${org.displayName} (${org.tenantId}) - ${org.role}`);
        }
      }
    }

    return 0;
  }

  if (command.action === "use") {
    if (!cloudUrl) {
      throw new Error(
        "Cloud URL required. Set --cloud-url or SWARMFORGE_CLOUD_URL.",
      );
    }

    if (!command.tenantId || !isUuid(command.tenantId)) {
      throw new Error("Invalid tenant ID (UUID required)");
    }

    const currentCred = getCloudCredentialOpt(env);

    const client = new CloudClient(validateCloudUrl(cloudUrl), "placeholder");

    const { linkId, userCode, verificationUrl } = await client.createLink(
      "swarmforge-cli",
      command.tenantId,
    );

    write(`Open ${verificationUrl} and enter code ${userCode}.`);

    if (!command.noBrowser) {
      openBrowser(verificationUrl);
    }

    const pollInterval = 5;
    let credential: string | undefined;

    try {
      const result = await client.exchangeLink(
        linkId,
        "",
        pollInterval,
        new AbortController().signal,
      );

      credential = result.credential;
    } catch {
      await client.cancelLink(linkId, "");
      throw new Error("Authorization failed. Try again.");
    }

    const verifyClient = new CloudClient(
      validateCloudUrl(cloudUrl),
      credential,
    );
    const me = await verifyClient.me();

    saveCloudCredential(
      command.credentials,
      {
        version: 1,
        credential: credential,
        credential_id: me.installationId,
        installation_id: me.installationId,
        subject_id: me.subjectId,
        tenant_id: me.tenantId,
        scopes: me.scopes,
        expires_at: me.expiresAt,
        authorization_expires_at: me.authorizationExpiresAt,
        server_url: cloudUrl,
      },
      env,
    );

    if (currentCred && currentCred.installation_id !== me.installationId) {
      try {
        const oldClient = new CloudClient(
          validateCloudUrl(cloudUrl),
          currentCred.credential,
        );
        await oldClient.revoke();
      } catch {}
    }

    write(`Connected to tenant ${me.tenantId}.`);
    return 0;
  }

  if (command.action === "login") {
    if (!cloudUrl) {
      throw new Error(
        "Cloud URL required. Set --cloud-url or SWARMFORGE_CLOUD_URL.",
      );
    }

    const client = new CloudClient(validateCloudUrl(cloudUrl), "placeholder");

    const { linkId, userCode, verificationUrl } = await client.createLink(
      command.clientName ?? "swarmforge-cli",
    );

    write(`Open ${verificationUrl} and enter code ${userCode}.`);

    if (!command.noBrowser) {
      openBrowser(verificationUrl);
    }

    const pollInterval = 5;
    let credential: string | undefined;

    try {
      const result = await client.exchangeLink(
        linkId,
        "",
        pollInterval,
        new AbortController().signal,
      );

      credential = result.credential;
    } catch (error) {
      await client.cancelLink(linkId, "");
      throw error;
    }

    const verifyClient = new CloudClient(
      validateCloudUrl(cloudUrl),
      credential,
    );
    const me = await verifyClient.me();

    saveCloudCredential(
      command.credentials,
      {
        version: 1,
        credential: credential,
        credential_id: me.installationId,
        installation_id: me.installationId,
        subject_id: me.subjectId,
        tenant_id: me.tenantId,
        scopes: me.scopes,
        expires_at: me.expiresAt,
        authorization_expires_at: me.authorizationExpiresAt,
        server_url: cloudUrl,
      },
      env,
    );

    if (command.json) {
      write(
        JSON.stringify({
          logged_in: true,
          tenant_id: me.tenantId,
          subject_id: me.subjectId,
          expires_at: me.expiresAt,
          authorization_expires_at: me.authorizationExpiresAt,
        }),
      );
    } else {
      write(`Connected to tenant ${me.tenantId}.`);
      write(`Credentials saved to: ${command.credentials}`);
    }

    return 0;
  }

  throw new Error(`Unknown cloud action: ${command.action}`);
}
