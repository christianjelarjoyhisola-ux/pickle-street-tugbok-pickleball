import {
  buildSafeReceiptExtraction,
  type InspectedReceiptImage,
} from "./deployed/_shared/receipt-verification.ts";
import {
  type Context,
  type Decision,
  type Method,
  parseNativeReceipt,
  TARGET_TENANT,
  verifyNativeCandidate,
} from "./native-receipt.ts";

/**
 * Pure wrapper around the exact deployed GCash/GoTyme extraction snapshot.
 * Caller MUST derive method/context from the tenant-bound session and active
 * destination record, independently validate the image, and check duplicates.
 * Results are candidates, not authorization to mark a booking paid.
 */
export function verifyNativeReceiptWithDeployedAdapter(options: {
  method: Method;
  text: string;
  context: Context;
  image: InspectedReceiptImage;
  /** Read from tenant.public_config; never from an upload/body/header. */
  gotymeAutoApprovalEnabled: boolean;
}): Decision {
  const parsed = parseNativeReceipt(options.method, options.text);
  let corroboration: { autoApprove: boolean } | undefined;
  if (
    options.context.tenantId === TARGET_TENANT.id &&
    options.context.tenantSlug === TARGET_TENANT.slug &&
    (options.method === "gcash" || options.method === "gotyme")
  ) {
    try {
      corroboration = buildSafeReceiptExtraction({
        vision: {
          text: options.text,
          confidence: options.context.ocrConfidence,
        },
        image: options.image,
        expectedAmount: options.context.expectedAmountMinor / 100,
        currency: options.context.currency,
        payment: {
          paymentMethod: options.method,
          submittedReference: options.context.submittedReference,
          receiverName: options.context.recipientName,
          receiverReference: options.context.recipientAccount,
          autoApprovalEnabled: options.method === "gcash" ||
            options.gotymeAutoApprovalEnabled,
        },
        timing: {
          bookingStartedAt: options.context.bookingStartedAt,
          tenantTimezone: options.context.timezone,
        },
      });
    } catch {
      // Invalid context or an unsupported deployed layout cannot broaden approval.
      corroboration = { autoApprove: false };
    }
  }
  return verifyNativeCandidate(parsed, options.context, corroboration);
}
