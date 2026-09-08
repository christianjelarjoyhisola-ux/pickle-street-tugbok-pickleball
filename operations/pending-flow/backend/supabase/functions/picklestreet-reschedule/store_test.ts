import assert from "node:assert/strict";
import { createGroupStore } from "./store.ts";
import { deriveBalancePaymentAccessToken } from "../_shared/booking-access.ts";
import { TENANT_ID } from "./handler.ts";

Deno.test("idempotent group reschedule returns the persisted balance credential instead of the candidate request ID", async () => {
  const persistedId = "5122b637-d4b2-452e-9f74-68eb519c17af";
  const secret =
    "a53dad4b51494ed19b3d860bed68dcbff5442655c62640ea8b302d6c5f7f6fb9";
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db: any = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data: {
          paymentRequired: true,
          balanceRequest: { id: persistedId, remainingAmount: 50 },
        },
        error: null,
      };
    },
  };
  const store = createGroupStore(db, secret);
  const input = {
    bookingId: "booking-id",
    actor: "actor-id",
    changes: [{
      sessionId: "session-1",
      newDate: "2026-10-10",
      newStartTime: "17:00",
    }],
    reason: "customer_request",
    version: "v1",
    quoteHash: "q1",
    publicReason: "Changed plans",
    internalNote: null,
    notifyCustomer: true,
    idempotencyKey: "f0258430-87c2-42bb-a9e9-cd72c6b94271",
    origin: "https://picklestreet.pages.dev",
  };
  const first = await store.reschedule(input);
  const second = await store.reschedule(input);
  const firstBalance = first.balanceRequest as Record<string, unknown>;
  const secondBalance = second.balanceRequest as Record<string, unknown>;
  assert.equal(firstBalance.paymentUrl, secondBalance.paymentUrl);
  assert.notEqual(
    calls[0].args.p_balance_request_id,
    calls[1].args.p_balance_request_id,
  );
  assert.notEqual(calls[0].args.p_balance_request_id, persistedId);
  const paymentUrl = new URL(String(firstBalance.paymentUrl));
  assert.equal(paymentUrl.searchParams.get("balanceRequest"), persistedId);
  assert.equal(
    paymentUrl.searchParams.get("balanceToken"),
    await deriveBalancePaymentAccessToken({
      secret,
      tenantId: TENANT_ID,
      balanceRequestId: persistedId,
    }),
  );
  assert.equal(paymentUrl.origin, "https://picklestreet.pages.dev");
  assert.match(String(calls[0].args.p_access_token_hash), /^[a-f0-9]{64}$/);
  assert.equal(
    calls[0].args.p_idempotency_key,
    calls[1].args.p_idempotency_key,
  );
});

Deno.test("authorized context recovers a pending grouped adjustment link after the dashboard closes", async () => {
  const balanceId = "5122b637-d4b2-452e-9f74-68eb519c17af";
  const secret =
    "a53dad4b51494ed19b3d860bed68dcbff5442655c62640ea8b302d6c5f7f6fb9";
  const db: any = {
    rpc: async () => ({
      data: {
        eligible: false,
        pendingAdjustment: {
          id: balanceId,
          status: "payment_review",
          remainingAmount: 50,
        },
      },
      error: null,
    }),
  };
  const result = await createGroupStore(db, secret).context(
    "booking",
    "actor",
    "https://picklestreet.pages.dev",
  );
  const pending = result.pendingAdjustment as Record<string, unknown>;
  assert.equal(result.eligible, false);
  assert.equal(
    new URL(String(pending.paymentUrl)).searchParams.get("balanceRequest"),
    balanceId,
  );
});
