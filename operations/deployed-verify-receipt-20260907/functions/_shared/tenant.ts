import {
  parseRequestOrigin,
  RequestError,
  type RequestOrigin,
} from "./http.ts";

export type RpcError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export type RpcClient = {
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError | null }>;
};

export type TenantRequestContext = RequestOrigin & {
  tenantId: string;
  tenantSlug: string;
};

export function normalizeTenantSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new RequestError(
      400,
      "TENANT_SLUG_INVALID",
      "A valid tenant slug is required.",
    );
  }
  return slug;
}

/**
 * Resolve tenant and hostname together through a service-role-only database
 * function. This is the mandatory boundary before any tenant data is queried.
 */
export async function resolveTenantForRequest(
  db: RpcClient,
  tenantSlugValue: unknown,
  originHeader: string | null,
): Promise<TenantRequestContext> {
  const tenantSlug = normalizeTenantSlug(tenantSlugValue);
  const parsedOrigin = parseRequestOrigin(originHeader);
  const { data, error } = await db.rpc("resolve_tenant_id", {
    p_tenant_slug: tenantSlug,
    p_hostname: parsedOrigin.hostname,
  });

  if (error) {
    throw new RequestError(
      403,
      "TENANT_ORIGIN_DENIED",
      "This website is not registered for the tenant.",
    );
  }
  const tenantId = typeof data === "string" ? data : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(tenantId)
  ) {
    throw new RequestError(
      403,
      "TENANT_ORIGIN_DENIED",
      "This website is not registered for the tenant.",
    );
  }

  return { ...parsedOrigin, tenantId, tenantSlug };
}
