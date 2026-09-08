/** Pure Pickle Street source-app -> configured GCash receipt evidence adapter.
 * No network, database writes, ledger queries, or final payment decisions.
 * All context except OCR and the compared customer reference is server-owned.
 */
import { Temporal } from "@js-temporal/polyfill";
import {
  type DedicatedReceiptProvider,
  parseProviderReceipt,
  type ProviderReceiptParse,
  type ProviderReceiptVerificationEvidence,
  verifyProviderReceipt,
} from "../_shared/picklestreet-source/receipt-providers/index.ts";
import type {
  InspectedReceiptImage,
  SafeReceiptExtraction,
  VisionTextResult,
} from "../_shared/receipt-verification.ts";

export const SOURCE_ROUTE_TENANT_ID = "f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a";
export const SOURCE_ROUTE_TENANT_SLUG = "pickle-street-tugbok";
export const SOURCE_ROUTE_WINDOW_MINUTES = 15;
export const SOURCE_ROUTE_MIN_NATIVE_CONFIDENCE = 0.90;
export type SecondaryReference = {
  kind: "instapay" | "maya_instapay" | "bdopay_invoice" | "bpi_transaction";
  value: string;
};
export type SourceRouteContext = {
  tenantId: string;
  tenantSlug: string;
  sourceProvider: string;
  destinationProvider: string;
  destinationMethodCode: string;
  enabled: boolean;
  autoApprovalEnabled: boolean;
  /** Exact receipt-specific label/token from private venue settings; no fallback token. */
  gcashQrAlias?: string;
  gcashQrToken?: string;
};
export type SourceRouteInput = {
  vision: VisionTextResult;
  image: InspectedReceiptImage;
  expectedAmount: number;
  currency: string;
  payment: {
    paymentMethod: string;
    submittedReference: string;
    receiverName: string;
    receiverReference: string;
  };
  timing: { bookingStartedAt: string; tenantTimezone: string };
  route: SourceRouteContext;
};
export type RouteEvidence = {
  schemaVersion: 1;
  routeId: string;
  sourceProvider: string;
  destinationProvider: "gcash";
  destinationMethodCode: "gcash";
  parserVersion: string;
  verifierVersion: "picklestreet_sources_20260908_2";
  sourceMatched: boolean;
  destinationMatched: boolean;
  recipientMatched: boolean;
  referenceMatched: boolean;
  successMatched: boolean;
  secondaryReferences: SecondaryReference[];
  recipient?: {
    observedName: string | null;
    observedNumber: string | null;
    phoneMatch: string;
    nameMatch: string;
  };
};
export type SourceRouteExtraction = Omit<SafeReceiptExtraction, "detected"> & {
  detected: SafeReceiptExtraction["detected"] & { route: RouteEvidence };
};
export type SourceRouteResult = {
  extractedData: SourceRouteExtraction;
  paymentReference: string | null;
  flags: string[];
  autoApprove: boolean;
};

export function canonicalSourceProvider(
  value: unknown,
): DedicatedReceiptProvider | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["bdo", "bdo_pay", "bdopay"].includes(raw)) return "bdopay";
  return ["gcash", "maya", "bpi", "gotyme", "maribank"].includes(raw)
    ? raw as DedicatedReceiptProvider
    : null;
}
const flag = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
const normalizedReference = (value: string | null | undefined) =>
  String(value || "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
const validReference = (value: string) => /^[A-Z0-9]{6,64}$/.test(value);
const phone = (value: string) =>
  String(value || "").replace(/\D/g, "").replace(/^(?:63|0)(?=9)/, "");
const sourceBrands: Record<DedicatedReceiptProvider, RegExp> = {
  gcash: /\bsent\s+(?:via|through)\s+gcash\b/i,
  bdopay: /\bbdo\s*pay\b/i,
  maya: /\bmaya\b|\bpaymaya\b/i,
  bpi: /\bsent\s+via\s+bpi\b|\bbpi\s+(?:receipt|transfer)\b/i,
  gotyme: /\bgo\s*tyme\b/i,
  maribank: /\bmari\s*bank\b/i,
};
function recipientPassed(
  parsed: ProviderReceiptParse,
  evidence: ProviderReceiptVerificationEvidence,
): boolean {
  if (evidence.provider === "gcash") {
    return evidence.recipientComparison.phone === "exact" &&
      ["exact", "masked_compatible"].includes(evidence.recipientComparison.name);
  }
  if (evidence.provider === "maya") {
    return evidence.recipientComparison.phone === "exact" &&
      ["exact", "masked_compatible"].includes(
        evidence.recipientComparison.name,
      );
  }
  if (evidence.provider === "bdopay") {
    return evidence.recipientComparison.name === "exact" &&
      evidence.recipientComparison.account === "exact";
  }
  if (evidence.provider === "bpi") {
    return evidence.recipientComparison === "exact" &&
      evidence.recipientAccountComparison === "exact";
  }
  // Preserve the full-account rule for bank routes. Last-four-only proof remains pending.
  return evidence.recipientComparison.phone === "exact" &&
    ["exact", "masked_compatible"].includes(
      evidence.recipientComparison.name,
    ) &&
    parsed.provider !== "gcash" && "recipient" in parsed.receipt &&
    "phoneVisibility" in parsed.receipt.recipient &&
    parsed.receipt.recipient.phoneVisibility === "full";
}
function secondary(parsed: ProviderReceiptParse): SecondaryReference[] {
  if (parsed.provider === "gcash") return [];
  const ref = parsed.provider === "bdopay"
    ? { kind: "bdopay_invoice" as const, value: parsed.receipt.invoice.value }
    : parsed.provider === "bpi"
    ? {
      kind: "bpi_transaction" as const,
      value: parsed.receipt.transactionReference.value,
    }
    : {
      kind: parsed.provider === "maya"
        ? "maya_instapay" as const
        : "instapay" as const,
      value: parsed.receipt.railReference.value,
    };
  const value = normalizedReference(ref.value);
  return /^[A-Z0-9]{3,64}$/.test(value) ? [{ kind: ref.kind, value }] : [];
}
function routeMatches(
  parsed: ProviderReceiptParse,
): { source: boolean; destination: boolean; successful: boolean } {
  if (parsed.provider === "gcash") {
    return {
      source: parsed.receipt.indicators.classification === "gcash",
      destination: true,
      successful: parsed.receipt.indicators.sentViaGcash &&
        parsed.receipt.indicators.totalAmountSent,
    };
  }
  const i = parsed.receipt.indicators;
  return {
    source: i.providerBrand && !i.competingProviderBrand,
    destination: i.destinationGcash,
    successful: parsed.provider === "maya"
      ? parsed.receipt.indicators.completionScreen &&
        !parsed.receipt.indicators.failureStatus &&
        !parsed.receipt.indicators.pendingStatus
      : parsed.receipt.indicators.transferSuccess,
  };
}

export function verifySourceRoute(input: SourceRouteInput): SourceRouteResult {
  const flags: string[] = [];
  const add = (value: string) => {
    const normalized = flag(value);
    if (!flags.includes(normalized)) flags.push(normalized);
  };
  const source = canonicalSourceProvider(input.route?.sourceProvider);
  const paymentSource = canonicalSourceProvider(input.payment?.paymentMethod);
  const expected = Number(input.expectedAmount);
  const currency = String(input.currency || "").toUpperCase();
  const text = String(input.vision?.text || "");
  const native = input.vision?.confidence;
  const validNative = typeof native === "number" && Number.isFinite(native) &&
    native >= 0 && native <= 1;
  const nativeConfidence = validNative ? native : null;
  if (!validNative) add("native_ocr_confidence_missing");
  else if (native < SOURCE_ROUTE_MIN_NATIVE_CONFIDENCE) {
    add("low_ocr_confidence");
  }
  if (
    input.route?.tenantId !== SOURCE_ROUTE_TENANT_ID ||
    input.route?.tenantSlug !== SOURCE_ROUTE_TENANT_SLUG
  ) add("tenant_context_invalid");
  if (!source || source !== paymentSource) add("source_route_unsupported");
  if (
    input.route?.destinationProvider !== "gcash" ||
    input.route?.destinationMethodCode !== "gcash"
  ) add("destination_route_unsupported");
  if (input.route?.enabled !== true) add("source_route_disabled");
  if (input.route?.autoApprovalEnabled !== true) {
    add("automatic_method_disabled");
  }
  if (
    !Number.isFinite(expected) || expected <= 0 ||
    Math.abs(Math.round(expected * 100) - expected * 100) > 0.000001
  ) add("expected_payment_invalid");
  if (currency !== "PHP" || /\b(?:USD|EUR|SGD|AUD|JPY|GBP)\b/i.test(text)) {
    add("currency_unverified");
  }
  if (!text.trim()) add("ocr_text_not_detected");
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(
      input.image?.mimeType,
    ) || !Number.isInteger(input.image?.sizeBytes) ||
    input.image.sizeBytes < 1 || input.image.sizeBytes > 8 * 1024 * 1024
  ) add("receipt_image_unverified");
  if (
    !/^9\d{9}$/.test(phone(input.payment?.receiverReference || "")) ||
    !String(input.payment?.receiverName || "").trim()
  ) add("receiving_account_unconfigured");
  const alias = String(input.route?.gcashQrAlias || "").trim();
  const token = String(input.route?.gcashQrToken || "").trim();
  if (source === "bdopay" || source === "bpi") {
    if (
      alias.length < 2 ||
      !/^[A-Z0-9]{10,40}$/i.test(normalizedReference(token)) ||
      !/[A-Z]/i.test(token) || !/[0-9]/.test(token)
    ) add("qr_receipt_identity_unconfigured");
  }
  if (
    /\b(?:failed|unsuccessful|pending|processing|scheduled|reversed|refunded|cancelled|canceled)\b/i
      .test(text)
  ) add("transaction_not_successful");
  if (
    source &&
    Object.entries(sourceBrands).some(([provider, expression]) =>
      provider !== source && provider !== "gcash" && expression.test(text)
    )
  ) add("payment_source_mismatch");
  let started: Temporal.Instant | null = null;
  try {
    started = Temporal.Instant.from(input.timing?.bookingStartedAt);
    if (input.timing?.tenantTimezone !== "Asia/Manila") {
      throw Error("Unsupported zone");
    }
  } catch {
    add("payment_timing_context_invalid");
  }
  const route: RouteEvidence = {
    schemaVersion: 1,
    routeId: source ? `${source}_to_gcash` : "unsupported_to_gcash",
    sourceProvider: source || "unsupported",
    destinationProvider: "gcash",
    destinationMethodCode: "gcash",
    parserVersion: "unsupported",
    verifierVersion: "picklestreet_sources_20260908_2",
    sourceMatched: false,
    destinationMatched: false,
    recipientMatched: false,
    referenceMatched: false,
    successMatched: false,
    secondaryReferences: [],
  };
  let primary: string | null = null;
  let amount: number | null = null;
  let receiptDate: string | null = null;
  let receiptTime: string | null = null;
  let receiptAt: string | null = null;
  let amountMatched = false;
  let withinWindow = false;
  let ageMinutes: number | null = null;
  if (source) {
    try {
      const parsed = parseProviderReceipt(source, text, {
        typedReference: String(input.payment?.submittedReference || ""),
      });
      const context = {
        typedReference: String(input.payment?.submittedReference || ""),
        expectedAmount: expected,
        pricingAvailable: Number.isFinite(expected) && expected > 0,
        amountTolerance: 0.001,
        expectedRecipientNumber: String(input.payment?.receiverReference || ""),
        expectedRecipientName: source === "bdopay" || source === "bpi"
          ? alias
          : String(input.payment?.receiverName || ""),
        expectedRecipientAccount: token,
        bookingStartedAt: input.timing?.bookingStartedAt,
        paymentWindowMinutes: SOURCE_ROUTE_WINDOW_MINUTES,
        earlyToleranceMinutes: 2,
      };
      const evidence = verifyProviderReceipt(parsed, context);
      for (const value of evidence.flags) add(value);
      const receipt = parsed.receipt;
      const matched = routeMatches(parsed);
      route.parserVersion = parsed.parserVersion;
      route.sourceMatched = matched.source;
      route.destinationMatched = matched.destination;
      route.successMatched = matched.successful;
      route.recipientMatched = recipientPassed(parsed, evidence);
      if (parsed.provider === "gcash" && evidence.provider === "gcash") {
        // These are OCR observations, never substituted from venue settings.
        // Keep masking intact so staff can see exactly what was compared.
        route.recipient = {
          observedName: parsed.receipt.receiver.name.raw?.slice(0, 160) || null,
          observedNumber: parsed.receipt.receiver.phone.raw?.slice(0, 80) || null,
          phoneMatch: evidence.recipientComparison.phone,
          nameMatch: evidence.recipientComparison.name,
        };
      }
      route.secondaryReferences = secondary(parsed);
      const observed = normalizedReference(receipt.reference.value);
      if (validReference(observed)) primary = observed;
      route.referenceMatched = primary !== null &&
        receipt.reference.typedMatch === "match" &&
        receipt.reference.confidence === "high";
      if (
        parsed.provider === "gcash" &&
        parsed.receipt.reference.source !== "ref_label"
      ) route.referenceMatched = false;
      if (!route.sourceMatched) add("payment_source_unverified");
      if (!route.destinationMatched) add("payment_destination_unverified");
      if (!route.successMatched) add("transaction_success_unverified");
      if (!route.recipientMatched) add("payment_receiver_unverified");
      if (!route.referenceMatched) add("payment_reference_unverified");
      if (source !== "gcash" && route.secondaryReferences.length !== 1) {
        add("secondary_reference_unverified");
      }
      if (
        receipt.amount.reliable && !receipt.amount.ambiguous &&
        Number.isFinite(receipt.amount.amount)
      ) amount = receipt.amount.amount;
      amountMatched = amount !== null && Math.abs(amount - expected) < 0.001;
      if (!amountMatched) add("payment_principal_unverified");
      receiptDate = receipt.timestamp.date;
      receiptTime = receipt.timestamp.time24;
      if (
        receipt.timestamp.completeness === "date_time" && receiptDate &&
        receiptTime && receipt.timestamp.instant && started
      ) {
        const local = Temporal.PlainDateTime.from(
          `${receiptDate}T${receiptTime}:00`,
          { overflow: "reject" },
        ).toZonedDateTime("Asia/Manila", { disambiguation: "reject" })
          .toInstant();
        const parsedInstant = Temporal.Instant.from(receipt.timestamp.instant);
        if (
          Math.abs(local.epochMilliseconds - parsedInstant.epochMilliseconds) >=
            60000
        ) throw Error("Receipt timestamp inconsistent");
        receiptAt = parsedInstant.toString();
        ageMinutes =
          (parsedInstant.epochMilliseconds - started.epochMilliseconds) / 60000;
        withinWindow = ageMinutes >= -2 &&
          ageMinutes <= SOURCE_ROUTE_WINDOW_MINUTES;
      }
      if (!receiptAt) add("receipt_datetime_unverified");
      else if (!withinWindow) add("payment_window_expired");
      // Dedicated provider evidence above is authoritative for receipt fields.
      // In particular, GCash requires matching Amount/Total Amount Sent displays
      // and a full receiving number with a compatible visible name. A second
      // generic text grammar must not contradict those structured observations.
    } catch {
      add("receipt_parser_unavailable");
    }
  }
  // Never invent OCR confidence from a checklist of matching values. Evidence
  // can only lower the actual native confidence, never replace or raise it.
  const evidence = [
    route.sourceMatched,
    route.destinationMatched,
    route.successMatched,
    route.recipientMatched,
    route.referenceMatched,
    amountMatched,
    withinWindow,
  ]
    .filter(Boolean).length / 7;
  const effective = nativeConfidence === null
    ? 0
    : Math.min(nativeConfidence, evidence);
  const autoApprove = flags.length === 0 &&
    effective >= SOURCE_ROUTE_MIN_NATIVE_CONFIDENCE;
  const finalFlags = autoApprove ? ["auto_approval_eligible"] : [
    "manual_review_required",
    ...flags.filter((f) => f !== "manual_review_required"),
  ].slice(0, 20);
  const extractedData: SourceRouteExtraction = {
    schemaVersion: 2,
    provider: "google_vision",
    feature: "DOCUMENT_TEXT_DETECTION",
    ocrCharacterCount: text.length,
    file: { mimeType: input.image.mimeType, sizeBytes: input.image.sizeBytes },
    detected: {
      amounts: amount === null ? [] : [amount],
      ...(primary ? { paymentReference: primary } : {}),
      route,
    },
    comparison: { expectedAmount: expected, currency, amountMatched },
    timing: {
      receiptDate,
      receiptTime,
      receiptDateTime: receiptAt,
      bookingStartedAt: started?.toString() ||
        String(input.timing?.bookingStartedAt || ""),
      tenantTimezone: String(input.timing?.tenantTimezone || ""),
      ageMinutes,
      allowedWindowMinutes: SOURCE_ROUTE_WINDOW_MINUTES,
      earlyToleranceMinutes: 2,
      withinWindow,
    },
    confidence: {
      vision: nativeConfidence,
      evidence,
      effective,
      source: nativeConfidence === null
        ? "evidence_only"
        : "google_vision_plus_evidence",
    },
  };
  return {
    extractedData,
    paymentReference: primary,
    flags: finalFlags,
    autoApprove,
  };
}
