import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Generate an installation-local secret without printing it or overwriting user
// credentials. Populate the separate GitHub web app values before real sign-in.
try {
  await writeFile(
    new URL("../.dev.vars", import.meta.url),
    `AUTH_SECRET=${randomBytes(32).toString("base64url")}\nGITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created private .dev.vars; configure the GitHub web OAuth app before sign-in.",
  );
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.log("Existing .dev.vars preserved.");
}
