import { spawn } from "node:child_process";
import { CloudClient } from "../cloud-client";
import {
  type CloudCredential,
  cloudCredentialPath,
  cloudOrigin,
  deleteCloudCredential,
  readCloudCredential,
  saveCloudCredential,
} from "../cloud-credentials";
import type { ParsedCommand } from "./arguments";

function browser(url: string) {
  const executable = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(executable, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
export async function cloudCommand(
  command: Extract<ParsedCommand, { kind: "cloud" }>,
  write: (text: string) => void,
) {
  const path = cloudCredentialPath(command.credentials),
    previous = readCloudCredential(path);
  const selected = command.cloudUrl ?? process.env.SWARMFORGE_CLOUD_URL;
  const origin = selected ? cloudOrigin(selected) : previous?.server_url;
  const output = (value: Record<string, unknown>, text: string) =>
    write(command.json ? JSON.stringify(value) : text);
  if (command.action === "login" || command.action === "use") {
    if (!origin)
      throw new Error(
        "Set --cloud-url or SWARMFORGE_CLOUD_URL to the Cloud API origin.",
      );
    const client = new CloudClient(origin),
      link = await client.start(
        command.clientName ?? "SwarmForge CLI",
        command.action === "use" ? command.tenantId : undefined,
      ),
      controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      output(
        {
          event: "pairing",
          verification_url: link.verification_url,
          user_code: link.user_code,
        },
        `Open ${link.verification_url} and enter pairing code ${link.user_code}.`,
      );
      if (!command.noBrowser && process.stdin.isTTY)
        browser(link.verification_url);
      const issued = await client.exchange(link, controller.signal);
      if (command.action === "use" && issued.tenant_id !== command.tenantId)
        throw new Error(
          "Cloud organization approval does not match the requested organization.",
        );
      const credential: CloudCredential = {
        ...issued,
        version: 1,
        server_url: origin,
      };
      try {
        saveCloudCredential(path, credential);
      } catch (e) {
        try {
          await new CloudClient(origin, issued.credential).revoke();
        } catch {}
        throw e;
      }
      let previousRevoked = true;
      if (previous) {
        try {
          await new CloudClient(
            previous.server_url,
            previous.credential,
          ).revoke();
        } catch {
          previousRevoked = false;
        }
      }
      output(
        {
          linked: true,
          installation_id: issued.installation_id,
          subject_id: issued.subject_id,
          tenant_id: issued.tenant_id,
          expires_at: issued.expires_at,
          authorization_expires_at: issued.authorization_expires_at,
          previous_revocation_confirmed: previousRevoked,
        },
        `Cloud CLI connected to organization ${issued.tenant_id}.${previousRevoked ? "" : " Previous installation revocation was not confirmed; revoke it in the website device API."}`,
      );
      return 0;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  }
  if (!previous) {
    output(
      { linked: false },
      "Cloud CLI is signed out. Run swarmforge cloud login.",
    );
    return command.action === "logout" ? 0 : 1;
  }
  if (origin !== previous.server_url)
    throw new Error(
      "Cloud URL differs from the stored credential origin. Run cloud login to authorize this service.",
    );
  const client = new CloudClient(previous.server_url, previous.credential);
  if (command.action === "logout") {
    let revoked = false;
    try {
      await client.revoke();
      revoked = true;
    } catch {}
    deleteCloudCredential(path);
    output(
      { linked: false, server_revocation_confirmed: revoked },
      revoked
        ? "Cloud installation revoked; local credentials removed."
        : "Local cloud credentials removed. Server revocation was not confirmed; revoke the installation through the website device API.",
    );
    return revoked ? 0 : 1;
  }
  if (
    previous.expires_at <= Date.now() ||
    previous.authorization_expires_at <= Date.now()
  )
    throw new Error(
      "Cloud credential has expired. Run swarmforge cloud login.",
    );
  if (command.action === "status") {
    const me = await client.me();
    if (
      me.installation_id !== previous.installation_id ||
      me.tenant_id !== previous.tenant_id ||
      me.subject_id !== previous.subject_id
    )
      throw new Error("Cloud identity does not match the stored installation.");
    output(
      { linked: true, ...me },
      `Cloud installation ${me.installation_id}\nOrganization: ${me.tenant_id}\nCredential expires: ${new Date(me.expires_at).toISOString()}`,
    );
    return 0;
  }
  if (command.action === "rotate") {
    const issued = await client.rotate();
    if (
      issued.installation_id !== previous.installation_id ||
      issued.tenant_id !== previous.tenant_id ||
      issued.subject_id !== previous.subject_id
    )
      throw new Error("Cloud rotation changed the installation identity.");
    saveCloudCredential(path, {
      ...issued,
      version: 1,
      server_url: previous.server_url,
    });
    output(
      {
        rotated: true,
        installation_id: issued.installation_id,
        expires_at: issued.expires_at,
      },
      "Cloud CLI credential rotated.",
    );
    return 0;
  }
  const items = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.organizations(cursor);
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 100)
        throw new Error("Cloud pagination is invalid.");
      seen.add(cursor);
    }
  } while (cursor);
  output(
    { items },
    items
      .map((i) => `${i.display_name} (${i.tenant_id}) — ${i.role}`)
      .join("\n"),
  );
  return 0;
}
