import { type SupabaseClient } from "@supabase/supabase-js";
import {
  type JsonObject,
  type PlayerRainBooking,
  type PlayerRainReportStore,
  RAIN_PROOF_BUCKET,
} from "../_shared/player-rain-report.ts";
import {
  resolveTenantForRequest,
  type TenantRequestContext,
} from "../_shared/tenant.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function databaseError(
  error: { message?: string } | null | undefined,
): Error {
  return new Error(text(error?.message) || "player_rain_claim_unavailable");
}

export function createSupabasePlayerRainReportStore(
  db: SupabaseClient,
): PlayerRainReportStore {
  return {
    async resolveTenant(
      tenantSlug: unknown,
      originHeader: string | null,
    ): Promise<TenantRequestContext> {
      return await resolveTenantForRequest(db, tenantSlug, originHeader);
    },

    async findBooking(
      tenantId: string,
      bookingReference: string,
    ): Promise<PlayerRainBooking | null> {
      const bookingResult = await db.from("bookings")
        .select("id,reference,customer_email,customer_phone")
        .eq("tenant_id", tenantId)
        .eq("reference", bookingReference)
        .maybeSingle();
      if (bookingResult.error) throw databaseError(bookingResult.error);
      if (!bookingResult.data) return null;
      const bookingId = text(bookingResult.data.id);
      const accessResult = await db.from("booking_access_tokens")
        .select("token_hash,expires_at")
        .eq("tenant_id", tenantId)
        .eq("booking_id", bookingId)
        .maybeSingle();
      if (accessResult.error) throw databaseError(accessResult.error);
      return {
        id: bookingId,
        reference: text(bookingResult.data.reference),
        customerEmail: text(bookingResult.data.customer_email) || null,
        customerPhone: text(bookingResult.data.customer_phone),
        accessTokenHash: text(accessResult.data?.token_hash) || null,
        accessTokenExpiresAt: text(accessResult.data?.expires_at) || null,
      };
    },

    async startClaim(options) {
      const result = await db.rpc("start_player_rain_claim", {
        p_tenant_id: options.tenantId,
        p_booking_id: options.bookingId,
        p_booking_reference: options.bookingReference,
        p_client_request_id: options.clientRequestId,
        p_claim_token_hash: options.claimTokenHash,
        p_access_method: options.accessMethod,
        p_turnstile_hostname: options.turnstileHostname,
        p_turnstile_challenge_at: options.turnstileChallengeAt,
      });
      if (result.error || !result.data) throw databaseError(result.error);
      const payload = objectValue(result.data);
      return {
        claim: objectValue(payload.claim),
        idempotent: payload.idempotent === true,
      };
    },

    async getClaim(options): Promise<JsonObject> {
      const result = await db.rpc("get_player_rain_claim_public", {
        p_tenant_id: options.tenantId,
        p_claim_id: options.claimId,
        p_claim_token_hash: options.claimTokenHash,
      });
      if (result.error || !result.data) throw databaseError(result.error);
      return objectValue(result.data);
    },

    async uploadProof(options): Promise<string> {
      const claimResult = await db.from("player_rain_claims")
        .select("booking_id")
        .eq("tenant_id", options.tenantId)
        .eq("id", options.claimId)
        .maybeSingle();
      if (claimResult.error || !claimResult.data) {
        throw databaseError(claimResult.error);
      }
      const bookingId = text(claimResult.data.booking_id).toLowerCase();
      const storagePath =
        `${options.tenantId.toLowerCase()}/rain-claims/${bookingId}/${options.claimId.toLowerCase()}/${crypto.randomUUID()}.${options.extension}`;
      const upload = await db.storage.from(RAIN_PROOF_BUCKET).upload(
        storagePath,
        options.bytes,
        {
          contentType: options.contentType,
          cacheControl: "0",
          upsert: false,
        },
      );
      if (upload.error) throw databaseError(upload.error);
      return storagePath;
    },

    async removeProof(storagePath: string): Promise<void> {
      const removal = await db.storage.from(RAIN_PROOF_BUCKET).remove([
        storagePath,
      ]);
      if (removal.error) throw databaseError(removal.error);
    },

    async submitProof(options) {
      const result = await db.rpc("submit_player_rain_claim_proof", {
        p_tenant_id: options.tenantId,
        p_claim_id: options.claimId,
        p_claim_token_hash: options.claimTokenHash,
        p_storage_path: options.storagePath,
        p_content_type: options.contentType,
        p_size_bytes: options.sizeBytes,
        p_file_sha256: options.fileSha256,
        p_report_note: options.reportNote,
        p_gcash_account_name: options.payoutAccountName,
        p_gcash_mobile_number: options.payoutMobileNumber,
      });
      if (result.error || !result.data) throw databaseError(result.error);
      const payload = objectValue(result.data);
      return {
        claim: objectValue(payload.claim),
        idempotent: payload.idempotent === true,
      };
    },
  };
}
