import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";

const MARIBANK_CONFIG = {
  provider: "maribank" as const,
  parserVersion: "maribank_to_gcash_v1" as const,
  brandPattern: /\bmari\s*bank\b|\bmaribank\b/i,
  competingBrandPattern: /\bgo\s*tyme\b|\bgotyme\b/i,
  competingProvider: "gotyme" as const,
  unreadableFlag: "MARIBANK_RECEIPT_UNREADABLE",
};

export function parseMaribankToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "maribank" } {
  return parseBankToGcashReceipt(rawText, options, MARIBANK_CONFIG) as
    & BankToGcashReceiptParse
    & { provider: "maribank" };
}

export function verifyMaribankToGcashReceipt(
  parsed: BankToGcashReceiptParse & { provider: "maribank" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "maribank" } {
  return verifyBankToGcashReceipt(
    parsed,
    context,
    MARIBANK_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "maribank" };
}
