import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";

const GOTYME_CONFIG = {
  provider: "gotyme" as const,
  parserVersion: "gotyme_to_gcash_v2" as const,
  brandPattern: /\bgo\s*tyme\b|\bgotyme\b/i,
  competingBrandPattern: /\bmari\s*bank\b|\bmaribank\b/i,
  competingProvider: "maribank" as const,
  unreadableFlag: "GOTYME_RECEIPT_UNREADABLE",
  // Current GoTyme transfer details mark completed InstaPay transfers as
  // "Instant" instead of spelling out "Transfer successful".
  transferSuccessPattern: /^instant$/im,
  instaPayPattern: /^instant$/im,
  primaryReferencePattern: /\b(ITO\d{12,20}|GTY[A-Z0-9]{12,24})\b/i,
  railReferencePattern: /\btrace\s*id\b[\s\S]{0,260}?\n(\d{4,12})(?:\n|$)/i,
  allowOcrOnlyPrimaryReference: true,
};

export function parseGotymeToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "gotyme" } {
  return parseBankToGcashReceipt(rawText, options, GOTYME_CONFIG) as
    & BankToGcashReceiptParse
    & { provider: "gotyme" };
}

export function verifyGotymeToGcashReceipt(
  parsed: BankToGcashReceiptParse & { provider: "gotyme" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "gotyme" } {
  return verifyBankToGcashReceipt(
    parsed,
    context,
    GOTYME_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "gotyme" };
}
