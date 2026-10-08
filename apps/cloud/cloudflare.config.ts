import { bindings, defineConfig } from "cf/config";

export const localDatabaseId = "00000000-0000-4000-8000-00000000002a";
export const previewWorkerName = "swarmforge-cloud-preview";
export const previewDatabaseName = "swarmforge-cloud-preview";

export default defineConfig(({ mode }) => {
  if (mode !== undefined && mode !== "local" && mode !== "preview")
    throw new Error(
      "Cloud API configuration supports local and preview modes only",
    );
  const preview = mode === "preview";
  const origin = preview
    ? process.env.CF_PREVIEW_API_ORIGIN
    : "http://localhost:8788";
  const website = preview
    ? (process.env.CF_PREVIEW_WEBSITE_ORIGIN ?? origin)
    : origin;
  const database = preview ? process.env.CF_PREVIEW_D1_ID : localDatabaseId;
  if (!origin || !website || !database)
    throw new Error(
      "Preview requires CF_PREVIEW_API_ORIGIN and CF_PREVIEW_D1_ID",
    );
  for (const value of [origin, website]) {
    const parsed = new URL(value);
    if (
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      (preview && parsed.protocol !== "https:")
    )
      throw new Error(
        "Cloud origins must be exact origins; preview requires HTTPS",
      );
  }
  if (
    preview &&
    (database === localDatabaseId || !/^[a-f0-9-]{36}$/i.test(database))
  )
    throw new Error("Preview requires an explicit separate D1 database UUID");
  return {
    worker: {
      name: preview ? previewWorkerName : "swarmforge-cloud-local",
      compatibilityDate: "2026-10-08",
      entrypoint: "./src/index.ts",
      workersDev: preview,
      previewUrls: false,
      // Codes/state arrive in callback queries: exclude invocation URLs and strip
      // query strings from platform traces as well as using safe application logs.
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      env: {
        DB: bindings.d1({
          id: database,
          name: preview ? previewDatabaseName : "swarmforge-cloud-local",
        }),
        ENVIRONMENT: bindings.text(preview ? "preview" : "local"),
        APP_ORIGIN: bindings.text(origin),
        WEBSITE_ORIGIN: bindings.text(website),
        GITHUB_CLIENT_ID: bindings.secret(),
        GITHUB_CLIENT_SECRET: bindings.secret(),
        AUTH_SECRET: bindings.secret(),
      },
    },
  };
});
