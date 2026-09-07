import {
  canonicalMethod,
  type Context,
  type Method,
  METHODS,
  parseNativeReceipt,
  TARGET_TENANT,
  verifyNativeCandidate,
} from "./native-receipt.ts";
import { verifyNativeReceiptWithDeployedAdapter } from "./deployed-adapter.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
const BANK: Record<Method, string> = {
  gcash: "GCash",
  maya: "Maya Bank",
  bdo_pay: "BDO Pay",
  bpi: "BPI",
  gotyme: "GoTyme Bank Corporation",
  pnb: "Philippine National Bank",
};
function context(method: Method): Context {
  return {
    tenantId: TARGET_TENANT.id,
    tenantSlug: TARGET_TENANT.slug,
    expectedAmountMinor: 50_000,
    currency: "PHP",
    recipientName: "TEST PERSON ONLY",
    recipientAccount: method === "gcash" ? "09171234567" : "123456789012",
    submittedReference: method === "gcash" ? "1234567890123" : "TESTREF123456",
    bookingStartedAt: "2026-09-07T02:00:00Z",
    timezone: "Asia/Manila",
    methodActive: true,
    bookingApprovalMode: "automatic",
    ocrConfidence: 0.98,
  };
}

/** SYNTHETIC CANONICAL FIXTURE. Not a bank receipt or a production layout sample. */
function fixture(method: Method): string {
  const ctx = context(method);
  return [
    "SYNTHETIC TEST DATA - NOT A REAL PAYMENT",
    "Destination Account",
    `Account Name: ${ctx.recipientName}`,
    `Bank: ${BANK[method]}`,
    `Account Number: ${ctx.recipientAccount}`,
    "Status: Transfer Successful",
    "Amount: PHP 500.00",
    "Total Amount Sent: PHP 500.00",
    "Fee: PHP 15.00",
    `Reference No: ${ctx.submittedReference}`,
    "Date and Time: Sep 07, 2026 10:03 AM",
    method === "gcash" ? "Sent via GCash" : "",
  ].filter(Boolean).join("\n");
}
function evaluate(
  method: Method,
  text = fixture(method),
  overrides: Partial<Context> = {},
) {
  return verifyNativeCandidate(parseNativeReceipt(method, text), {
    ...context(method),
    ...overrides,
  });
}
function mustReview(
  method: Method,
  text: string,
  flag: string,
  overrides: Partial<Context> = {},
) {
  const result = evaluate(method, text, overrides);
  equal(result.autoApprove, false);
  assert(
    result.flags.includes(flag),
    `${method}: missing ${flag}; flags=${result.flags.join(",")}`,
  );
}

Deno.test("method registry rejects aliases and unknown methods before parsing", () => {
  for (const method of METHODS) equal(canonicalMethod(method), method);
  equal(canonicalMethod(" BDO_PAY "), "bdo_pay");
  for (
    const value of ["bdopay", "gcash_to_pnb", "cash", "__proto__", "", null]
  ) equal(canonicalMethod(value), null);
});

for (const method of METHODS) {
  Deno.test(`${method}: synthetic canonical full-account evidence is extracted without production approval`, () => {
    const result = evaluate(method);
    equal(result.mandatoryEvidenceComplete, true);
    equal(result.evidence.destinationMethod, method);
    equal(result.evidence.amountMinor, 50_000);
    equal(result.evidence.primaryReference, context(method).submittedReference);
    equal(result.evidence.receiptAt, "2026-09-07T02:03:00.000Z");
    equal(result.autoApprove, false);
    assert(
      result.flags.includes(
        ["gcash", "gotyme"].includes(method)
          ? "DEPLOYED_LAYOUT_NOT_CORROBORATED"
          : "UNSUPPORTED_NATIVE_LAYOUT",
      ),
    );
  });

  Deno.test(`${method}: wrong destination cannot be rescued by provider branding outside the recipient block`, () => {
    const other = method === "pnb" ? "gcash" : "pnb";
    const text =
      fixture(method).replace(`Bank: ${BANK[method]}`, `Bank: ${BANK[other]}`) +
      `\n${BANK[method]}`;
    mustReview(method, text, "WRONG_DESTINATION_METHOD");
  });

  Deno.test(`${method}: expected sender identity cannot satisfy destination identity`, () => {
    const ctx = context(method);
    const text = fixture(method).replace(ctx.recipientName, "WRONG PERSON ONLY")
      .replace(ctx.recipientAccount, "09999999999") +
      `\nSource Account\nAccount Name: ${ctx.recipientName}\nAccount Number: ${ctx.recipientAccount}`;
    mustReview(method, text, "RECIPIENT_NAME_MISMATCH");
    mustReview(method, text, "RECIPIENT_ACCOUNT_MISMATCH");
  });

  Deno.test(`${method}: amount mismatch and conflicting principals cannot match a fee`, () => {
    mustReview(
      method,
      fixture(method).replaceAll("500.00", "400.00").replace("15.00", "500.00"),
      "AMOUNT_MISMATCH",
    );
    mustReview(
      method,
      fixture(method).replace("Amount: PHP 500.00", "Amount: PHP 400.00"),
      "AMBIGUOUS_PRINCIPAL_AMOUNT",
    );
    mustReview(
      method,
      fixture(method).replaceAll("PHP 500.00", "USD 500.00"),
      "CONFLICTING_CURRENCY",
    );
  });

  Deno.test(`${method}: typed reference is comparison-only; ambiguity and wrong reference require review`, () => {
    const noReference = fixture(method).replace(/^Reference No:.*$/m, "");
    mustReview(
      method,
      noReference + `\nNote: ${context(method).submittedReference}`,
      "REFERENCE_UNREADABLE",
    );
    mustReview(
      method,
      fixture(method) + "\nReference No: 9876543210987",
      "AMBIGUOUS_REFERENCE",
    );
    mustReview(method, fixture(method), "REFERENCE_MISMATCH", {
      submittedReference: "9876543210987",
    });
  });

  Deno.test(`${method}: duplicate recipient blocks, competing bank and masked account fail closed`, () => {
    mustReview(
      method,
      fixture(method) + "\nDestination Account\nBank: GCash",
      "AMBIGUOUS_DESTINATION_BLOCK",
    );
    const other = method === "pnb" ? "GCash" : "PNB";
    mustReview(
      method,
      fixture(method).replace(
        `Bank: ${BANK[method]}`,
        `Bank: ${BANK[method]}\nBank: ${other}`,
      ),
      "AMBIGUOUS_DESTINATION_METHOD",
    );
    mustReview(
      method,
      fixture(method).replace(context(method).recipientAccount, "****4567"),
      "RECIPIENT_ACCOUNT_NOT_FULL",
    );
  });

  Deno.test(`${method}: successful marker does not override failed or pending status`, () => {
    for (const status of ["Pending", "Failed", "Reversed", "Scheduled"]) {
      mustReview(
        method,
        fixture(method) + `\nStatus: ${status}`,
        "UNSUCCESSFUL_OR_PENDING_TRANSFER",
      );
    }
    mustReview(
      method,
      fixture(method).replace("Status: Transfer Successful", "Receipt"),
      "SUCCESSFUL_TRANSFER_UNREADABLE",
    );
  });

  Deno.test(`${method}: missing, invalid, stale, premature and ambiguous timestamps require review`, () => {
    mustReview(
      method,
      fixture(method).replace(/^Date and Time:.*$/m, ""),
      "TIMESTAMP_UNREADABLE",
    );
    mustReview(
      method,
      fixture(method).replace("Sep 07, 2026", "Sep 31, 2026"),
      "TIMESTAMP_INVALID",
    );
    mustReview(
      method,
      fixture(method).replace("10:03 AM", "10:11 AM"),
      "OUTSIDE_PAYMENT_WINDOW",
    );
    mustReview(
      method,
      fixture(method).replace("10:03 AM", "09:57 AM"),
      "OUTSIDE_PAYMENT_WINDOW",
    );
    mustReview(
      method,
      fixture(method) + "\nDate and Time: Sep 07, 2026 10:04 AM",
      "AMBIGUOUS_TIMESTAMP",
    );
  });

  Deno.test(`${method}: tenant, recipient config, timezone and confidence are mandatory server context`, () => {
    mustReview(method, fixture(method), "TENANT_DENIED", {
      tenantId: "other-tenant",
    });
    mustReview(method, fixture(method), "TENANT_DENIED", {
      tenantSlug: "qdink-garage",
    });
    mustReview(method, fixture(method), "METHOD_INACTIVE", {
      methodActive: false,
    });
    mustReview(method, fixture(method), "TENANT_MANUAL_REVIEW", {
      bookingApprovalMode: "manual",
    });
    mustReview(method, fixture(method), "EXPECTED_RECIPIENT_ACCOUNT_INVALID", {
      recipientAccount: "",
    });
    mustReview(method, fixture(method), "EXPECTED_RECIPIENT_NAME_INVALID", {
      recipientName: "",
    });
    mustReview(method, fixture(method), "TIMEZONE_UNSUPPORTED", {
      timezone: "UTC",
    });
    mustReview(method, fixture(method), "OCR_CONFIDENCE_INSUFFICIENT", {
      ocrConfidence: 0.4,
    });
  });
}

Deno.test("Maya/BDO Pay/BPI/PNB synthetic native layouts remain unsupported even with an approval-shaped adapter result", () => {
  for (const method of ["maya", "bdo_pay", "bpi", "pnb"] as const) {
    const decision = verifyNativeCandidate(
      parseNativeReceipt(method, fixture(method)),
      context(method),
      { autoApprove: true },
    );
    equal(decision.autoApprove, false);
    assert(decision.flags.includes("UNSUPPORTED_NATIVE_LAYOUT"));
  }
});

for (const method of ["gcash", "gotyme"] as const) {
  Deno.test(`${method}: exact deployed adapter plus strict evidence can yield only a pre-finalization candidate`, () => {
    const result = verifyNativeReceiptWithDeployedAdapter({
      method,
      text: fixture(method),
      context: context(method),
      image: { mimeType: "image/png", sizeBytes: 1024 },
      gotymeAutoApprovalEnabled: true,
    });
    equal(result.flags, []);
    equal(result.autoApprove, true);
    equal(result.status, "auto_approval_candidate");
  });
}

Deno.test("GoTyme deployed adapter retains tenant opt-in gate", () => {
  const result = verifyNativeReceiptWithDeployedAdapter({
    method: "gotyme",
    text: fixture("gotyme"),
    context: context("gotyme"),
    image: { mimeType: "image/png", sizeBytes: 1024 },
    gotymeAutoApprovalEnabled: false,
  });
  equal(result.autoApprove, false);
  assert(result.flags.includes("DEPLOYED_LAYOUT_NOT_CORROBORATED"));
});

Deno.test("unknown layout does not broaden the exact deployed GCash adapter", () => {
  const text = fixture("gcash").replace("Sent via GCash", "").replace(
    "Total Amount Sent: PHP 500.00",
    "",
  );
  const result = verifyNativeReceiptWithDeployedAdapter({
    method: "gcash",
    text,
    context: context("gcash"),
    image: { mimeType: "image/png", sizeBytes: 1024 },
    gotymeAutoApprovalEnabled: true,
  });
  equal(result.autoApprove, false);
  assert(result.flags.includes("DEPLOYED_LAYOUT_NOT_CORROBORATED"));
});
