/**
 * Pure, tenant-scoped receipt groundwork. No network, persistence, or finalizer.
 * Native Maya/BDO Pay/BPI/PNB layouts are UNVALIDATED and always require review.
 * Synthetic fixtures demonstrate required evidence; they do not validate a bank UI.
 */
export const TARGET_TENANT = Object.freeze({
  id: "f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a",
  slug: "pickle-street-tugbok",
});

export const METHODS = [
  "gcash",
  "maya",
  "bdo_pay",
  "bpi",
  "gotyme",
  "pnb",
] as const;
export type Method = typeof METHODS[number];
export type Context = {
  /** Every field must come from authenticated server-side booking/method records. */
  tenantId: string;
  tenantSlug: string;
  expectedAmountMinor: number;
  currency: string;
  recipientName: string;
  recipientAccount: string;
  submittedReference: string;
  bookingStartedAt: string;
  timezone: string;
  methodActive: boolean;
  bookingApprovalMode: "automatic" | "manual";
  ocrConfidence: number | null;
};

type Profile = {
  method: Method;
  version: string;
  nativeLayout: "deployed_guarded" | "unvalidated";
  recipientHeaders: RegExp;
  referenceLabels: RegExp;
  referencePattern: RegExp;
};

const GENERIC_NATIVE_REFERENCE = /^[A-Z0-9][A-Z0-9-]{5,63}$/;
const REFERENCE_LABEL =
  /^(?:reference(?:\s*(?:no\.?|number|id))?|ref\.?\s*no\.?|transaction\s+reference(?:\s*(?:no\.?|number))?)\s*[:#]?\s*(.*)$/i;
const DESTINATION_HEADER =
  /^(?:destination\s+account|recipient\s+details)\s*:?(.*)$/i;
const PROFILES: Readonly<Record<Method, Profile>> = Object.freeze({
  gcash: {
    method: "gcash",
    version: "gcash_deployed_strict_guard_v1",
    nativeLayout: "deployed_guarded",
    recipientHeaders:
      /^(?:destination\s+account|recipient\s+details|receiver)\s*:?(.*)$/i,
    referenceLabels: REFERENCE_LABEL,
    referencePattern: /^\d{13}$/,
  },
  maya: {
    method: "maya",
    version: "maya_native_candidate_v0",
    nativeLayout: "unvalidated",
    recipientHeaders: DESTINATION_HEADER,
    referenceLabels: REFERENCE_LABEL,
    referencePattern: GENERIC_NATIVE_REFERENCE,
  },
  bdo_pay: {
    method: "bdo_pay",
    version: "bdo_pay_native_candidate_v0",
    nativeLayout: "unvalidated",
    recipientHeaders: DESTINATION_HEADER,
    referenceLabels: REFERENCE_LABEL,
    referencePattern: GENERIC_NATIVE_REFERENCE,
  },
  bpi: {
    method: "bpi",
    version: "bpi_native_candidate_v0",
    nativeLayout: "unvalidated",
    recipientHeaders: DESTINATION_HEADER,
    referenceLabels:
      /^(?:confirmation\s+(?:no\.?|number)|reference(?:\s*(?:no\.?|number))?)\s*[:#]?\s*(.*)$/i,
    referencePattern: GENERIC_NATIVE_REFERENCE,
  },
  gotyme: {
    method: "gotyme",
    version: "gotyme_deployed_strict_guard_v1",
    nativeLayout: "deployed_guarded",
    recipientHeaders: DESTINATION_HEADER,
    referenceLabels: REFERENCE_LABEL,
    referencePattern: GENERIC_NATIVE_REFERENCE,
  },
  pnb: {
    method: "pnb",
    version: "pnb_native_candidate_v0",
    nativeLayout: "unvalidated",
    recipientHeaders: DESTINATION_HEADER,
    referenceLabels: REFERENCE_LABEL,
    referencePattern: GENERIC_NATIVE_REFERENCE,
  },
});

const BANK_ALIASES: ReadonlyArray<readonly [Method, RegExp]> = [
  ["gcash", /^(?:g\s*cash|g[ -]?xchange(?:\s*,?\s*inc\.?)?)$/i],
  ["maya", /^(?:maya(?:\s+bank(?:\s*,?\s*inc\.?)?)?|paymaya)$/i],
  ["bdo_pay", /^(?:bdo\s*pay|bdo(?:\s+unibank)?|banco\s+de\s+oro)$/i],
  ["bpi", /^(?:bpi|bank\s+of\s+the\s+philippine\s+islands)$/i],
  ["gotyme", /^(?:go\s*tyme\s+bank(?:\s+corporation)?)$/i],
  ["pnb", /^(?:pnb|philippine\s+national\s+bank)$/i],
];

export type ReceiptCandidate = {
  method: Method;
  parserVersion: string;
  layoutValidation: Profile["nativeLayout"];
  flags: string[];
  evidence: {
    destinationMethod: Method | null;
    recipientName: string | null;
    recipientAccount: string | null;
    amountMinor: number | null;
    currency: "PHP" | null;
    primaryReference: string | null;
    railReference: string | null;
    receiptAt: string | null;
    successful: boolean;
  };
};

export type Decision = {
  method: Method;
  parserVersion: string;
  status: "auto_approval_candidate" | "manual_review";
  /** A candidate still needs tenant-bound duplicate checks and atomic finalization. */
  autoApprove: boolean;
  mandatoryEvidenceComplete: boolean;
  flags: string[];
  evidence: ReceiptCandidate["evidence"];
};

export function canonicalMethod(input: unknown): Method | null {
  if (typeof input !== "string") return null;
  const method = input.trim().toLowerCase();
  return METHODS.includes(method as Method) ? method as Method : null;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}
function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}
function normalizeAccount(value: string, method: Method): string | null {
  // Full exposed accounts only. Masked or alphanumeric destination identifiers require review.
  if (!/^[+\d\s-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, "");
  if (method === "gcash") {
    if (/^639\d{9}$/.test(digits)) digits = "0" + digits.slice(2);
    if (!/^09\d{9}$/.test(digits)) return null;
  } else if (!/^\d{6,20}$/.test(digits)) return null;
  return digits;
}

function singleValue(
  values: string[],
  missing: string,
  ambiguous: string,
  flags: string[],
): string | null {
  const unique = distinct(values.map((value) => value.trim()).filter(Boolean));
  if (!unique.length) {
    flags.push(missing);
    return null;
  }
  if (unique.length !== 1) {
    flags.push(ambiguous);
    return null;
  }
  return unique[0];
}

const SECTION_END =
  /^(?:source|sender|originating)\s+account\b|^(?:status|reference|ref\.?\s+no|transaction|confirmation|insta\s*pay|amount|transfer\s+amount|total\s+amount|fee|date|time|sent\s+via)\b/i;
function destinationBlock(
  lines: string[],
  profile: Profile,
  flags: string[],
): string[] {
  const starts = lines.flatMap((line, i) =>
    profile.recipientHeaders.test(line) ? [i] : []
  );
  if (starts.length !== 1) {
    flags.push(
      starts.length
        ? "AMBIGUOUS_DESTINATION_BLOCK"
        : "DESTINATION_BLOCK_UNREADABLE",
    );
    return [];
  }
  const start = starts[0];
  const block: string[] = [];
  const inline = profile.recipientHeaders.exec(lines[start])?.[1]?.trim();
  if (inline) block.push(inline);
  for (let i = start + 1; i < lines.length && i <= start + 8; i++) {
    if (SECTION_END.test(lines[i])) break;
    if (lines[i]) block.push(lines[i]);
  }
  return block;
}

function labeledValues(lines: string[], label: RegExp): string[] {
  return lines.flatMap((line, i) => {
    const match = label.exec(line);
    if (!match) return [];
    const value = match[1]?.trim() || lines[i + 1]?.trim() || "";
    return value ? [value] : [];
  });
}

function extractDestination(
  lines: string[],
  profile: Profile,
  flags: string[],
) {
  const block = destinationBlock(lines, profile, flags);
  const providerLines = block.map((line) =>
    line.replace(/^(?:destination\s+)?bank\s*:\s*/i, "").trim()
  );
  const providers = distinct(
    providerLines.flatMap((line) =>
      BANK_ALIASES.flatMap(([method, re]) => re.test(line) ? [method] : [])
    ),
  );
  const destinationMethod = providers.length === 1 ? providers[0] : null;
  if (providers.length > 1) flags.push("AMBIGUOUS_DESTINATION_METHOD");
  else if (!destinationMethod) flags.push("DESTINATION_METHOD_UNREADABLE");
  else if (destinationMethod !== profile.method) {
    flags.push("WRONG_DESTINATION_METHOD");
  }
  const unknownLabeledBank = block.some((line) =>
    /^(?:destination\s+)?bank\s*:/i.test(line) &&
    !BANK_ALIASES.some(([, re]) =>
      re.test(line.replace(/^(?:destination\s+)?bank\s*:\s*/i, "").trim())
    )
  );
  if (unknownLabeledBank) flags.push("UNKNOWN_DESTINATION_BANK");

  const names = labeledValues(
    block,
    /^(?:account\s+name|recipient\s+name|receiver\s+name|name)\s*:\s*(.*)$/i,
  );
  const accounts = labeledValues(
    block,
    /^(?:account\s+(?:number|no\.?)|mobile\s+(?:number|no\.?)|account)\s*:\s*(.*)$/i,
  );
  // Verified GoTyme destination layouts also contain unlabelled name/account lines.
  if (profile.method === "gotyme") {
    for (const line of block) {
      if (!line.includes(":") && /^\d[\d\s-]{5,30}$/.test(line)) {
        accounts.push(line);
      } else if (
        !line.includes(":") && /^[\p{L}][\p{L}\s.'-]{3,100}$/u.test(line) &&
        !BANK_ALIASES.some(([, re]) => re.test(line))
      ) names.push(line);
    }
  }
  const recipientName = singleValue(
    names.map(normalizeName),
    "RECIPIENT_NAME_UNREADABLE",
    "AMBIGUOUS_RECIPIENT_NAME",
    flags,
  );
  const normalizedAccounts = accounts.map((value) =>
    normalizeAccount(value, profile.method)
  );
  if (normalizedAccounts.some((value) => value === null)) {
    flags.push("RECIPIENT_ACCOUNT_NOT_FULL");
  }
  const recipientAccount = singleValue(
    normalizedAccounts.filter((value): value is string => value !== null),
    "RECIPIENT_ACCOUNT_UNREADABLE",
    "AMBIGUOUS_RECIPIENT_ACCOUNT",
    flags,
  );
  return { destinationMethod, recipientName, recipientAccount };
}

function amountMinor(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,6}|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{2})?$/.test(value)) {
    return null;
  }
  const [whole, cents = "00"] = value.replace(/,/g, "").split(".");
  const minor = Number(whole) * 100 + Number(cents);
  return Number.isSafeInteger(minor) && minor > 0 && minor <= 1_000_000_000
    ? minor
    : null;
}

function extractAmount(lines: string[], flags: string[]) {
  const fields = labeledValues(
    lines,
    /^(?:amount|transfer\s+amount|amount\s+sent|total\s+amount\s+sent)\s*:\s*(.*)$/i,
  );
  const amounts: number[] = [];
  let php = false;
  for (const value of fields) {
    const match = /^(PHP|₱)\s*([\d,.]+)$/i.exec(value);
    if (!match) {
      flags.push("PRINCIPAL_CURRENCY_OR_AMOUNT_UNREADABLE");
      continue;
    }
    php = true;
    const parsed = amountMinor(match[2]);
    if (parsed === null) flags.push("PRINCIPAL_AMOUNT_INVALID");
    else amounts.push(parsed);
  }
  if (lines.some((line) => /\b(?:USD|EUR|SGD|AUD|JPY)\b|\$\s*\d/.test(line))) {
    flags.push("CONFLICTING_CURRENCY");
  }
  const unique = distinct(amounts);
  if (!unique.length) flags.push("AMOUNT_UNREADABLE");
  else if (unique.length !== 1) flags.push("AMBIGUOUS_PRINCIPAL_AMOUNT");
  if (!php) flags.push("PHP_CURRENCY_UNREADABLE");
  return {
    amountMinor: unique.length === 1 ? unique[0] : null,
    currency: php ? "PHP" as const : null,
  };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
function parseTimestamp(value: string): string | null {
  const numeric =
    /^(20\d{2})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i
      .exec(value);
  const named =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
      .exec(value);
  if (!numeric && !named) return null;
  const m = numeric ?? named!;
  const year = Number(numeric ? m[1] : m[3]);
  const month = numeric ? Number(m[2]) : MONTHS[m[1].toLowerCase()];
  const day = Number(numeric ? m[3] : m[2]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? "0");
  const meridiem = m[7]?.toUpperCase();
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (meridiem === "AM") hour %= 12;
  if (meridiem === "PM") hour = hour % 12 + 12;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  ) return null;
  return new Date(local.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function extractTimestamp(lines: string[], flags: string[]): string | null {
  const fields = labeledValues(
    lines,
    /^(?:date\s+and\s+time|transaction\s+(?:date\s+and\s+time|date)|date\/time)\s*:\s*(.*)$/i,
  );
  const parsed = fields.map(parseTimestamp);
  if (parsed.some((value) => value === null)) flags.push("TIMESTAMP_INVALID");
  return singleValue(
    parsed.filter((value): value is string => value !== null),
    "TIMESTAMP_UNREADABLE",
    "AMBIGUOUS_TIMESTAMP",
    flags,
  );
}

function parseUsingProfile(
  rawText: string,
  profile: Profile,
): ReceiptCandidate {
  const flags: string[] = [];
  const bounded = rawText.slice(0, 100_000);
  if (rawText.length > 100_000) flags.push("OCR_TEXT_TOO_LONG");
  const lines = bounded.normalize("NFKC").split(/\r?\n/).map((line) =>
    line.replace(/\s+/g, " ").trim()
  ).filter(Boolean);
  if (!lines.length) flags.push("OCR_TEXT_UNREADABLE");
  const destination = extractDestination(lines, profile, flags);
  const money = extractAmount(lines, flags);
  const primaryValues = labeledValues(lines, profile.referenceLabels).map(
    normalizeReference,
  );
  const validReferences = primaryValues.filter((value) =>
    profile.referencePattern.test(value) && /\d/.test(value)
  );
  if (primaryValues.length !== validReferences.length) {
    flags.push("REFERENCE_FORMAT_INVALID");
  }
  const primaryReference = singleValue(
    validReferences,
    "REFERENCE_UNREADABLE",
    "AMBIGUOUS_REFERENCE",
    flags,
  );
  const railValues = labeledValues(
    lines,
    /^insta\s*pay\s+reference(?:\s*(?:no\.?|number))?\s*[:#]?\s*(.*)$/i,
  ).map(normalizeReference);
  const rails = distinct(railValues);
  if (rails.length > 1) flags.push("AMBIGUOUS_RAIL_REFERENCE");
  if (
    rails.some((value) =>
      !GENERIC_NATIVE_REFERENCE.test(value) || !/\d/.test(value)
    )
  ) flags.push("RAIL_REFERENCE_INVALID");
  const railReference = rails.length === 1 ? rails[0] : null;
  const receiptAt = extractTimestamp(lines, flags);
  const negativeStatus =
    /\b(?:failed|failure|declined|cancelled|canceled|unsuccessful|reversed|refunded|pending|processing|scheduled)\b/i
      .test(bounded);
  const successful =
    lines.some((line) =>
      /^(?:status\s*:\s*)?(?:transfer\s+)?(?:successful|completed|complete)!?$/i
        .test(line)
    ) ||
    (lines.some((line) =>
      /^(?:your\s+)?transaction\s+has\s+been\s+processed\.?$/i.test(line)
    ) && /\bfund\s+transfer\s+via\s+insta\s*pay\b/i.test(bounded));
  if (!successful) flags.push("SUCCESSFUL_TRANSFER_UNREADABLE");
  if (negativeStatus) flags.push("UNSUCCESSFUL_OR_PENDING_TRANSFER");
  return {
    method: profile.method,
    parserVersion: profile.version,
    layoutValidation: profile.nativeLayout,
    flags: distinct(flags),
    evidence: {
      ...destination,
      ...money,
      primaryReference,
      railReference,
      receiptAt,
      successful: successful && !negativeStatus,
    },
  };
}

// Separate exported parsers make method routing explicit; there is no ToGcash fallback.
export const parseGcashNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.gcash);
export const parseMayaNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.maya);
export const parseBdoPayNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.bdo_pay);
export const parseBpiNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.bpi);
export const parseGotymeNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.gotyme);
export const parsePnbNativeReceipt = (text: string) =>
  parseUsingProfile(text, PROFILES.pnb);

export function parseNativeReceipt(
  method: Method,
  text: string,
): ReceiptCandidate {
  switch (method) {
    case "gcash":
      return parseGcashNativeReceipt(text);
    case "maya":
      return parseMayaNativeReceipt(text);
    case "bdo_pay":
      return parseBdoPayNativeReceipt(text);
    case "bpi":
      return parseBpiNativeReceipt(text);
    case "gotyme":
      return parseGotymeNativeReceipt(text);
    case "pnb":
      return parsePnbNativeReceipt(text);
  }
}

export function verifyNativeCandidate(
  parsed: ReceiptCandidate,
  context: Context,
  deployedCorroboration?: { autoApprove: boolean },
): Decision {
  const flags = [...parsed.flags];
  if (
    context.tenantId !== TARGET_TENANT.id ||
    context.tenantSlug !== TARGET_TENANT.slug
  ) flags.push("TENANT_DENIED");
  if (!context.methodActive) flags.push("METHOD_INACTIVE");
  if (context.bookingApprovalMode !== "automatic") {
    flags.push("TENANT_MANUAL_REVIEW");
  }
  if (context.currency !== "PHP" || parsed.evidence.currency !== "PHP") {
    flags.push("CURRENCY_MISMATCH");
  }
  if (
    !Number.isSafeInteger(context.expectedAmountMinor) ||
    context.expectedAmountMinor <= 0
  ) flags.push("EXPECTED_AMOUNT_INVALID");
  else if (parsed.evidence.amountMinor !== context.expectedAmountMinor) {
    flags.push("AMOUNT_MISMATCH");
  }
  const expectedAccount = normalizeAccount(
    context.recipientAccount,
    parsed.method,
  );
  if (!expectedAccount) flags.push("EXPECTED_RECIPIENT_ACCOUNT_INVALID");
  else if (parsed.evidence.recipientAccount !== expectedAccount) {
    flags.push("RECIPIENT_ACCOUNT_MISMATCH");
  }
  const expectedName = normalizeName(context.recipientName);
  if (!expectedName || expectedName.length < 4) {
    flags.push("EXPECTED_RECIPIENT_NAME_INVALID");
  } else if (parsed.evidence.recipientName !== expectedName) {
    flags.push("RECIPIENT_NAME_MISMATCH");
  }
  const submitted = normalizeReference(context.submittedReference);
  if (!PROFILES[parsed.method].referencePattern.test(submitted)) {
    flags.push("SUBMITTED_REFERENCE_INVALID");
  } else if (submitted !== parsed.evidence.primaryReference) {
    flags.push("REFERENCE_MISMATCH");
  }
  if (context.timezone !== "Asia/Manila") flags.push("TIMEZONE_UNSUPPORTED");
  const startedAt = Date.parse(context.bookingStartedAt);
  const receiptAt = Date.parse(parsed.evidence.receiptAt ?? "");
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(
      context.bookingStartedAt,
    ) || !Number.isFinite(startedAt)
  ) flags.push("BOOKING_TIME_INVALID");
  else if (!Number.isFinite(receiptAt)) flags.push("RECEIPT_TIME_INVALID");
  else {
    const deltaMinutes = (receiptAt - startedAt) / 60_000;
    if (deltaMinutes < -2 || deltaMinutes > 10) {
      flags.push("OUTSIDE_PAYMENT_WINDOW");
    }
  }
  if (
    context.ocrConfidence !== null &&
    (!Number.isFinite(context.ocrConfidence) || context.ocrConfidence < 0.7 ||
      context.ocrConfidence > 1)
  ) flags.push("OCR_CONFIDENCE_INSUFFICIENT");
  const mandatoryEvidenceComplete = flags.length === 0;
  if (parsed.layoutValidation === "unvalidated") {
    flags.push("UNSUPPORTED_NATIVE_LAYOUT");
  } else if (!deployedCorroboration?.autoApprove) {
    flags.push("DEPLOYED_LAYOUT_NOT_CORROBORATED");
  }
  const autoApprove = flags.length === 0;
  return {
    method: parsed.method,
    parserVersion: parsed.parserVersion,
    status: autoApprove ? "auto_approval_candidate" : "manual_review",
    autoApprove,
    mandatoryEvidenceComplete,
    flags: distinct(flags),
    evidence: parsed.evidence,
  };
}
