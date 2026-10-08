import { unlinkSync } from "node:fs";
import {
  defaultOauthPath,
  loginGithub,
  readOauthCredential,
} from "../github-oauth";
import { anchorPath, homeDirectory } from "../settings/paths";
import type { ParsedCommand } from "./arguments";

export async function githubCommand(
  command: Extract<ParsedCommand, { kind: "github" }>,
  write: (message: string) => void,
): Promise<number> {
  const path = anchorPath(
    command.credentials ??
      process.env.SWARMFORGE_GITHUB_OAUTH_CREDENTIALS_PATH ??
      defaultOauthPath(),
    process.cwd(),
    homeDirectory(process.env),
  );
  if (command.action === "status") {
    const credential = readOauthCredential(path);
    const expired =
      !!credential.expiresAt && credential.expiresAt <= Date.now() + 60000;
    write(
      `GitHub account: ${credential.login}\nRepository: ${credential.repository}\nCredentials: ${expired ? "expired; run login again" : "available (remote access not checked)"}`,
    );
    return expired ? 1 : 0;
  }
  if (command.action === "logout") {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Unable to remove GitHub credential file.");
    }
    write(
      "Local GitHub credentials removed. Stop or restart coordinators and revoke the grant in GitHub Settings > Applications to invalidate the token everywhere.",
    );
    return 0;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await loginGithub({
      clientId: command.clientId!,
      repository: command.repository!,
      path,
      signal: controller.signal,
      write,
    });
    return 0;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
