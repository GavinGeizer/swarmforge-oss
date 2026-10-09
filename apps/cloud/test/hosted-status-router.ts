import { z } from "zod";
import type { Context, Env } from "../src/common.ts";
import { allowedOrigin, HttpError, json } from "../src/common.ts";
import { hostedAuthorityRoute } from "../src/hosted-authority.ts";
import { entitlementsRoute } from "../src/hosted-entitlements.ts";
import { hostedStatusRoute } from "../src/hosted-status.ts";
import { createWorker } from "../src/index.ts";
import { errorSchema } from "../src/schemas.ts";

// TEMPORARY status router for the hosted-status packet only: production
// hosted handlers (authority + entitlements + NEW status) first, everything
// else delegated to the real lead-owned worker (read-only import, no changes).
// Deleted at lead integration when index.ts wires the hosted routes,
// including GET /v1/tenants/:tenant/hosted-status.
const base = createWorker();

export default {
  async scheduled(event: ScheduledController, env: Env) {
    await base.scheduled(event, env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx: Context = {
      request,
      env,
      request_id: crypto.randomUUID(),
      route: "hosted-status-test",
      actor: null,
    };
    for (const handler of [
      hostedAuthorityRoute,
      entitlementsRoute,
      hostedStatusRoute,
    ]) {
      try {
        const response = await handler(ctx);
        if (response) return response;
      } catch (error) {
        // Same envelope as the production worker: safe code/message/request_id.
        const failure =
          error instanceof HttpError
            ? error
            : error instanceof z.ZodError
              ? new HttpError(400, "invalid_request", "Request is invalid")
              : new HttpError(
                  503,
                  "temporarily_unavailable",
                  "Service is temporarily unavailable",
                );
        const response = json(
          errorSchema,
          {
            error: {
              code: failure.code,
              message: failure.message,
              request_id: ctx.request_id,
            },
          },
          failure.status,
        );
        const origin = allowedOrigin(ctx);
        if (origin) {
          response.headers.set("access-control-allow-origin", origin);
          response.headers.set("access-control-allow-credentials", "true");
          response.headers.set("vary", "Origin");
        }
        for (const [key, value] of Object.entries({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": ctx.request_id,
        }))
          if (!response.headers.has(key)) response.headers.set(key, value);
        return response;
      }
    }
    return base.fetch(request, env);
  },
};
