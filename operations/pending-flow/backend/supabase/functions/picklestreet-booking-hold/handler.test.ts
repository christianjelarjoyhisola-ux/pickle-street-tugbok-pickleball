import { strict as assert } from "node:assert";
import { bookingAccessTokenHash } from "../_shared/booking-access.ts";
import { RequestError } from "../_shared/http.ts";
import { refundPolicySha256 } from "../_shared/picklestreet-hold/refund-policy.ts";
import {
  parseGroupSelections,
  bookingResponse,
  createHoldHandler,
  type HoldStore,
  type Obj,
  type Selection,
  TENANT_ID,
  TENANT_SLUG,
} from "./handler.ts";
import { createHoldStore, databaseFailure } from "./store.ts";

// Entirely synthetic fixtures; fetch is injected and no database is contacted.
const ORIGIN = "https://picklestreet.pages.dev";
const COURT = "bfb62052-cc6b-435e-a8b1-0265b613a771";
const CLIENT = "d7e4f8e3-4b72-4e55-b2e9-9e6f013e6c79";
const SECRET = "synthetic-test-ONLY-7QrH2bvWj69AFp1Nx5MU8DdY";
const POLICY = {
  version: "approved-v1",
  title: "Refund and Reschedule Policy",
  intro: "Please review this approved venue policy.",
  content: "Refunds and rescheduling follow these approved venue terms.",
  ownerApproved: true,
};
const selection: Selection = {
  courtId: COURT,
  bookingDate: "2026-09-09",
  startTime: "12:00",
  durationHours: 1,
  bookingType: "regular",
};
const createBody = {
  tenantSlug: TENANT_SLUG,
  action: "create",
  ...selection,
  clientRequestId: CLIENT,
};
function booking(extra: Obj = {}): Obj {
  return {
    bookingId: "98e8d5be-22a1-449d-b8e8-28dcd789089d",
    reference: "PB-SYNTHETIC-01",
    ...selection,
    courtName: "Synthetic court",
    tenantTimezone: "Asia/Manila",
    status: "pending",
    paymentStatus: "unpaid",
    startsAt: "2026-09-09T04:00:00+00:00",
    endsAt: "2026-09-09T05:00:00+00:00",
    expiresAt: "2026-09-08T04:15:00+00:00",
    accessExpiresAt: "2026-10-09T05:00:00+00:00",
    subtotalAmount: 1,
    courtSubtotalAmount: 1,
    equipmentRentalFeeAmount: 0,
    equipmentRental: { extraPaddles: 0, balls: 0 },
    serviceFeeAmount: 1,
    totalAmount: 2,
    currency: "PHP",
    fullPaymentOnly: true,
    detailsCompleted: false,
    provisional: true,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    guestCount: 1,
    eventType: null,
    eventSetupNotes: null,
    reservationHeld: true,
    slots: [{
      startsAt: "2026-09-09T04:00:00+00:00",
      endsAt: "2026-09-09T05:00:00+00:00",
      status: "held",
    }],
    ...extra,
  };
}
function fixture() {
  const calls = {
    resolve: 0,
    existing: 0,
    configuration: 0,
    policy: 0,
    create: [] as Obj[],
    status: [] as Obj[],
    cancel: [] as Obj[],
    complete: [] as Obj[],
    siteverify: [] as Obj[],
  };
  const state = {
    stored: null as null | {
      booking: Obj;
      selection: Selection;
      tokenHash: string;
    },
    loseCreateReply: false,
    security: {
      success: true,
      hostname: "picklestreet.pages.dev",
      action: "booking_create",
    } as Obj,
    securityFailure: false,
    policy: { value: POLICY, is_public: true } as {
      value: Obj;
      is_public: boolean;
    } | null,
  };
  const config = {
    tenant: {
      id: TENANT_ID,
      timezone: "Asia/Manila",
      public_config: { eventBookingEnabled: false },
    },
    court: {
      id: COURT,
      currency: "PHP",
      opens_at: "08:00:00",
      closes_at: "23:59:59",
      public_config: {},
      pricing_config: {
        regular: {
          minimumHours: 1,
          maximumHours: 18,
          maximumGuests: 8,
          fullPaymentRequired: true,
          bands: [{ start: "08:00", end: "24:00", hourlyRate: 1 }],
        },
        event: { enabled: false, hourlyRate: 1 },
      },
    },
    billing: { fee_mode: "fixed_per_booking", fee_amount: 1 },
    equipment: null,
    ready: true,
  };
  function authorized(args: Obj) {
    if (
      !state.stored ||
      args.p_booking_reference !== state.stored.booking.reference ||
      args.p_access_token_hash !== state.stored.tokenHash
    ) {
      throw new RequestError(
        401,
        "BOOKING_ACCESS_DENIED",
        "This private booking access is invalid or expired.",
      );
    }
    return state.stored.booking;
  }
  const store: HoldStore = {
    async resolve(slug, origin) {
      calls.resolve++;
      if (slug !== TENANT_SLUG || origin !== ORIGIN) {
        throw new RequestError(
          403,
          "TENANT_ACCESS_DENIED",
          "This booking origin is not allowed.",
        );
      }
      return {
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        origin,
        hostname: "picklestreet.pages.dev",
      };
    },
    async existing(_id, hash) {
      calls.existing++;
      return state.stored && state.stored.tokenHash === hash
        ? state.stored
        : null;
    },
    async configuration() {
      calls.configuration++;
      return config;
    },
    async policy() {
      calls.policy++;
      return state.policy;
    },
    async create(args) {
      calls.create.push(args);
      const b = booking({
        subtotalAmount: args.p_subtotal_amount,
        courtSubtotalAmount: args.p_subtotal_amount,
        serviceFeeAmount: args.p_service_fee_amount,
        totalAmount: args.p_total_amount,
        fullPaymentOnly: args.p_metadata.fullPaymentOnly,
      });
      state.stored = {
        booking: b,
        selection: { ...selection },
        tokenHash: args.p_access_token_hash,
      };
      if (state.loseCreateReply) {
        state.loseCreateReply = false;
        throw new DOMException("Synthetic interrupted reply", "AbortError");
      }
      return b;
    },
    async status(args) {
      calls.status.push(args);
      return authorized(args);
    },
    async cancel(args) {
      calls.cancel.push(args);
      const b = authorized(args);
      if (b.detailsCompleted) {
        throw new RequestError(
          409,
          "DETAILS_ALREADY_COMPLETED",
          "Refresh its current status.",
        );
      }
      b.status = "cancelled";
      b.reservationHeld = false;
      return {
        bookingId: b.bookingId,
        reference: b.reference,
        status: "cancelled",
        cancelled: true,
        idempotent: false,
      };
    },
    async complete(args) {
      calls.complete.push(args);
      const b = authorized(args);
      if (!b.reservationHeld) {
        throw new RequestError(
          409,
          "HOLD_EXPIRED",
          "The original court hold has ended.",
        );
      }
      Object.assign(b, {
        detailsCompleted: true,
        provisional: false,
        customerName: args.p_customer_name,
        customerEmail: args.p_customer_email,
        customerPhone: args.p_customer_phone,
        guestCount: args.p_guest_count,
        eventType: args.p_event_type,
        eventSetupNotes: args.p_event_setup_notes,
      });
      return b;
    },
  };
  const handler = createHoldHandler({
    store,
    bookingSecret: SECRET,
    now: () => new Date("2026-09-08T04:00:00Z"),
  });
  async function invoke(
    body: Obj = createBody,
    options: {
      headers?: Record<string, string>;
      url?: string;
      method?: string;
    } = {},
  ) {
    const method = options.method ?? "POST";
    const response = await handler(
      new Request(
        options.url ??
          `https://synthetic.invalid/functions/v1/picklestreet-booking-hold?tenantSlug=${TENANT_SLUG}`,
        {
          method,
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "cf-connecting-ip": "192.0.2.9",
            ...options.headers,
          },
          ...(method === "OPTIONS" ? {} : { body: JSON.stringify(body) }),
        },
      ),
    );
    return {
      response,
      data: response.status === 204 ? null : await response.json(),
    };
  }
  async function created() {
    const r = await invoke();
    assert.equal(r.response.status, 201, JSON.stringify(r.data));
    return r.data.booking;
  }
  return { calls, state, config, store, handler, invoke, created };
}
const completion = (b: Obj, extra: Obj = {}) => ({
  tenantSlug: TENANT_SLUG,
  action: "complete",
  bookingReference: b.reference,
  bookingToken: b.bookingToken,
  customer: {
    name: "Synthetic Customer",
    email: "test@example.invalid",
    phone: "+639000000001",
  },
  guestCount: 2,
  eventType: null,
  eventSetupNotes: "Synthetic note",
  policyAccepted: true,
  policyVersion: POLICY.version,
  ...extra,
});

Deno.test("create quotes server prices, returns real deadline and hides payment/customer data until completion", async () => {
  const f = fixture(), b = await f.created(), args = f.calls.create[0];
  assert.equal(b.totalAmount, 2);
  assert.equal(b.expiresAt, "2026-09-08T04:15:00+00:00");
  assert.equal(b.canSubmitReceipt, false);
  assert.equal(b.customer, null);
  assert.equal(b.detailsCompleted, false);
  assert.match(b.bookingToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(args.p_customer_name, undefined);
  assert.equal(args.p_customer_email, undefined);
  assert.equal(args.p_policy_accepted, undefined);
  assert.equal(args.p_metadata.policyAcceptance, undefined);
  assert.equal(args.p_metadata.turnstileToken, undefined);
  assert.equal(args.p_metadata.provisionalSelection, undefined);
  assert.match(args.p_client_ip_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(args).includes("192.0.2.9"), false);
  assert.equal(args.p_starts_at, "2026-09-09T04:00:00Z");
  assert.equal(args.p_slots.length, 1);
});
Deno.test("OPTIONS covers actual adapter request headers and never creates holds", async () => {
  const f = fixture(),
    r = await f.invoke({}, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization,apikey,content-type,x-client-info",
      },
    });
  assert.equal(r.response.status, 204);
  assert.equal(r.response.headers.get("access-control-allow-origin"), ORIGIN);
  const allowed = r.response.headers.get("access-control-allow-headers")!.split(
    ",",
  ).map((x) => x.trim());
  for (
    const header of ["authorization", "apikey", "content-type", "x-client-info"]
  ) assert.ok(allowed.includes(header));
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.siteverify.length, 0);
});
Deno.test("new and previously loaded clients book without any CAPTCHA request", async () => {
  const f=fixture();const first=await f.invoke();assert.equal(first.response.status,201);assert.equal(f.calls.siteverify.length,0);
  const retry=await f.invoke({...createBody,turnstileToken:'expired-old-widget-token'});assert.equal(retry.response.status,200);assert.equal(retry.data.booking.bookingToken,first.data.booking.bookingToken);assert.equal(f.calls.create.length,1);assert.equal(f.calls.siteverify.length,0);
});
for (
  const [name, body, options] of [["foreign body", {
    ...createBody,
    tenantSlug: "different-venue",
  }, {}], ["foreign URL", createBody, {
    url: "https://synthetic.invalid/hold?tenantSlug=different-venue",
  }], ["foreign origin", createBody, {
    headers: { origin: "https://elsewhere.invalid" },
  }], ["internal credential", createBody, {
    headers: { "x-internal-secret": "synthetic-forbidden" },
  }]] as const
) {
  Deno.test(`${name} cannot mutate any tenant`, async () => {
    const f = fixture(), r = await f.invoke(body, options);
    assert.equal(r.response.status, 403);
    assert.equal(f.calls.create.length, 0);
    assert.equal(f.calls.siteverify.length, 0);
    if (name === "foreign origin") {
      assert.equal(r.response.headers.get("access-control-allow-origin"), null);
    }
  });
}
for (
  const field of [
    "totalAmount",
    "metadata",
    "slots",
    "customer",
    "policyAccepted",
  ]
) {
  Deno.test(`create rejects client controlled ${field}`, async () => {
    const f = fixture(),
      r = await f.invoke({
        ...createBody,
        [field]: field === "totalAmount" ? 1 : {},
      });
    assert.equal(r.response.status, 400);
    assert.equal(r.data.error.code, "CLIENT_CONTROLLED_FIELD");
    assert.equal(f.calls.create.length, 0);
  });
}
for (
  const change of [
    { bookingDate: "2026-02-30" },
    { startTime: "12:30" },
    { durationHours: 0 },
    { durationHours: 19 },
    { clientRequestId: "not-uuid" },
  ]
) {
  Deno.test(`invalid selection ${JSON.stringify(change)} does not reserve`, async () => {
    const f = fixture(), r = await f.invoke({ ...createBody, ...change });
    assert.equal(r.response.status, 400);
    assert.equal(f.calls.create.length, 0);
  });
}
Deno.test("existing event policy remains authoritative", async () => {
  const f = fixture(),
    r = await f.invoke({ ...createBody, bookingType: "event" });
  assert.equal(r.response.status, 422);
  assert.equal(r.data.error.code, "EVENT_BOOKING_DISABLED");
  assert.equal(f.calls.create.length, 0);
});
Deno.test("lost create reply retries the same token, stored selection, price and deadline", async () => {
  const f = fixture();
  f.state.loseCreateReply = true;
  const first = await f.invoke();
  assert.equal(first.response.status, 503);
  assert.match(first.data.error.message, /retry the same selection/i);
  const original = { ...f.state.stored!.booking };
  f.config.ready = false;
  f.config.court.pricing_config.regular.bands[0].hourlyRate = 999;
  const second = await f.invoke({
    ...createBody,
    turnstileToken: "synthetic-challenge-two",
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.data.booking.totalAmount, original.totalAmount);
  assert.equal(second.data.booking.expiresAt, original.expiresAt);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.configuration, 1);
  assert.equal(f.calls.siteverify.length, 0);
  assert.equal(
    await bookingAccessTokenHash(second.data.booking.bookingToken),
    f.state.stored!.tokenHash,
  );
});
Deno.test("same request ID with changed selection cannot create a second hold", async () => {
  const f = fixture(),
    b = await f.created(),
    r = await f.invoke({ ...createBody, startTime: "13:00" });
  assert.equal(r.response.status, 409);
  assert.equal(r.data.error.code, "REQUEST_SELECTION_CHANGED");
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.state.stored!.booking.expiresAt, b.expiresAt);
});
Deno.test("complete promotes the same capability using real approved policy evidence", async () => {
  const f = fixture(), b = await f.created(), r = await f.invoke(completion(b));
  assert.equal(r.response.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.booking.detailsCompleted, true);
  assert.equal(r.data.booking.bookingToken, b.bookingToken);
  assert.equal(r.data.booking.expiresAt, b.expiresAt);
  assert.equal(r.data.booking.canSubmitReceipt, undefined);
  assert.deepEqual(r.data.booking.customer, {
    name: "Synthetic Customer",
    email: "test@example.invalid",
    phone: "+639000000001",
  });
  assert.equal(r.data.booking.guestCount, 2);
  assert.equal(r.data.booking.eventSetupNotes, "Synthetic note");
  assert.equal(f.calls.complete[0].p_policy_accepted, true);
  assert.equal(
    f.calls.complete[0].p_policy_sha256,
    await refundPolicySha256(POLICY),
  );
  assert.equal(f.calls.complete[0].p_policy_version, POLICY.version);
});
for (
  const [name, change] of [
    ["not accepted", { policyAccepted: false }],
    ["stale policy", { policyVersion: "approved-old" }],
    ["missing email", {
      customer: { name: "Synthetic Customer", phone: "+639000000001" },
    }],
    ["fake email", {
      customer: {
        name: "Synthetic Customer",
        email: "not-email",
        phone: "+639000000001",
      },
    }],
    ["zero guests", { guestCount: 0 }],
    ["client policy hash", { policySha256: "client-proof" }],
  ] as const
) {
  Deno.test(`complete ${name} cannot promote a hold`, async () => {
    const f = fixture(),
      b = await f.created(),
      r = await f.invoke(completion(b, change));
    assert.ok(r.response.status >= 400);
    assert.equal(f.calls.complete.length, 0);
    assert.equal(f.state.stored!.booking.detailsCompleted, false);
  });
}
Deno.test("missing or unpublished policy cannot be fabricated", async () => {
  for (const kind of ["missing", "private", "unapproved"]) {
    const f = fixture(), b = await f.created();
    if (kind === "missing") f.state.policy = null;
    else {f.state.policy = {
        value: { ...POLICY, ownerApproved: kind !== "unapproved" },
        is_public: kind !== "private",
      };}
    const r = await f.invoke(completion(b));
    assert.equal(r.response.status, 503);
    assert.equal(f.calls.complete.length, 0);
  }
});
for (const action of ["status", "cancel", "complete"]) {
  Deno.test(`${action} rejects another reference or token without revealing customer data`, async () => {
    for (const field of ["bookingReference", "bookingToken"]) {
      const f = fixture(),
        b = await f.created(),
        r = await f.invoke({
          ...completion(b),
          action,
          ...(action === "complete" ? {} : {
            customer: undefined,
            guestCount: undefined,
            eventType: undefined,
            eventSetupNotes: undefined,
            policyAccepted: undefined,
            policyVersion: undefined,
          }),
          [field]: field === "bookingReference"
            ? "PB-SYNTHETIC-OTHER"
            : "A".repeat(43),
        });
      assert.equal(r.response.status, 401);
      assert.equal(r.data.booking, undefined);
      assert.equal(f.calls.policy, 0);
      assert.equal(f.calls.complete.length, 0);
    }
  });
}
Deno.test("lost completion can recover promoted status with the original private token", async () => {
  const f = fixture(), b = await f.created();
  const original = f.store.complete;
  f.store.complete = async (args) => {
    await original(args);
    throw new Error("Synthetic lost reply");
  };
  const interrupted = await f.invoke(completion(b));
  assert.equal(interrupted.response.status, 503);
  assert.match(
    interrupted.data.error.message,
    /check its status before retrying/i,
  );
  const status = await f.invoke({
    tenantSlug: TENANT_SLUG,
    action: "status",
    bookingReference: b.reference,
    bookingToken: b.bookingToken,
  });
  assert.equal(status.response.status, 200);
  assert.equal(status.data.booking.detailsCompleted, true);
  assert.equal(status.data.booking.customer.email, "test@example.invalid");
  assert.equal(status.data.booking.bookingToken, undefined);
  assert.equal(status.data.booking.expiresAt, b.expiresAt);
  assert.equal(status.response.headers.get("cache-control"), "no-store");
});
Deno.test("expired status retains original deadline and completing cannot renew it", async () => {
  const f = fixture(), b = await f.created();
  Object.assign(f.state.stored!.booking, {
    status: "expired",
    reservationHeld: false,
  });
  const status = await f.invoke({
    tenantSlug: TENANT_SLUG,
    action: "status",
    bookingReference: b.reference,
    bookingToken: b.bookingToken,
  });
  assert.equal(status.data.booking.reservationHeld, false);
  assert.equal(status.data.booking.canSubmitReceipt, false);
  assert.equal(status.data.booking.expiresAt, b.expiresAt);
  const r = await f.invoke(completion(b));
  assert.equal(r.response.status, 409);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.state.stored!.booking.detailsCompleted, false);
});
Deno.test("cancel releases only the authenticated preliminary hold and retains original deadline", async () => {
  const f = fixture(),
    b = await f.created(),
    r = await f.invoke({
      tenantSlug: TENANT_SLUG,
      action: "cancel",
      bookingReference: b.reference,
      bookingToken: b.bookingToken,
    });
  assert.equal(r.response.status, 200);
  assert.equal(r.data.cancellation.cancelled, true);
  assert.equal(r.data.cancellation.reference, b.reference);
  assert.equal(f.state.stored!.booking.expiresAt, b.expiresAt);
  assert.equal(f.state.stored!.booking.reservationHeld, false);
  assert.equal(f.calls.complete.length, 0);
});
Deno.test("server quote fields are preserved instead of inventing payment or equipment values", () => {
  const b = bookingResponse(booking({
    fullPaymentOnly: false,
    subtotalAmount: 7,
    courtSubtotalAmount: 2,
    equipmentRentalFeeAmount: 5,
    equipmentRental: { extraPaddles: 1, balls: 2 },
    serviceFeeAmount: 3,
    totalAmount: 10,
  }));
  assert.equal(b.fullPaymentOnly, false);
  assert.equal(b.courtSubtotalAmount, 2);
  assert.equal(b.equipmentRentalFeeAmount, 5);
  assert.deepEqual(b.equipmentRental, { extraPaddles: 1, balls: 2 });
  assert.equal(b.totalAmount, 10);
  assert.throws(() => bookingResponse(booking({ totalAmount: null })));
});
Deno.test("SQL errors distinguish rate limit, expiry, conflicts and uncertain replies", () => {
  for (
    const [message, code, status] of [
      ["picklestreet_hold_rate_limited", "P0001", 429],
      ["picklestreet_hold_expired", "P0001", 409],
      ["picklestreet_idempotency_conflict", "P0001", 409],
      ["overlap", "23P01", 409],
      ["temporary interruption", "XX000", 503],
    ]
  ) assert.equal(databaseFailure({ message, code }).status, status);
  assert.match(
    databaseFailure({ message: "temporary interruption" }).message,
    /check its status|same request/i,
  );
});
Deno.test("fractional server court and service fee amounts stay exact to cents", async () => {
  const f = fixture();
  f.config.court.pricing_config.regular.bands[0].hourlyRate = 0.1;
  f.config.billing.fee_amount = 0.2;
  const b = await f.created();
  assert.equal(f.calls.create[0].p_subtotal_amount, 0.1);
  assert.equal(f.calls.create[0].p_service_fee_amount, 0.2);
  assert.equal(f.calls.create[0].p_total_amount, 0.3);
  assert.equal(b.totalAmount, 0.3);
});

Deno.test("production existing lookup scopes both tables to tenant, key and token hash", async () => {
  const queries: Obj[] = [];
  const calls: Obj[] = [];
  const db = {
    from(table: string) {
      const q = { table, filters: [] as unknown[], columns: "" };
      queries.push(q);
      return {
        select(columns: string) {
          q.columns = columns;
          return this;
        },
        eq(k: string, v: unknown) {
          q.filters.push([k, v]);
          return this;
        },
        async maybeSingle() {
          return { data: { booking_id: "stored-booking-id" }, error: null };
        },
        async single() {
          return { data: { reference: "PB-SYNTHETIC-01" }, error: null };
        },
      };
    },
    async rpc(name: string, args: Obj) {
      calls.push({ name, args });
      return { data: booking(), error: null };
    },
  };
  const r = await createHoldStore(db).existing(
    CLIENT,
    "hash-synthetic",
    "picklestreet.pages.dev",
  );
  assert.deepEqual(r!.selection, selection);
  assert.deepEqual(queries[0].filters, [["tenant_id", TENANT_ID], [
    "client_request_id",
    CLIENT,
  ], ["token_hash", "hash-synthetic"]]);
  assert.deepEqual(queries[1].filters, [["tenant_id", TENANT_ID], [
    "id",
    "stored-booking-id",
  ]]);
  assert.equal(calls[0].name, "get_picklestreet_provisional_hold");
  assert.equal(calls[0].args.p_access_token_hash, "hash-synthetic");
  assert.equal(calls[0].args.p_hostname, "picklestreet.pages.dev");
});
Deno.test("production booking configuration uses the court record without a private schedule-table dependency", async () => {
  const tables: string[] = [];
  const rows: Record<string, Obj | null> = {
    tenants: { id: TENANT_ID, timezone: "Asia/Manila", status: "active", public_config: {} },
    courts: {
      id: COURT,
      name: "Synthetic court",
      status: "active",
      opens_at: "05:00:00",
      closes_at: "17:00:00",
      currency: "PHP",
      pricing_config: { regular: { bands: [{ start: "05:00", end: "17:00", hourlyRate: 150 }] } },
      public_config: {},
    },
    tenant_platform_billing: { fee_mode: "fixed_per_booking", fee_amount: 1 },
    tenant_equipment_rental_pricing: null,
  };
  const db = {
    from(table: string) {
      tables.push(table);
      const result = { data: rows[table] ?? null, error: null };
      return {
        select() { return this; },
        eq() { return this; },
        async single() { return result; },
        async maybeSingle() { return result; },
      };
    },
    async rpc(name: string) {
      assert.equal(name, "tenant_booking_activation_state");
      return { data: { publicBookingEnabled: true }, error: null };
    },
  };
  const configured = await createHoldStore(db).configuration(COURT);
  assert.equal(configured.ready, true);
  assert.equal(configured.court.pricing_config.regular.bands[0].hourlyRate, 150);
  assert.deepEqual(tables, [
    "tenants",
    "courts",
    "tenant_platform_billing",
    "tenant_equipment_rental_pricing",
  ]);
});
Deno.test('group creation prices all sessions server-side and invokes one atomic create',async()=>{
 const f=fixture();let received:Obj={};f.store.create=async args=>{received=args;return booking({sessions:args.p_sessions,subtotalAmount:2,courtSubtotalAmount:2,totalAmount:3})};
 const second={...selection,courtId:'afb62052-cc6b-435e-a8b1-0265b613a771'};
 const r=await f.invoke({tenantSlug:TENANT_SLUG,action:'create',clientRequestId:CLIENT,sessions:[selection,second]});
 assert.equal(r.response.status,201);assert.equal(received.p_sessions.length,2);assert.equal(f.calls.configuration,2);assert.equal(r.data.booking.sessions.length,2);assert.equal(received.p_sessions[0].subtotalAmount,1);assert.equal(r.data.booking.reference,'PB-SYNTHETIC-01');
});
for(const sessions of [[{...selection,durationHours:10},{...selection,startTime:'22:00',durationHours:9}],[selection,{...selection,startTime:'12:00'}],[selection,{...selection,bookingDate:'2026-09-10'}],[{...selection,totalAmount:.01}],[{...selection,bookingType:'event'}]]){
 Deno.test('invalid group cannot create slots '+JSON.stringify(sessions),async()=>{const f=fixture();const r=await f.invoke({tenantSlug:TENANT_SLUG,action:'create',clientRequestId:CLIENT,sessions});assert.ok(r.response.status>=400);assert.equal(f.calls.create.length,0)});
}
Deno.test('group accepts separate hours and same hour on distinct courts',()=>{assert.equal(parseGroupSelections([selection,{...selection,startTime:'15:00'},{...selection,courtId:'afb62052-cc6b-435e-a8b1-0265b613a771'}]).length,3)});

for (const reason of ['customer_cancel','checkout_back','browser_timer_elapsed','recovery_cancel','unknown']) {
 Deno.test('cancellation forwards reason through authenticated store: '+reason, async()=>{
 const f=fixture(), b=await f.created(); const r=await f.invoke({tenantSlug:TENANT_SLUG,action:'cancel',bookingReference:b.reference,bookingToken:b.bookingToken,cancellationReason:reason});
 assert.equal(r.response.status,200);assert.equal(f.calls.cancel[0].p_reason,reason);
 });
}
Deno.test('invalid cancellation reason cannot reach the store',async()=>{const f=fixture(),b=await f.created();const r=await f.invoke({tenantSlug:TENANT_SLUG,action:'cancel',bookingReference:b.reference,bookingToken:b.bookingToken,cancellationReason:'staff_cancel'});assert.equal(r.response.status,400);assert.equal(f.calls.cancel.length,0);});
