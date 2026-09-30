import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  return successResponse({ status: "ok", service: "bench-worker", environment: env.ENVIRONMENT }, requestId);
}
