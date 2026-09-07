import {
  type BdoPayReceiptParse,
  type BdoPayReceiptVerificationEvidence,
  parseBdoPayToGcashReceipt,
  verifyBdoPayToGcashReceipt,
} from "./bdopay.ts";
import {
  compareGcashRecipient,
  type GcashReceiptParse,
  type GcashRecipientComparison,
  parseGcashReceipt,
} from "../gcash-receipt.ts";
import type {
  BankReceiptVerificationEvidence,
  BankToGcashReceiptParse,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
} from "./bank-to-gcash.ts";
import {
  type BpiReceiptParse,
  type BpiReceiptVerificationEvidence,
  parseBpiToGcashReceipt,
  verifyBpiToGcashReceipt,
} from "./bpi.ts";
import {
  parseGotymeToGcashReceipt,
  verifyGotymeToGcashReceipt,
} from "./gotyme.ts";
import {
  parseMaribankToGcashReceipt,
  verifyMaribankToGcashReceipt,
} from "./maribank.ts";
import {
  type MayaReceiptParse,
  type MayaReceiptVerificationEvidence,
  parseMayaToGcashReceipt,
  verifyMayaToGcashReceipt,
} from "./maya.ts";

export type DedicatedReceiptProvider =
  | "gcash"
  | "bdopay"
  | "maya"
  | "bpi"
  | "gotyme"
  | "maribank";

export type GcashProviderReceiptParse = {
  provider: "gcash";
  destinationProvider: "gcash";
  parserVersion: "gcash_v1";
  receipt: GcashReceiptParse;
};

export type BankProviderReceiptParse = {
  provider: "gotyme" | "maribank";
  destinationProvider: "gcash";
  parserVersion: "gotyme_to_gcash_v1" | "maribank_to_gcash_v1";
  receipt: BankToGcashReceiptParse;
};

export type BpiProviderReceiptParse = {
  provider: "bpi";
  destinationProvider: "gcash";
  parserVersion: "bpi_to_gcash_v1";
  receipt: BpiReceiptParse;
};

export type BdoPayProviderReceiptParse = {
  provider: "bdopay";
  destinationProvider: "gcash";
  parserVersion: "bdopay_to_gcash_v1";
  receipt: BdoPayReceiptParse;
};

export type MayaProviderReceiptParse = {
  provider: "maya";
  destinationProvider: "gcash";
  parserVersion: "maya_to_gcash_v1";
  receipt: MayaReceiptParse;
};

export type ProviderReceiptParse =
  | GcashProviderReceiptParse
  | BdoPayProviderReceiptParse
  | MayaProviderReceiptParse
  | BpiProviderReceiptParse
  | BankProviderReceiptParse;

export type GcashReceiptVerificationEvidence = {
  provider: "gcash";
  destinationProvider: "gcash";
  parserVersion: "gcash_v1";
  flags: string[];
  recipientComparison: GcashRecipientComparison;
  dedupeKeys: ReceiptDedupeKey[];
};

export type ProviderReceiptVerificationEvidence =
  | GcashReceiptVerificationEvidence
  | BdoPayReceiptVerificationEvidence
  | MayaReceiptVerificationEvidence
  | BpiReceiptVerificationEvidence
  | BankReceiptVerificationEvidence;

export type { ReceiptVerificationContext } from "./bank-to-gcash.ts";

export class UnsupportedReceiptProviderError extends Error {
  constructor(provider: string) {
    super(`Unsupported receipt provider: ${provider || "(empty)"}`);
    this.name = "UnsupportedReceiptProviderError";
  }
}

export function isDedicatedReceiptProvider(
  provider: string,
): provider is DedicatedReceiptProvider {
  return provider === "gcash" || provider === "bdopay" ||
    provider === "maya" || provider === "gotyme" || provider === "maribank" ||
    provider === "bpi";
}

export function parseProviderReceipt(
  provider: string,
  rawText: string,
  options: { typedReference?: string } = {},
): ProviderReceiptParse {
  switch (provider) {
    case "gcash":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "gcash_v1",
        receipt: parseGcashReceipt(rawText, options),
      };
    case "bdopay":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "bdopay_to_gcash_v1",
        receipt: parseBdoPayToGcashReceipt(rawText, options),
      };
    case "maya":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "maya_to_gcash_v1",
        receipt: parseMayaToGcashReceipt(rawText, options),
      };
    case "gotyme":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "gotyme_to_gcash_v1",
        receipt: parseGotymeToGcashReceipt(rawText, options),
      };
    case "bpi":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "bpi_to_gcash_v1",
        receipt: parseBpiToGcashReceipt(rawText, options),
      };
    case "maribank":
      return {
        provider,
        destinationProvider: "gcash",
        parserVersion: "maribank_to_gcash_v1",
        receipt: parseMaribankToGcashReceipt(rawText, options),
      };
    default:
      throw new UnsupportedReceiptProviderError(provider);
  }
}

function addUnique(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function verifyGcashReceipt(
  parsed: GcashProviderReceiptParse,
  context: ReceiptVerificationContext,
): GcashReceiptVerificationEvidence {
  const receipt = parsed.receipt;
  const flags: string[] = [];
  const recipientComparison = compareGcashRecipient(receipt.receiver, {
    phone: context.expectedRecipientNumber || "",
    name: context.expectedRecipientName || "",
  });
  const typedReference = String(context.typedReference || "").replace(
    /\D/g,
    "",
  );
  if (typedReference.length !== 13) addUnique(flags, "REF_FORMAT_INVALID");
  if (!receipt.reference.value) addUnique(flags, "REF_UNREADABLE");
  if (receipt.reference.typedMatch === "mismatch") {
    addUnique(flags, "REF_MISMATCH");
  }
  if (
    receipt.reference.value &&
    (receipt.reference.source !== "ref_label" ||
      receipt.reference.confidence !== "high")
  ) {
    addUnique(flags, "REF_LABEL_UNREADABLE");
  }

  if (!context.pricingAvailable || context.expectedAmount == null) {
    addUnique(flags, "PRICING_UNAVAILABLE");
  } else if (
    receipt.amount.amount == null || !receipt.amount.reliable ||
    receipt.amount.ambiguous
  ) {
    addUnique(flags, "AMOUNT_UNREADABLE");
  } else if (receipt.amount.conflictingPrimaryAmounts) {
    addUnique(flags, "AMOUNT_REVIEW");
  } else if (!receipt.amount.matchingPrimaryAmountDisplays) {
    addUnique(flags, "AMOUNT_CONFIRMATION_UNREADABLE");
  } else if (
    Math.abs(receipt.amount.amount - context.expectedAmount) >
      context.amountTolerance
  ) {
    addUnique(flags, "AMOUNT_MISMATCH");
  }

  if (!receipt.timestamp.date) addUnique(flags, "DATE_UNREADABLE");
  else if (
    context.bookingStartedDate &&
    receipt.timestamp.date !== context.bookingStartedDate
  ) {
    addUnique(flags, "DATE_NOT_TODAY");
  }
  const bookingStartedAt = context.bookingStartedAt
    ? new Date(context.bookingStartedAt)
    : null;
  const receiptInstant = receipt.timestamp.instant
    ? new Date(receipt.timestamp.instant)
    : null;
  if (
    !bookingStartedAt || Number.isNaN(bookingStartedAt.getTime()) ||
    !receiptInstant || Number.isNaN(receiptInstant.getTime())
  ) {
    addUnique(flags, "TIME_UNREADABLE");
  } else {
    const ageMinutes = (receiptInstant.getTime() - bookingStartedAt.getTime()) /
      60000;
    if (ageMinutes < -context.earlyToleranceMinutes) {
      addUnique(flags, "TIME_FUTURE");
    } else if (ageMinutes > context.paymentWindowMinutes) {
      addUnique(flags, "TIME_EXPIRED");
    }
  }

  if (
    receipt.indicators.classification !== "gcash" ||
    !receipt.indicators.sentViaGcash ||
    !receipt.indicators.totalAmountSent ||
    !receipt.indicators.referenceLabel ||
    !receipt.indicators.amountLabel
  ) {
    addUnique(flags, "GCASH_RECEIPT_UNREADABLE");
  }
  if (recipientComparison.phone === "mismatch") {
    addUnique(flags, "WRONG_GCASH_NUMBER");
  } else if (recipientComparison.phone !== "exact") {
    addUnique(flags, "NUMBER_UNREADABLE");
  }
  if (recipientComparison.name === "mismatch") {
    addUnique(flags, "RECEIVER_NAME_MISMATCH");
  } else if (
    context.expectedRecipientName &&
    recipientComparison.phone !== "exact" &&
    recipientComparison.name !== "exact" &&
    recipientComparison.name !== "masked_compatible"
  ) {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  }

  const dedupeKeys: ReceiptDedupeKey[] = receipt.reference.value
    ? [{
      key: receipt.reference.value,
      providerKey: "gcash",
      duplicateFlag: "DUPLICATE_REF",
    }]
    : [];
  return {
    provider: "gcash",
    destinationProvider: "gcash",
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    dedupeKeys,
  };
}

export function verifyProviderReceipt(
  parsed: ProviderReceiptParse,
  context: ReceiptVerificationContext,
): ProviderReceiptVerificationEvidence {
  switch (parsed.provider) {
    case "gcash":
      return verifyGcashReceipt(parsed, context);
    case "bdopay":
      return verifyBdoPayToGcashReceipt(parsed.receipt, context);
    case "maya":
      return verifyMayaToGcashReceipt(parsed.receipt, context);
    case "gotyme":
      return verifyGotymeToGcashReceipt(
        parsed.receipt as BankToGcashReceiptParse & { provider: "gotyme" },
        context,
      );
    case "bpi":
      return verifyBpiToGcashReceipt(parsed.receipt, context);
    case "maribank":
      return verifyMaribankToGcashReceipt(
        parsed.receipt as BankToGcashReceiptParse & { provider: "maribank" },
        context,
      );
  }
}
