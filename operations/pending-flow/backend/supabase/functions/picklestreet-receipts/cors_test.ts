import { receiptPreflightResponse } from "./cors.ts";
import { corsHeaders } from "../_shared/http.ts";

const uploadHeaders = ["apikey", "authorization", "x-tenant-slug", "x-booking-reference",
  "x-booking-token", "x-payment-method", "x-payment-reference", "x-idempotency-key"];

for (const balance of [false, true]) {
  Deno.test(`${balance ? "balance" : "initial"} receipt preflight permits the browser upload headers`, () => {
    const origin = "https://picklestreet.pages.dev";
    const response = receiptPreflightResponse(origin);
    if (response.status !== 204 || response.headers.get("access-control-allow-origin") !== origin) {
      throw new Error("Preflight must return the verified exact origin.");
    }
    const allowed = new Set(response.headers.get("access-control-allow-headers")?.split(",").map(x => x.trim().toLowerCase()));
    for (const header of [...uploadHeaders, ...(balance ? ["x-balance-request"] : [])]) {
      if (!allowed.has(header)) throw new Error(`Browser upload header blocked: ${header}`);
    }
    if (!response.headers.get("access-control-allow-methods")?.split(",").map(x => x.trim()).includes("POST")) {
      throw new Error("Browser upload method blocked.");
    }
    if (new Headers(corsHeaders(origin)).get("access-control-allow-headers")?.includes("x-idempotency-key")) {
      throw new Error("Tenant-specific header must not change the shared policy.");
    }
  });
}
