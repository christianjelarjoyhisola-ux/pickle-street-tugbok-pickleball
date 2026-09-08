import assert from "node:assert/strict";
import { MailerooDeliveryError } from "../_shared/maileroo.ts";
import {
  buildGroupedRescheduleEmail,
  deliverGroupedRescheduleEmail,
  type GroupEmailStore,
} from "./email.ts";
import type {
  JsonObject,
  RescheduleEmailMessage,
} from "../_shared/reschedule-booking.ts";

const eventId = "30d05c2a-4707-49df-8b1c-cc96c8d1a3cb";
const before = [
  {
    sessionId: "s1",
    courtName: "Court 1",
    startsAt: "2026-10-10T09:00:00Z",
    endsAt: "2026-10-10T10:00:00Z",
  },
  {
    sessionId: "s2",
    courtName: "Court 2",
    startsAt: "2026-10-10T10:00:00Z",
    endsAt: "2026-10-10T12:00:00Z",
  },
  {
    sessionId: "s3",
    courtName: "Court 3",
    startsAt: "2026-10-12T15:00:00Z",
    endsAt: "2026-10-12T16:00:00Z",
  },
];
const after = [
  {
    ...before[0],
    startsAt: "2026-10-11T09:00:00Z",
    endsAt: "2026-10-11T10:00:00Z",
  },
  before[1],
  before[2],
];
function payload(state = "pending"): JsonObject {
  return {
    tenant: {
      name: "Pickle Street Tugbok",
      timezone: "Asia/Manila",
      replyToEmail: "venue@example.test",
      emailEnabled: true,
    },
    booking: {
      reference: "PB-TEST123456",
      customerName: "Guest <script>",
      customerEmail: "guest@example.test",
      totalAmount: 800,
      currency: "PHP",
    },
    event: {
      notify_customer: true,
      email_status: state,
      public_reason: "Rain & weather",
      internal_note: "PRIVATE: never email",
    },
    beforeSessions: before,
    sessions: after,
    quote: { price: { additionalAmount: 50 } },
  };
}
function fakeStore(state = "pending") {
  let current = state;
  const finishes: unknown[] = [];
  const store: GroupEmailStore = {
    payload: async () => payload(current),
    claim: async (_id, force) => {
      if (current === "sent" && !force || current === "sending") {
        return { shouldSend: false, status: current };
      }
      current = "sending";
      return { shouldSend: true };
    },
    finish: async (_id, status, ref, code) => {
      finishes.push({ status, ref, code });
      current = status;
      return { sentAt: "2026-09-09T00:00:00Z" };
    },
    skip: async (_id, status) => {
      current = status;
    },
  };
  return { store, finishes };
}
Deno.test("group confirmation lists every final session and only changed rows in before/after history", () => {
  const message = buildGroupedRescheduleEmail(payload(), "mail-test-id");
  assert.match(message.plainText, /Court 1/);
  assert.match(message.plainText, /Court 2/);
  assert.match(message.plainText, /Court 3/);
  assert.equal((message.plainText.match(/Previous:/g) ?? []).length, 1);
  assert.match(message.plainText, /Additional payment received: ₱50\.00/);
  assert.match(message.plainText, /Oct 13, 2026/); // Midnight crosses the local date boundary.
  assert.doesNotMatch(message.plainText + message.html, /PRIVATE/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.subject, /PB-TEST123456/);
});
Deno.test("missing grouped schedule refuses to send a misleading partial confirmation", () => {
  assert.throws(() =>
    buildGroupedRescheduleEmail({ ...payload(), sessions: [] }, "test")
  );
});
Deno.test("concurrent and repeated confirmation attempts send one email", async () => {
  const { store } = fakeStore();
  const messages: RescheduleEmailMessage[] = [];
  const sender = {
    send: async (message: RescheduleEmailMessage) => {
      messages.push(message);
      return { referenceId: "delivery-1" };
    },
  };
  await Promise.all(
    [1, 2].map(() => deliverGroupedRescheduleEmail({ store, sender, eventId })),
  );
  await deliverGroupedRescheduleEmail({ store, sender, eventId });
  assert.equal(messages.length, 1);
});
Deno.test("interrupted or unknown email claims are never automatically resent", async () => {
  for (const state of ["sending", "delivery_unknown"]) {
    const { store } = fakeStore(state);
    const result = await deliverGroupedRescheduleEmail({
      store,
      sender: {
        send: async () => {
          throw Error("must not send");
        },
      },
      eventId,
      retryFailed: true,
    });
    assert.equal(result.status, state);
  }
});
Deno.test("disabled or unrequested email is skipped before claiming delivery", async () => {
  for (
    const patch of [{ tenant: { emailEnabled: false } }, {
      event: { notify_customer: false },
    }]
  ) {
    const { store } = fakeStore();
    store.payload = async () => ({ ...payload(), ...patch });
    store.claim = async () => {
      throw Error("must not claim");
    };
    const result = await deliverGroupedRescheduleEmail({
      store,
      sender: {
        send: async () => {
          throw Error("must not send");
        },
      },
      eventId,
    });
    assert.ok(["disabled", "not_requested"].includes(String(result.status)));
  }
});
Deno.test("provider ambiguity is saved as delivery_unknown and retains the claim", async () => {
  const { store, finishes } = fakeStore();
  const result = await deliverGroupedRescheduleEmail({
    store,
    eventId,
    sender: {
      send: async () => {
        throw new MailerooDeliveryError("Unknown delivery", true);
      },
    },
  });
  assert.equal(result.status, "delivery_unknown");
  assert.deepEqual(finishes, [{
    status: "delivery_unknown",
    ref: null,
    code: "MAILEROO_DELIVERY_UNKNOWN",
  }]);
});
Deno.test("a successful provider response with a lost finalization does not enable duplicate sends", async () => {
  const { store } = fakeStore();
  const finishes: string[] = [];
  store.finish = async (_id, status) => {
    finishes.push(status);
    throw Error("Lost response");
  };
  const result = await deliverGroupedRescheduleEmail({
    store,
    eventId,
    sender: { send: async () => ({ referenceId: "provider-1" }) },
  });
  assert.equal(result.status, "delivery_unknown");
  assert.deepEqual(finishes, ["sent", "delivery_unknown"]);
});
