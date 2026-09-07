import {
  compareGcashMaskedName,
  type GcashNameComparison,
  normalizeGcashMobile,
} from "../gcash-receipt.ts";
import {
  extractReceiptAmount,
  type ReceiptAmountExtraction,
} from "../receipt-amount.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
  TypedReferenceMatch,
} from "./bank-to-gcash.ts";

export type MayaReferenceField = {
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
  typedMatch: TypedReferenceMatch;
};

export type MayaRailReferenceField = {
  scheme: "instapay";
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
};

export type MayaTransferFeeField = {
  amount: number | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
};

export type MayaReceiptRecipient = {
  nameRaw: string | null;
  nameNormalized: string | null;
  accountRaw: string | null;
  phoneNormalized: string | null;
  nameLineIndex: number | null;
  accountLineIndex: number | null;
};

export type MayaCompetingProvider =
  | "gcash"
  | "bdopay"
  | "bpi"
  | "gotyme"
  | "maribank";

export type MayaReceiptParse = {
  provider: "maya";
  destinationProvider: "gcash";
  parserVersion: "maya_to_gcash_v1";
  reference: MayaReferenceField;
  railReference: MayaRailReferenceField;
  amount: ReceiptAmountExtraction;
  transferFee: MayaTransferFeeField;
  timestamp: BankReceiptTimestamp;
  recipient: MayaReceiptRecipient;
  indicators: {
    providerBrand: boolean;
    competingProviderBrand: MayaCompetingProvider | null;
    sentMoneyVia: boolean;
    completionScreen: boolean;
    failureStatus: boolean;
    pendingStatus: boolean;
    destinationGcash: boolean;
    instaPay: boolean;
    referenceLabel: boolean;
    railReferenceLabel: boolean;
    accountTypeLabel: boolean;
    accountNumberLabel: boolean;
    accountNameLabel: boolean;
    transferFeeLabel: boolean;
  };
  issues: string[];
};

export type MayaRecipientComparison = {
  phone: "exact" | "mismatch" | "missing" | "not_configured";
  name: GcashNameComparison;
};

export type MayaReceiptVerificationEvidence = {
  provider: "maya";
  destinationProvider: "gcash";
  parserVersion: "maya_to_gcash_v1";
  flags: string[];
  recipientComparison: MayaRecipientComparison;
  dedupeKeys: ReceiptDedupeKey[];
};

type IndexedValue = {
  raw: string;
  lineIndex: number;
};

const MAYA_REFERENCE_LABEL_RE =
  /^reference\s*(?:id|no\.?|number|#)\b\s*[:#\-–—]?\s*(.*)$/i;
const MAYA_RAIL_REFERENCE_LABEL_RE =
  /^insta\s*pay\s*(?:ref(?:erence)?)(?:\s*(?:id|no\.?|number|#))?\.?\s*[:#\-–—]?\s*(.*)$/i;
const ACCOUNT_TYPE_LABEL_RE = /^account\s*type\b\s*[:#\-–—]?\s*(.*)$/i;
const ACCOUNT_NUMBER_LABEL_RE =
  /^account\s*(?:number|no\.?|#)\b\s*[:#\-–—]?\s*(.*)$/i;
const ACCOUNT_NAME_LABEL_RE = /^account\s*name\b\s*[:#\-–—]?\s*(.*)$/i;
const TRANSFER_FEE_LABEL_RE =
  /^(?:transfer|service)\s*fee\b\s*[:#\-–—]?\s*(.*)$/i;
const DESTINATION_RE = /\bg-?xchange\s*(?:,|\.)?\s*inc\.?\s*\/\s*gcash\b/i;
const MONEY_RE = /(?:PHP|₱|P)\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/i;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function linesOf(rawText: string): string[] {
  return String(rawText || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function normalizeMayaReference(value: string): string {
  return String(value || "").normalize("NFKC").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
}

function validMayaReference(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(normalizeMayaReference(value));
}

function typedReferenceMatch(
  observed: string | null,
  typedReference: string,
): TypedReferenceMatch {
  const typed = normalizeMayaReference(typedReference);
  if (!typed) return "not_provided";
  if (!validMayaReference(typed)) return "typed_invalid";
  if (!observed) return "ocr_missing";
  return observed === typed ? "match" : "mismatch";
}

function uniqueIndexedValues(values: IndexedValue[]): IndexedValue[] {
  return [
    ...new Map(values.map((item) => [item.raw.toUpperCase(), item])).values(),
  ];
}

function mayaReferenceTokens(raw: string): string[] {
  const text = String(raw || "").trim();
  const matches = [
    ...text.matchAll(
      /(?<![A-Z0-9])([A-Z0-9]{4}(?:[\s-]+[A-Z0-9]{4}){2})(?![A-Z0-9])/gi,
    ),
    ...text.matchAll(/(?<![A-Z0-9])([A-Z0-9]{12})(?![A-Z0-9])/gi),
  ].map((match) => match[1]).filter(validMayaReference);
  return [...new Set(matches.map((value) => normalizeMayaReference(value)))];
}

function referenceSearchBlock(
  lines: string[],
  labelIndexes: number[],
): number[] {
  if (!labelIndexes.length) return [];
  const start = Math.min(...labelIndexes);
  const end = Math.min(lines.length - 1, Math.max(...labelIndexes) + 4);
  const indexes: number[] = [];
  for (let index = start; index <= end; index++) indexes.push(index);
  return indexes;
}

function parseReference(
  lines: string[],
  typedReference: string,
): { field: MayaReferenceField; ambiguous: boolean } {
  const referenceLabels = lines.map((line, index) =>
    MAYA_REFERENCE_LABEL_RE.test(line) ? index : -1
  ).filter((index) => index >= 0);
  const railLabels = lines.map((line, index) =>
    MAYA_RAIL_REFERENCE_LABEL_RE.test(line) ? index : -1
  ).filter((index) => index >= 0);
  const candidates: IndexedValue[] = [];

  for (const lineIndex of referenceLabels) {
    const match = lines[lineIndex].match(MAYA_REFERENCE_LABEL_RE);
    for (const inline of mayaReferenceTokens(match?.[1] || "")) {
      candidates.push({ raw: inline, lineIndex });
    }
  }

  for (
    const lineIndex of referenceSearchBlock(lines, [
      ...referenceLabels,
      ...railLabels,
    ])
  ) {
    if (
      MAYA_REFERENCE_LABEL_RE.test(lines[lineIndex]) ||
      MAYA_RAIL_REFERENCE_LABEL_RE.test(lines[lineIndex])
    ) continue;
    for (const raw of mayaReferenceTokens(lines[lineIndex])) {
      candidates.push({ raw, lineIndex });
    }
  }

  const unique = [
    ...new Map(
      uniqueIndexedValues(candidates).map((item) => [
        normalizeMayaReference(item.raw),
        item,
      ]),
    ).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  const value = selected ? normalizeMayaReference(selected.raw) : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      value,
      raw: selected?.raw || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected && referenceLabels.length === 1 ? "high" : "low",
      typedMatch: typedReferenceMatch(value, typedReference),
    },
  };
}

function railReferenceTokens(raw: string): string[] {
  const text = String(raw || "").trim();
  return [
    ...new Set(
      [...text.matchAll(/(?<!\d)(\d{4,20})(?!\d)/g)].map((match) => match[1]),
    ),
  ];
}

function parseRailReference(lines: string[]): {
  field: MayaRailReferenceField;
  ambiguous: boolean;
} {
  const referenceLabels = lines.map((line, index) =>
    MAYA_REFERENCE_LABEL_RE.test(line) ? index : -1
  ).filter((index) => index >= 0);
  const railLabels = lines.map((line, index) =>
    MAYA_RAIL_REFERENCE_LABEL_RE.test(line) ? index : -1
  ).filter((index) => index >= 0);
  const candidates: IndexedValue[] = [];

  for (const lineIndex of railLabels) {
    const match = lines[lineIndex].match(MAYA_RAIL_REFERENCE_LABEL_RE);
    for (const inline of railReferenceTokens(match?.[1] || "")) {
      candidates.push({ raw: inline, lineIndex });
    }
  }

  for (
    const lineIndex of referenceSearchBlock(lines, [
      ...referenceLabels,
      ...railLabels,
    ])
  ) {
    if (
      MAYA_REFERENCE_LABEL_RE.test(lines[lineIndex]) ||
      MAYA_RAIL_REFERENCE_LABEL_RE.test(lines[lineIndex]) ||
      mayaReferenceTokens(lines[lineIndex]).length > 0
    ) continue;
    for (const raw of railReferenceTokens(lines[lineIndex])) {
      candidates.push({ raw, lineIndex });
    }
  }

  const unique = [
    ...new Map(
      candidates.map((item) => [item.raw.replace(/\D/g, ""), item]),
    ).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      scheme: "instapay",
      value: selected ? selected.raw.replace(/\D/g, "") : null,
      raw: selected?.raw || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected && railLabels.length === 1 ? "high" : "low",
    },
  };
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function missingTimestamp(): BankReceiptTimestamp {
  return {
    raw: null,
    date: null,
    time24: null,
    zone: "Asia/Manila",
    instant: null,
    completeness: "missing",
    lineIndex: null,
  };
}

function invalidTimestamp(
  raw: string,
  lineIndex: number,
): BankReceiptTimestamp {
  return {
    raw,
    date: null,
    time24: null,
    zone: "Asia/Manila",
    instant: null,
    completeness: "invalid",
    lineIndex,
  };
}

function parseTimestamp(lines: string[]): BankReceiptTimestamp {
  const pattern =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\s*,?\s*(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*(\d{2}))?\s*(AM|PM)\b/i;
  const candidates: Array<{
    raw: string;
    lineIndex: number;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    meridiem: string;
  }> = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(pattern);
    if (!match) return;
    candidates.push({
      raw: match[0],
      lineIndex,
      year: Number(match[3]),
      month: MONTHS[match[1].toLowerCase()] || 0,
      day: Number(match[2]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] || 0),
      meridiem: match[7].toUpperCase(),
    });
  });
  if (!candidates.length) return missingTimestamp();

  const normalized = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    normalized.set(
      [
        candidate.year,
        candidate.month,
        candidate.day,
        candidate.hour,
        candidate.minute,
        candidate.second,
        candidate.meridiem,
      ].join(":"),
      candidate,
    );
  }
  if (normalized.size !== 1) {
    return invalidTimestamp(candidates[0].raw, candidates[0].lineIndex);
  }
  const selected = [...normalized.values()][0];
  if (
    !validDateParts(selected.year, selected.month, selected.day) ||
    selected.hour < 1 || selected.hour > 12 || selected.minute > 59 ||
    selected.second > 59
  ) {
    return invalidTimestamp(selected.raw, selected.lineIndex);
  }
  let hour = selected.hour;
  if (selected.meridiem === "AM" && hour === 12) hour = 0;
  if (selected.meridiem === "PM" && hour !== 12) hour += 12;
  const date = [
    selected.year.toString().padStart(4, "0"),
    selected.month.toString().padStart(2, "0"),
    selected.day.toString().padStart(2, "0"),
  ].join("-");
  const time24 = `${hour.toString().padStart(2, "0")}:${
    selected.minute.toString().padStart(2, "0")
  }`;
  const instant = new Date(
    `${date}T${time24}:${selected.second.toString().padStart(2, "0")}+08:00`,
  );
  return {
    raw: selected.raw,
    date,
    time24,
    zone: "Asia/Manila",
    instant: Number.isNaN(instant.getTime()) ? null : instant.toISOString(),
    completeness: Number.isNaN(instant.getTime()) ? "invalid" : "date_time",
    lineIndex: selected.lineIndex,
  };
}

function fieldBlockEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index++) {
    if (
      TRANSFER_FEE_LABEL_RE.test(lines[index]) ||
      MAYA_REFERENCE_LABEL_RE.test(lines[index]) ||
      MAYA_RAIL_REFERENCE_LABEL_RE.test(lines[index])
    ) return index;
  }
  return Math.min(lines.length, start + 12);
}

function inlineValues(
  lines: string[],
  pattern: RegExp,
): IndexedValue[] {
  const values: IndexedValue[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(pattern);
    const raw = String(match?.[1] || "").trim();
    if (raw) values.push({ raw, lineIndex });
  });
  return values;
}

function normalizeRecipientName(value: string): string | null {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9.*#•\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function looksLikeRecipientName(value: string): boolean {
  const text = String(value || "").trim();
  if (text.length < 2 || !/[A-Za-z]/.test(text)) return false;
  if (
    ACCOUNT_TYPE_LABEL_RE.test(text) || ACCOUNT_NUMBER_LABEL_RE.test(text) ||
    ACCOUNT_NAME_LABEL_RE.test(text) || DESTINATION_RE.test(text) ||
    normalizeGcashMobile(text) ||
    /\b(?:insta\s*pay|reference|transfer\s*fee|sent\s+money|payment|share|get\s+help)\b/i
      .test(text) ||
    MONEY_RE.test(text)
  ) return false;
  return true;
}

function strictGcashMobile(value: string): string | null {
  const text = String(value || "").trim();
  if (!/^(?:(?:\+?63)|0)?9(?:[\s-]*\d){9}$/.test(text)) return null;
  return normalizeGcashMobile(text);
}

function parseRecipient(lines: string[]): {
  recipient: MayaReceiptRecipient;
  destinationRaw: string | null;
  ambiguousDestination: boolean;
  ambiguousAccount: boolean;
  ambiguousName: boolean;
  invalidAccount: boolean;
  invalidName: boolean;
} {
  const labelIndexes = lines.map((line, index) =>
    ACCOUNT_TYPE_LABEL_RE.test(line) || ACCOUNT_NUMBER_LABEL_RE.test(line) ||
      ACCOUNT_NAME_LABEL_RE.test(line)
      ? index
      : -1
  ).filter((index) => index >= 0);
  if (!labelIndexes.length) {
    return {
      recipient: {
        nameRaw: null,
        nameNormalized: null,
        accountRaw: null,
        phoneNormalized: null,
        nameLineIndex: null,
        accountLineIndex: null,
      },
      destinationRaw: null,
      ambiguousDestination: false,
      ambiguousAccount: false,
      ambiguousName: false,
      invalidAccount: false,
      invalidName: false,
    };
  }
  const start = Math.min(...labelIndexes);
  const end = fieldBlockEnd(lines, Math.max(...labelIndexes));
  const blockIndexes = Array.from(
    { length: Math.max(0, end - start) },
    (_, offset) => start + offset,
  );

  // Keep explicit but invalid inline values. Otherwise a contradictory label
  // could be ignored and a later valid-looking value could silently win.
  const destinationCandidates = inlineValues(lines, ACCOUNT_TYPE_LABEL_RE);
  const accountCandidates = inlineValues(lines, ACCOUNT_NUMBER_LABEL_RE);
  const nameCandidates = inlineValues(lines, ACCOUNT_NAME_LABEL_RE);

  for (const lineIndex of blockIndexes) {
    const line = lines[lineIndex];
    if (DESTINATION_RE.test(line) && !ACCOUNT_TYPE_LABEL_RE.test(line)) {
      destinationCandidates.push({ raw: line, lineIndex });
    }
    const phone = strictGcashMobile(line);
    if (phone && !ACCOUNT_NUMBER_LABEL_RE.test(line)) {
      accountCandidates.push({ raw: line, lineIndex });
    }
    if (
      !ACCOUNT_TYPE_LABEL_RE.test(line) &&
      !ACCOUNT_NUMBER_LABEL_RE.test(line) &&
      !ACCOUNT_NAME_LABEL_RE.test(line) && looksLikeRecipientName(line)
    ) {
      nameCandidates.push({ raw: line, lineIndex });
    }
  }

  const destinations = uniqueIndexedValues(destinationCandidates);
  const accounts = [
    ...new Map(accountCandidates.map((item) => [
      strictGcashMobile(item.raw) || `invalid:${item.raw.toUpperCase()}`,
      item,
    ])).values(),
  ];
  const names = uniqueIndexedValues(nameCandidates);
  const destination = destinations.length === 1 &&
      DESTINATION_RE.test(destinations[0].raw)
    ? destinations[0]
    : null;
  const account = accounts.length === 1 && strictGcashMobile(accounts[0].raw)
    ? accounts[0]
    : null;
  const name = names.length === 1 && looksLikeRecipientName(names[0].raw)
    ? names[0]
    : null;
  return {
    recipient: {
      nameRaw: name?.raw || null,
      nameNormalized: name ? normalizeRecipientName(name.raw) : null,
      accountRaw: account?.raw || null,
      phoneNormalized: account ? strictGcashMobile(account.raw) : null,
      nameLineIndex: name?.lineIndex ?? null,
      accountLineIndex: account?.lineIndex ?? null,
    },
    destinationRaw: destination?.raw || null,
    ambiguousDestination: destinations.length > 1,
    ambiguousAccount: accounts.length > 1,
    ambiguousName: names.length > 1,
    invalidAccount: accounts.length === 1 &&
      !strictGcashMobile(accounts[0].raw),
    invalidName: names.length === 1 && !looksLikeRecipientName(names[0].raw),
  };
}

function parseTransferFee(lines: string[]): {
  field: MayaTransferFeeField;
  ambiguous: boolean;
} {
  const candidates: Array<IndexedValue & { amount: number }> = [];
  lines.forEach((line, lineIndex) => {
    const label = line.match(TRANSFER_FEE_LABEL_RE);
    if (!label) return;
    const nearby = [String(label[1] || ""), String(lines[lineIndex + 1] || "")];
    for (const raw of nearby) {
      const match = raw.match(MONEY_RE);
      if (!match) continue;
      const amount = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 0) continue;
      candidates.push({ raw: match[0], amount, lineIndex });
      break;
    }
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.amount, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      amount: selected?.amount ?? null,
      raw: selected?.raw || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected ? "high" : "low",
    },
  };
}

function competingProvider(text: string): MayaCompetingProvider | null {
  const candidates: Array<[MayaCompetingProvider, RegExp]> = [
    ["gcash", /\bsent\s+(?:money\s+)?via\s+gcash\b|\btotal\s+amount\s+sent\b/i],
    ["bdopay", /\bbdo\s*pay\b|\bBN[\s-]*\d{8}[\s-]*\d{8}\b/i],
    ["bpi", /\bsent\s+via\s+bpi\b|\bbpi\s+(?:online|mobile)\b/i],
    ["gotyme", /\bgo\s*tyme\b|\bgotyme\b/i],
    ["maribank", /\bmari\s*bank\b|\bmaribank\b/i],
  ];
  return candidates.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function addUnique(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function compareMayaMaskedName(
  observedRaw: string | null,
  expectedName: string,
): GcashNameComparison {
  const raw = String(observedRaw || "").trim();
  if (!raw) return compareGcashMaskedName(raw, expectedName);

  // Maya sometimes removes the horizontal gap between adjacent masked name
  // tokens in OCR (for example, "J..KE....H M."). Try every plausible token
  // boundary after a mask run and keep only a result that remains compatible
  // with the independently configured full recipient name.
  const boundaryIndexes = [...raw.matchAll(/[.*#•]{2,}(?=[A-Za-z])/g)]
    .map((match) => (match.index || 0) + match[0].length)
    .slice(0, 6);
  const variants = new Set([raw]);
  for (let mask = 1; mask < 2 ** boundaryIndexes.length; mask++) {
    let variant = raw;
    for (let index = boundaryIndexes.length - 1; index >= 0; index--) {
      if ((mask & (1 << index)) === 0) continue;
      const at = boundaryIndexes[index];
      variant = `${variant.slice(0, at)} ${variant.slice(at)}`;
    }
    variants.add(variant);
  }
  const rank: Record<GcashNameComparison, number> = {
    exact: 6,
    masked_compatible: 5,
    inconclusive: 4,
    mismatch: 3,
    missing: 2,
    not_configured: 1,
  };
  return [...variants]
    .map((variant) => compareGcashMaskedName(variant, expectedName))
    .sort((left, right) => rank[right] - rank[left])[0];
}

function compareRecipient(
  recipient: MayaReceiptRecipient,
  expectedNumber: string,
  expectedName: string,
): MayaRecipientComparison {
  const expectedPhone = normalizeGcashMobile(expectedNumber);
  let phone: MayaRecipientComparison["phone"] = "not_configured";
  if (expectedPhone) {
    phone = recipient.phoneNormalized
      ? (recipient.phoneNormalized === expectedPhone ? "exact" : "mismatch")
      : "missing";
  }
  return {
    phone,
    name: compareMayaMaskedName(recipient.nameRaw, expectedName),
  };
}

export function parseMayaToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): MayaReceiptParse {
  const lines = linesOf(rawText);
  const text = lines.join("\n");
  const reference = parseReference(lines, options.typedReference || "");
  const railReference = parseRailReference(lines);
  const amount = extractReceiptAmount(text, { provider: "maya" });
  const transferFee = parseTransferFee(lines);
  const timestamp = parseTimestamp(lines);
  const parsedRecipient = parseRecipient(lines);
  const failureStatus =
    /\b(?:failed|failure|declined|cancelled|canceled|unsuccessful|reversed|refunded)\b/i
      .test(text);
  const pendingStatus = /\b(?:pending|processing|in\s+progress|scheduled)\b/i
    .test(text);
  const sentMoneyVia = /\bsent\s+money\s+via\b/i.test(text);
  const issues: string[] = [];
  if (reference.ambiguous) issues.push("AMBIGUOUS_REFERENCE");
  if (!reference.field.value) issues.push("REFERENCE_MISSING");
  if (railReference.ambiguous) issues.push("AMBIGUOUS_INSTAPAY_REFERENCE");
  if (!railReference.field.value) issues.push("INSTAPAY_REFERENCE_MISSING");
  if (amount.amount == null) issues.push("AMOUNT_MISSING");
  if (amount.ambiguous) issues.push("AMBIGUOUS_AMOUNT");
  if (!amount.evidence.includes("maya_sent_money_context")) {
    issues.push("PRINCIPAL_AMOUNT_CONTEXT_MISSING");
  }
  if (transferFee.ambiguous) issues.push("AMBIGUOUS_TRANSFER_FEE");
  if (timestamp.completeness === "missing") issues.push("TIMESTAMP_MISSING");
  if (timestamp.completeness === "invalid") issues.push("TIMESTAMP_INVALID");
  if (parsedRecipient.ambiguousDestination) {
    issues.push("AMBIGUOUS_DESTINATION");
  }
  if (parsedRecipient.ambiguousAccount) issues.push("AMBIGUOUS_ACCOUNT_NUMBER");
  if (parsedRecipient.ambiguousName) issues.push("AMBIGUOUS_ACCOUNT_NAME");
  if (parsedRecipient.invalidAccount) issues.push("INVALID_ACCOUNT_NUMBER");
  if (parsedRecipient.invalidName) issues.push("INVALID_ACCOUNT_NAME");
  if (!parsedRecipient.destinationRaw) issues.push("DESTINATION_MISSING");
  if (!parsedRecipient.recipient.accountRaw) {
    issues.push("ACCOUNT_NUMBER_MISSING");
  }
  if (!parsedRecipient.recipient.nameRaw) issues.push("ACCOUNT_NAME_MISSING");

  return {
    provider: "maya",
    destinationProvider: "gcash",
    parserVersion: "maya_to_gcash_v1",
    reference: reference.field,
    railReference: railReference.field,
    amount,
    transferFee: transferFee.field,
    timestamp,
    recipient: parsedRecipient.recipient,
    indicators: {
      providerBrand: /\bmaya\b/i.test(text),
      competingProviderBrand: competingProvider(text),
      sentMoneyVia,
      // This identifies Maya's completed receipt/detail screen. It validates
      // the uploaded receipt; it does not assert downstream bank settlement.
      completionScreen: sentMoneyVia && !failureStatus && !pendingStatus,
      failureStatus,
      pendingStatus,
      destinationGcash: Boolean(parsedRecipient.destinationRaw),
      instaPay: /\binsta\s*pay\b/i.test(text),
      referenceLabel: lines.some((line) => MAYA_REFERENCE_LABEL_RE.test(line)),
      railReferenceLabel: lines.some((line) =>
        MAYA_RAIL_REFERENCE_LABEL_RE.test(line)
      ),
      accountTypeLabel: lines.some((line) => ACCOUNT_TYPE_LABEL_RE.test(line)),
      accountNumberLabel: lines.some((line) =>
        ACCOUNT_NUMBER_LABEL_RE.test(line)
      ),
      accountNameLabel: lines.some((line) => ACCOUNT_NAME_LABEL_RE.test(line)),
      transferFeeLabel: lines.some((line) => TRANSFER_FEE_LABEL_RE.test(line)),
    },
    issues,
  };
}

export function verifyMayaToGcashReceipt(
  parsed: MayaReceiptParse,
  context: ReceiptVerificationContext,
): MayaReceiptVerificationEvidence {
  const flags: string[] = [];
  const recipientComparison = compareRecipient(
    parsed.recipient,
    context.expectedRecipientNumber || "",
    context.expectedRecipientName || "",
  );

  if (!parsed.indicators.providerBrand) addUnique(flags, "MAYA_UNREADABLE");
  if (parsed.indicators.competingProviderBrand) {
    addUnique(flags, "METHOD_MISMATCH");
  }
  if (parsed.indicators.failureStatus) {
    addUnique(flags, "TRANSFER_STATUS_INVALID");
  }
  if (parsed.indicators.pendingStatus) addUnique(flags, "TRANSFER_PENDING");
  if (!parsed.indicators.sentMoneyVia || !parsed.indicators.completionScreen) {
    addUnique(flags, "TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.instaPay) {
    addUnique(flags, "INSTAPAY_QRPH_UNREADABLE");
  }
  if (
    !parsed.indicators.destinationGcash || !parsed.indicators.accountTypeLabel
  ) {
    addUnique(flags, "GXI_DESTINATION_UNREADABLE");
  }
  if (!parsed.indicators.accountNumberLabel) {
    addUnique(flags, "NUMBER_UNREADABLE");
  }
  if (!parsed.indicators.accountNameLabel) {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  }
  if (
    !parsed.indicators.referenceLabel ||
    parsed.reference.confidence !== "high"
  ) {
    addUnique(flags, "REF_UNREADABLE");
  }
  if (
    !parsed.indicators.railReferenceLabel || !parsed.railReference.value ||
    parsed.railReference.confidence !== "high"
  ) {
    addUnique(flags, "INSTAPAY_REF_UNREADABLE");
  }

  if (parsed.reference.typedMatch === "typed_invalid") {
    addUnique(flags, "REF_FORMAT_INVALID");
  }
  if (!parsed.reference.value) addUnique(flags, "REF_UNREADABLE");
  if (parsed.reference.typedMatch === "mismatch") {
    addUnique(flags, "REF_MISMATCH");
  }
  if (parsed.reference.typedMatch === "ocr_missing") {
    addUnique(flags, "REF_UNREADABLE");
  }

  if (!context.pricingAvailable || context.expectedAmount == null) {
    addUnique(flags, "PRICING_UNAVAILABLE");
  } else if (
    parsed.amount.amount == null || !parsed.amount.reliable ||
    parsed.amount.ambiguous ||
    !parsed.amount.evidence.includes("maya_sent_money_context")
  ) {
    addUnique(flags, "AMOUNT_UNREADABLE");
  } else if (
    Math.abs(parsed.amount.amount - context.expectedAmount) >
      context.amountTolerance
  ) {
    addUnique(flags, "AMOUNT_MISMATCH");
  }

  if (!parsed.timestamp.date) addUnique(flags, "DATE_UNREADABLE");
  else if (
    context.bookingStartedDate &&
    parsed.timestamp.date !== context.bookingStartedDate
  ) {
    addUnique(flags, "DATE_NOT_TODAY");
  }
  const bookingStartedAt = context.bookingStartedAt
    ? new Date(context.bookingStartedAt)
    : null;
  const receiptInstant = parsed.timestamp.instant
    ? new Date(parsed.timestamp.instant)
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

  if (!context.expectedRecipientNumber || !context.expectedRecipientName) {
    addUnique(flags, "MERCHANT_CONFIG_MISSING");
  }
  if (recipientComparison.phone === "mismatch") {
    addUnique(flags, "WRONG_GCASH_NUMBER");
  } else if (recipientComparison.phone !== "exact") {
    addUnique(flags, "NUMBER_UNREADABLE");
  }
  if (recipientComparison.name === "mismatch") {
    addUnique(flags, "RECEIVER_NAME_MISMATCH");
  } else if (
    recipientComparison.name !== "exact" &&
    recipientComparison.name !== "masked_compatible"
  ) {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  }

  const dedupeKeys: ReceiptDedupeKey[] = [];
  if (parsed.reference.value) {
    dedupeKeys.push({
      key: `maya:${parsed.reference.value}`,
      providerKey: "maya",
      duplicateFlag: "DUPLICATE_REF",
    });
  }
  if (parsed.railReference.value) {
    dedupeKeys.push({
      key: `maya_instapay:${parsed.railReference.value}`,
      providerKey: "maya_instapay",
      duplicateFlag: "DUPLICATE_INSTAPAY_REF",
    });
  }
  return {
    provider: "maya",
    destinationProvider: "gcash",
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    dedupeKeys,
  };
}
