import assert from "node:assert/strict";
import {
  createGroupRescheduleHandler,
  type GroupStore,
  parseChanges,
  TENANT_ID,
  TENANT_SLUG,
} from "./handler.ts";
import { groupRpcError } from "./store.ts";

const ref = "PB-1234567890AB";
const eventId = "30d05c2a-4707-49df-8b1c-cc96c8d1a3cb";
const actor = "b3823500-61a5-49b8-bc32-2fcb5e6d162e";
const changes = [{
  sessionId: "s1",
  newDate: "2026-10-10",
  newStartTime: "17:00",
}, { sessionId: "s2", newDate: "2026-10-11", newStartTime: "18:00" }];
function setup(overrides: Partial<GroupStore> = {}) {
  const calls: unknown[] = [];
  const store: GroupStore = {
    resolveTenant: async () => ({
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      origin: "https://picklestreet.pages.dev",
      hostname: "picklestreet.pages.dev",
    }),
    authenticate: async () => actor,
    authorize: async () => true,
    findBookingId: async () => "booking-one",
    context: async () => ({
      version: "v1",
      sessions: [],
      booking: { reference: ref },
    }),
    options: async (...args) => {
      calls.push(args);
      return {
        options: [{ startTime: "17:00", available: true }],
        version: "v1",
      };
    },
    preview: async (...args) => {
      calls.push(args);
      return { quoteHash: "q1", version: "v1", sessions: changes };
    },
    reschedule: async (input) => {
      calls.push(input);
      return { event: { id: eventId }, sessions: changes };
    },
    deliver: async (...args) => {
      calls.push(args.slice(0, 3));
      return { status: "sent" };
    },
    ...overrides,
  };
  const handler = createGroupRescheduleHandler(store, {
    send: async () => {
      throw Error("Tests never send customer email");
    },
  });
  const request = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(
        "https://edge.test/picklestreet-reschedule?tenantSlug=" + TENANT_SLUG,
        {
          method: "POST",
          headers: {
            origin: "https://picklestreet.pages.dev",
            authorization: "Bearer test-session-token-at-least-twenty",
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            tenantSlug: TENANT_SLUG,
            bookingReference: ref,
            ...body,
          }),
        },
      ),
    );
  return { request, calls };
}

Deno.test("group endpoint enforces tenant slug and resolved tenant before booking access", async () => {
  let bookingLookups = 0;
  for (
    const options of [
      { body: { tenantSlug: "other-court", action: "context" }, overrides: {} },
      {
        body: { action: "context" },
        overrides: {
          resolveTenant: async () => ({
            tenantId: "other-id",
            tenantSlug: TENANT_SLUG,
            origin: "https://picklestreet.pages.dev",
            hostname: "picklestreet.pages.dev",
          }),
        },
      },
    ]
  ) {
    const { request } = setup({
      ...options.overrides,
      findBookingId: async () => {
        bookingLookups++;
        return "booking";
      },
    });
    assert.equal((await request(options.body)).status, 403);
  }
  assert.equal(bookingLookups, 0);
});
Deno.test("missing authentication and staff-only authorization never reach booking mutation", async () => {
  const missing = setup({ authenticate: async () => null });
  assert.equal((await missing.request({ action: "context" })).status, 401);
  const staff = setup({ authorize: async () => false });
  assert.equal((await staff.request({ action: "context" })).status, 403);
  assert.equal(staff.calls.length, 0);
});
Deno.test("group preview sends all changes with authoritative expected version", async () => {
  const { request, calls } = setup();
  const response = await request({
    action: "preview",
    changes,
    expectedVersion: "v1",
    reasonCode: "weather",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quoteHash, "q1");
  assert.deepEqual(calls[0], ["booking-one", actor, changes, "weather", "v1"]);
});
Deno.test("malformed, duplicate and unsupported session changes are rejected", () => {
  for (
    const input of [
      [],
      [changes[0], changes[0]],
      [{ ...changes[0], newDate: "2026-02-30" }],
      [{ ...changes[0], newStartTime: "17:30" }],
      [{ ...changes[0], courtId: "foreign-court" }],
      Array(49).fill(changes[0]),
    ]
  ) assert.throws(() => parseChanges(input));
});
Deno.test("commit requires version and quote and passes one stable request identity", async () => {
  const { request, calls } = setup();
  const body = {
    action: "reschedule",
    changes,
    expectedVersion: "v1",
    expectedQuoteHash: "q1",
    reasonCode: "weather",
    publicReason: "Rain interruption",
    notifyCustomer: true,
    idempotencyKey: eventId,
  };
  assert.equal((await request({ ...body, expectedQuoteHash: "" })).status, 400);
  const response = await request(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email.status, "sent");
  assert.equal((calls[0] as Record<string, unknown>).idempotencyKey, eventId);
  assert.deepEqual(calls[1], [eventId, "booking-one", false]);
});
Deno.test("additional payment keeps the result pending and sends no final confirmation", async () => {
  let sent = 0;
  const { request } = setup({
    reschedule: async () => ({
      paymentRequired: true,
      balanceRequest: { id: eventId, remainingAmount: 50 },
    }),
    deliver: async () => {
      sent++;
      return { status: "sent" };
    },
  });
  const response = await request({
    action: "reschedule",
    changes,
    expectedVersion: "v1",
    expectedQuoteHash: "q1",
    reasonCode: "customer_request",
    publicReason: "Customer schedule change",
    notifyCustomer: true,
    idempotencyKey: eventId,
  });
  const result = await response.json();
  assert.equal(result.paymentRequired, true);
  assert.equal(result.balanceNoticeRequired, false);
  assert.equal(sent, 0);
});
Deno.test("a committed reschedule remains successful when email delivery is unavailable", async () => {
  const { request } = setup({
    deliver: async () => {
      throw Error("Temporary email failure");
    },
  });
  const response = await request({
    action: "reschedule",
    changes,
    expectedVersion: "v1",
    expectedQuoteHash: "q1",
    reasonCode: "weather",
    publicReason: "Rain interruption",
    notifyCustomer: true,
    idempotencyKey: eventId,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email.status, "pending");
});
Deno.test("resend binds the event to the authorized booking", async () => {
  const { request, calls } = setup();
  const response = await request({ action: "resend", eventId });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], [eventId, "booking-one", true]);
});
Deno.test("SQL failures retain useful conflict distinctions without exposing raw database errors", () => {
  assert.equal(
    groupRpcError({ code: "23P01" }).code,
    "RESCHEDULE_SLOT_UNAVAILABLE",
  );
  assert.equal(
    groupRpcError({ message: "GROUP_PRICE_QUOTE_STALE" }).code,
    "RESCHEDULE_PRICE_CHANGED",
  );
  assert.equal(
    groupRpcError({ message: "GROUP_RESCHEDULE_STALE" }).code,
    "RESCHEDULE_BOOKING_CHANGED",
  );
  assert.equal(groupRpcError({ code: "42501" }).status, 403);
  assert.equal(
    groupRpcError({ message: "private database relation failure" }).status,
    503,
  );
  assert.doesNotMatch(
    groupRpcError({ message: "private database relation failure" }).message,
    /relation/,
  );
});
