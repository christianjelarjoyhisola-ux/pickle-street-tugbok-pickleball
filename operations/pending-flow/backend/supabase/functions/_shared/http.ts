export type RequestOrigin = {
  origin: string;
  hostname: string;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Parse an Origin header into the exact value used for CORS and a normalized
 * hostname used for tenant-domain matching. Production origins must use HTTPS;
 * HTTP is accepted only for loopback development.
 */
export function parseRequestOrigin(value: string | null): RequestOrigin {
  const input = String(value ?? "").trim();
  if (!input || input === "null") {
    throw new RequestError(
      403,
      "ORIGIN_REQUIRED",
      "A valid request origin is required.",
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RequestError(
      403,
      "ORIGIN_INVALID",
      "The request origin is invalid.",
    );
  }

  const hostname = normalizeHostname(url.hostname);
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new RequestError(
      403,
      "ORIGIN_INVALID",
      "The request origin is not allowed.",
    );
  }
  if (
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash || (!isLoopback && url.port) ||
    !hostname
  ) {
    throw new RequestError(
      403,
      "ORIGIN_INVALID",
      "The request origin is invalid.",
    );
  }

  return { origin: url.origin, hostname };
}

/** Normalize a domain for database comparisons without treating www as equal. */
export function normalizeHostname(value: string): string {
  const input = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!input || input.includes("/") || input.includes("@")) return "";

  try {
    const parsed = new URL(`https://${input}`);
    if (
      parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash
    ) return "";
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-asset-action, x-balance-request, x-booking-reference, x-booking-token, x-claim-id, x-claim-token, x-client-info, x-open-play-reference, x-open-play-token, x-payment-method, x-payment-reference, x-rain-action, x-tenant-slug",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  origin?: string,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (origin) {
    for (const [name, value] of Object.entries(corsHeaders(origin))) {
      headers.set(name, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  origin?: string,
): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status, origin);
}

export function noContentResponse(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function readJsonObject(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new RequestError(
      415,
      "CONTENT_TYPE_REQUIRED",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError(
      413,
      "REQUEST_TOO_LARGE",
      "The request body is too large.",
    );
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RequestError(
      413,
      "REQUEST_TOO_LARGE",
      "The request body is too large.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError(
      400,
      "JSON_INVALID",
      "The request body must contain valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestError(
      400,
      "JSON_INVALID",
      "The request body must be a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}
