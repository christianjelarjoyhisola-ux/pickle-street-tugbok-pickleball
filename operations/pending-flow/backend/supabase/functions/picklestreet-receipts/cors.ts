import { noContentResponse } from "../_shared/http.ts";

// Extend only this tenant's upload endpoint; shared services keep their policy.
export function receiptPreflightResponse(origin: string): Response {
  const response = noContentResponse(origin);
  const allowed = response.headers.get("Access-Control-Allow-Headers");
  response.headers.set("Access-Control-Allow-Headers", `${allowed}, x-idempotency-key`);
  return response;
}
