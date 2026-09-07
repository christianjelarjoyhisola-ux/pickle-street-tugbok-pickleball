export type ReceiptAmountProvider =
  | "gcash"
  | "bdopay"
  | "maya"
  | "bpi"
  | "gotyme"
  | "pnb"
  | string;

export type ReceiptAmountEvidence =
  | "currency_peso"
  | "currency_php"
  | "currency_ascii_p"
  | "amount_label"
  | "total_label"
  | "gcash_amount_block_observation"
  | "gcash_concordant_amount_block"
  | "gcash_multiple_total_amount_anchors"
  | "maya_sent_money_context"
  | "maya_ocr_spacing_repair";

export type ReceiptAmountCandidate = {
  amount: number;
  raw: string;
  marker: string | null;
  line: string;
  lineIndex: number;
  start: number;
  score: number;
  evidence: ReceiptAmountEvidence[];
  excluded: boolean;
  exclusionReasons: string[];
};

export type ReceiptAmountExtraction = {
  amount: number | null;
  reliable: boolean;
  ambiguous: boolean;
  evidence: ReceiptAmountEvidence[];
  selectedCandidate: ReceiptAmountCandidate | null;
  candidates: ReceiptAmountCandidate[];
  reason:
    | "selected"
    | "no_candidates"
    | "all_candidates_excluded"
    | "ambiguous";
};

export type ReceiptAmountOptions = {
  provider?: ReceiptAmountProvider;
};

// Require either correctly-grouped thousands or an ungrouped number. In
// particular, never accept a token beginning with a comma. That prevents
// `P1,080.00` from being suffix-parsed as `,080.00` / 80.
const MONEY_SOURCE = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`;
const CURRENCY_SOURCE = String.raw`(?:PHP|₱|P)`;

const CURRENCY_AMOUNT_RE = new RegExp(
  String
    .raw`(?<![A-Z0-9])(?<marker>${CURRENCY_SOURCE})\s*[+\-–—−]?\s*(?<amount>${MONEY_SOURCE})(?![A-Z0-9,.])`,
  "giu",
);

// Google Vision occasionally inserts a space inside the thousands group on
// Maya's large display amount. Keep this grammar deliberately narrow: a real
// currency marker, a non-zero 1-3 digit leading group, exactly three thousands
// digits (possibly split), and exactly two decimal digits.
const MAYA_SPACED_AMOUNT_RE = new RegExp(
  String
    .raw`(?<![A-Z0-9])(?<marker>${CURRENCY_SOURCE})\s*[+\-–—−]?\s*(?<amount>[1-9]\d{0,2}(?:,\s+\d{3}|\s+\d{3}|,\s*(?:\d\s+\d{2}|\d{2}\s+\d))\.\d{2})(?![A-Z0-9,.])`,
  "giu",
);

const MAYA_SPACED_TOKEN_RE = new RegExp(
  String
    .raw`(?<![A-Z0-9])${CURRENCY_SOURCE}\s*[+\-–—−]?\s*[1-9]\d{0,2}(?:,\s+\d{3}|\s+\d{3}|,\s*(?:\d\s+\d{2}|\d{2}\s+\d))\.\d{2}(?![A-Z0-9,.])`,
  "iu",
);

const LABELED_AMOUNT_RE = new RegExp(
  String
    .raw`(?<label>total\s+amount(?:\s+(?:sent|paid|transferred))?|amount(?:\s+(?:sent|paid|transferred))?|grand\s+total|total)\s*[:=\-–—−]?\s*(?<marker>${CURRENCY_SOURCE})?\s*(?<amount>${MONEY_SOURCE})(?![A-Z0-9,.])`,
  "giu",
);

const MONEY_TOKEN_RE = new RegExp(
  String.raw`(?<![\d,])${MONEY_SOURCE}(?![\d,.])`,
  "u",
);

const BARE_MONEY_RE = new RegExp(
  String.raw`(?<![A-Z0-9,])(?<amount>${MONEY_SOURCE})(?![A-Z0-9,.])`,
  "giu",
);

const EXCLUDED_CONTEXTS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "transfer_fee", pattern: /\btransfer\s+fee\b/i },
  {
    reason: "service_fee",
    pattern: /\b(?:service|convenience|transaction|processing)\s+fee\b/i,
  },
  { reason: "fee", pattern: /\bfee\b/i },
  {
    reason: "reference",
    pattern: /\b(?:reference|ref\.?)(?:\s*(?:id|no|number|#))?\b/i,
  },
  {
    reason: "date_or_time",
    pattern: /\b(?:date|time|timestamp|booking\s+started)\b/i,
  },
  {
    reason: "account",
    pattern: /\baccount\s+(?:number|no|name|type|balance)\b/i,
  },
];

const AMOUNT_LABEL_RE = /\bamount(?:\s+(?:sent|paid|transferred))?\b/i;
const TOTAL_LABEL_RE = /\b(?:grand\s+total|total(?:\s+amount)?)\b/i;
const MAYA_ANCHOR_RE = /\bsent\s+money\s+via\b/i;
const GCASH_SENT_VIA_RE = /\bsent\s+via\s+gcash\b/i;
const GCASH_TOTAL_AMOUNT_SENT_RE = /^\s*total\s+amount\s+sent\s*[:=\-–—]?\s*$/i;
const GCASH_REFERENCE_BOUNDARY_RE =
  /\b(?:ref(?:erence)?)(?:\s*(?:no|number|#))?\.?/i;
const GCASH_REORDERED_BLOCK_MAX_NON_EMPTY_LINES = 6;
const GCASH_AMOUNT_DISPLAY_LINE_RE = new RegExp(
  String
    .raw`^\s*(?<marker>${CURRENCY_SOURCE})?\s*[+\-–—−]?\s*(?<amount>${MONEY_SOURCE})\s*$`,
  "iu",
);

function normalizeReceiptText(text: string): string {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\r\n?/g, "\n");
}

function parseMoney(raw: string): number | null {
  const amount = Number(raw.replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseMayaSpacedMoney(raw: string): number | null {
  const amount = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(amount) && amount >= 1000 ? amount : null;
}

function amountHasNegativeNotation(
  line: string,
  amountStart: number,
  amountLength: number,
  allowMayaDashBullet = false,
): boolean {
  const prefix = line.slice(0, Math.max(0, amountStart)).replace(/\s+$/u, "");
  const suffix = line.slice(amountStart + amountLength).replace(/^\s+/u, "");
  const mayaDashBullet = allowMayaDashBullet &&
    /^\s*[\-–—−]\s+(?:PHP|₱|P)\s*(?=\d)/iu.test(line);
  if (/[\-–—−]\s*(?:PHP|₱|P)?$/iu.test(prefix) && !mayaDashBullet) {
    return true;
  }
  if (/^[\-–—−]/u.test(suffix)) return true;
  const parenthesized = (/\(\s*(?:PHP|₱|P)?$/iu.test(prefix) ||
    /(?:PHP|₱|P)\s*\($/iu.test(prefix)) && /^\)/u.test(suffix);
  return parenthesized;
}

function markerEvidence(marker: string | null): ReceiptAmountEvidence | null {
  if (!marker) return null;
  const upper = marker.toUpperCase();
  if (marker === "₱") return "currency_peso";
  if (upper === "PHP") return "currency_php";
  return "currency_ascii_p";
}

function lineHasMoneyAmount(line: string): boolean {
  return MONEY_TOKEN_RE.test(line) || MAYA_SPACED_TOKEN_RE.test(line);
}

function previousNonEmptyLine(
  lines: string[],
  lineIndex: number,
): string {
  for (let index = lineIndex - 1; index >= 0; index--) {
    if (lines[index].trim()) return lines[index];
  }
  return "";
}

function contextExclusions(lines: string[], lineIndex: number): string[] {
  const current = lines[lineIndex] || "";
  const previous = previousNonEmptyLine(lines, lineIndex);
  const reasons = new Set<string>();

  for (const item of EXCLUDED_CONTEXTS) {
    if (item.pattern.test(current)) reasons.add(item.reason);

    // Receipt apps commonly put a label on one line and its value on the next.
    // Only inherit a preceding exclusion when that line is label-only; this
    // avoids an amount following an already-complete fee line being discarded.
    if (
      previous && item.pattern.test(previous) &&
      !lineHasMoneyAmount(previous)
    ) {
      reasons.add(item.reason);
    }
  }

  return [...reasons];
}

function mayaAnchorIndexes(lines: string[]): number[] {
  const indexes: number[] = [];
  lines.forEach((line, index) => {
    if (MAYA_ANCHOR_RE.test(line)) indexes.push(index);
  });
  return indexes;
}

function isMayaReceipt(
  text: string,
  provider: ReceiptAmountProvider | undefined,
): boolean {
  if (String(provider || "").toLowerCase() === "maya") return true;
  return /\bmaya\b/i.test(text) &&
    (MAYA_ANCHOR_RE.test(text) ||
      /\b(?:insta\s*pay|qr\s*ph|qrph)\b/i.test(text));
}

function hasMayaPrincipalContext(
  lines: string[],
  lineIndex: number,
  anchors: number[],
): boolean {
  // Maya places the principal debit on the same line or as the first monetary
  // value shortly after "Sent money via". Later values must not inherit this
  // evidence merely because OCR kept them physically close to the heading.
  return anchors.some((anchor) => {
    if (lineIndex < anchor) return false;
    const nonEmptyDistance = lines.slice(anchor, lineIndex + 1)
      .filter((line) => line.trim()).length;
    if (nonEmptyDistance > 4) return false;
    for (let index = anchor; index < lineIndex; index++) {
      if (lineHasMoneyAmount(lines[index])) return false;
    }
    return true;
  });
}

function lineLabelEvidence(
  lines: string[],
  lineIndex: number,
): ReceiptAmountEvidence[] {
  const current = lines[lineIndex] || "";
  const previous = previousNonEmptyLine(lines, lineIndex);
  const previousIsLabelOnly = previous && !lineHasMoneyAmount(previous);
  const context = previousIsLabelOnly ? `${previous}\n${current}` : current;
  const evidence: ReceiptAmountEvidence[] = [];
  if (TOTAL_LABEL_RE.test(context)) evidence.push("total_label");
  if (AMOUNT_LABEL_RE.test(context)) evidence.push("amount_label");
  return evidence;
}

function candidateScore(evidence: ReceiptAmountEvidence[]): number {
  let score = 0;
  if (
    evidence.includes("currency_peso") ||
    evidence.includes("currency_php") ||
    evidence.includes("currency_ascii_p")
  ) score += 40;
  if (evidence.includes("amount_label")) score += 55;
  if (evidence.includes("total_label")) score += 65;
  if (evidence.includes("gcash_concordant_amount_block")) score += 85;
  if (evidence.includes("maya_sent_money_context")) score += 80;
  return score;
}

function uniqueEvidence(
  evidence: ReceiptAmountEvidence[],
): ReceiptAmountEvidence[] {
  return [...new Set(evidence)];
}

function collectCandidates(
  text: string,
  options: ReceiptAmountOptions,
): ReceiptAmountCandidate[] {
  const lines = text.split("\n");
  const mayaReceipt = isMayaReceipt(text, options.provider);
  const anchors = mayaReceipt ? mayaAnchorIndexes(lines) : [];
  const byLocation = new Map<string, ReceiptAmountCandidate>();

  const addMatch = (
    line: string,
    lineIndex: number,
    match: RegExpExecArray,
    extraEvidence: ReceiptAmountEvidence[] = [],
    parsedAmount?: number | null,
  ) => {
    const amountRaw = match.groups?.amount || "";
    const amount = parsedAmount === undefined
      ? parseMoney(amountRaw)
      : parsedAmount;
    if (amount == null) return;

    const marker = match.groups?.marker || null;
    const amountOffset = match[0].lastIndexOf(amountRaw);
    const start = (match.index || 0) + Math.max(0, amountOffset);
    if (
      amountHasNegativeNotation(
        line,
        start,
        amountRaw.length,
        options.provider === "maya",
      )
    ) return;
    const key = `${lineIndex}:${start}:${amount}`;
    const exclusions = contextExclusions(lines, lineIndex);
    const evidence = uniqueEvidence([
      ...(markerEvidence(marker) ? [markerEvidence(marker)!] : []),
      ...lineLabelEvidence(lines, lineIndex),
      ...(mayaReceipt && hasMayaPrincipalContext(lines, lineIndex, anchors)
        ? ["maya_sent_money_context" as const]
        : []),
      ...extraEvidence,
    ]);

    const existing = byLocation.get(key);
    if (existing) {
      existing.evidence = uniqueEvidence([...existing.evidence, ...evidence]);
      existing.exclusionReasons = [
        ...new Set([
          ...existing.exclusionReasons,
          ...exclusions,
        ]),
      ];
      existing.excluded = existing.exclusionReasons.length > 0;
      existing.score = candidateScore(existing.evidence);
      return;
    }

    byLocation.set(key, {
      amount,
      raw: match[0],
      marker,
      line,
      lineIndex,
      start,
      score: candidateScore(evidence),
      evidence,
      excluded: exclusions.length > 0,
      exclusionReasons: exclusions,
    });
  };

  lines.forEach((line, lineIndex) => {
    CURRENCY_AMOUNT_RE.lastIndex = 0;
    for (const match of line.matchAll(CURRENCY_AMOUNT_RE)) {
      addMatch(line, lineIndex, match);
    }

    // Do not apply whitespace repair as a general OCR cleanup. It is safe only
    // for Maya's first principal amount near its stable receipt heading.
    if (mayaReceipt && hasMayaPrincipalContext(lines, lineIndex, anchors)) {
      MAYA_SPACED_AMOUNT_RE.lastIndex = 0;
      for (const match of line.matchAll(MAYA_SPACED_AMOUNT_RE)) {
        addMatch(
          line,
          lineIndex,
          match,
          ["maya_ocr_spacing_repair"],
          parseMayaSpacedMoney(match.groups?.amount || ""),
        );
      }
    }

    // This second pass permits an explicitly labeled amount without a currency
    // marker. Location-based merging keeps a labeled currency value from being
    // returned twice.
    LABELED_AMOUNT_RE.lastIndex = 0;
    for (const match of line.matchAll(LABELED_AMOUNT_RE)) {
      const label = match.groups?.label || "";
      addMatch(
        line,
        lineIndex,
        match,
        TOTAL_LABEL_RE.test(label) ? ["total_label"] : ["amount_label"],
      );
    }

    // Vision commonly keeps a label and its bare value on separate lines:
    //
    //   Total Amount Sent
    //   1,080.00
    //
    // A bare decimal is still untrusted everywhere else. Only collect it when
    // the immediately preceding non-empty line is an amount/total label with
    // no monetary value of its own.
    const previous = previousNonEmptyLine(lines, lineIndex);
    if (
      previous && !lineHasMoneyAmount(previous) &&
      (AMOUNT_LABEL_RE.test(previous) || TOTAL_LABEL_RE.test(previous))
    ) {
      BARE_MONEY_RE.lastIndex = 0;
      for (const match of line.matchAll(BARE_MONEY_RE)) {
        addMatch(line, lineIndex, match);
      }
    }
  });

  // DOCUMENT_TEXT_DETECTION can flatten the two-column GCash receipt layout
  // by emitting both labels before both values. Status-bar text can also land
  // between them, for example:
  //
  //   Total Amount Sent
  //   55
  //   3,600.00
  //   P3600.00
  //   Ref No. 4044666766999
  //
  // The normal same/previous-line rules deliberately reject that currency-only
  // read. Recover it only for GCash, only inside the short Total Amount Sent to
  // Ref block, and only when two distinct decimal displays agree and at least
  // one retains a currency marker. The expected booking amount is never used.
  const gcashTotalAmountAnchors = options.provider === "gcash" &&
      GCASH_SENT_VIA_RE.test(text)
    ? lines.map((line, index) =>
      GCASH_TOTAL_AMOUNT_SENT_RE.test(line) ? index : -1
    ).filter((index) => index >= 0)
    : [];
  if (gcashTotalAmountAnchors.length) {
    for (const anchorIndex of gcashTotalAmountAnchors) {
      let boundaryIndex = -1;
      let nonEmptyLines = 0;
      for (let index = anchorIndex + 1; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        nonEmptyLines++;
        if (GCASH_REFERENCE_BOUNDARY_RE.test(line)) {
          boundaryIndex = index;
          break;
        }
        if (nonEmptyLines > GCASH_REORDERED_BLOCK_MAX_NON_EMPTY_LINES) break;
      }
      if (boundaryIndex < 0) continue;

      const blockDisplays = new Map<
        string,
        {
          line: string;
          lineIndex: number;
          match: RegExpExecArray;
          amount: number;
          currencyMarked: boolean;
        }
      >();
      for (
        let lineIndex = anchorIndex + 1;
        lineIndex < boundaryIndex;
        lineIndex++
      ) {
        const line = lines[lineIndex];
        if (contextExclusions(lines, lineIndex).length > 0) continue;
        const match = GCASH_AMOUNT_DISPLAY_LINE_RE.exec(line);
        if (!match) continue;
        const raw = match.groups?.amount || "";
        const amount = parseMoney(raw);
        if (amount == null) continue;
        const start = (match.index || 0) +
          Math.max(0, match[0].lastIndexOf(raw));
        if (amountHasNegativeNotation(line, start, raw.length)) continue;
        blockDisplays.set(`${lineIndex}:${start}:${amount}`, {
          line,
          lineIndex,
          match,
          amount,
          currencyMarked: Boolean(match.groups?.marker),
        });
      }

      const displays = [...blockDisplays.values()];
      for (const display of displays) {
        addMatch(
          display.line,
          display.lineIndex,
          display.match,
          ["gcash_amount_block_observation"],
          display.amount,
        );
      }
      const amounts = new Set(displays.map((display) => display.amount));
      const displayLines = new Set(
        displays.map((display) => display.lineIndex),
      );
      if (
        gcashTotalAmountAnchors.length !== 1 || displayLines.size < 2 ||
        amounts.size !== 1 ||
        !displays.some((display) => display.currencyMarked)
      ) continue;

      for (const display of displays) {
        addMatch(
          display.line,
          display.lineIndex,
          display.match,
          ["gcash_concordant_amount_block"],
          display.amount,
        );
      }
    }

    if (gcashTotalAmountAnchors.length > 1) {
      for (const candidate of byLocation.values()) {
        candidate.evidence = uniqueEvidence([
          ...candidate.evidence,
          "gcash_multiple_total_amount_anchors",
        ]);
        candidate.score = candidateScore(candidate.evidence);
      }
    }
  }

  return [...byLocation.values()].sort((a, b) =>
    a.lineIndex - b.lineIndex || a.start - b.start
  );
}

function isReliableCandidate(candidate: ReceiptAmountCandidate): boolean {
  if (candidate.evidence.includes("gcash_multiple_total_amount_anchors")) {
    return false;
  }
  return candidate.evidence.includes("gcash_concordant_amount_block") ||
    candidate.evidence.includes("maya_sent_money_context") ||
    candidate.evidence.includes("amount_label") ||
    candidate.evidence.includes("total_label");
}

function selectEquivalentCandidate(
  candidates: ReceiptAmountCandidate[],
): { candidate: ReceiptAmountCandidate | null; ambiguous: boolean } {
  const byAmount = new Map<number, ReceiptAmountCandidate[]>();
  for (const candidate of candidates) {
    const group = byAmount.get(candidate.amount) || [];
    group.push(candidate);
    byAmount.set(candidate.amount, group);
  }

  if (byAmount.size === 1) {
    return { candidate: candidates[0], ambiguous: false };
  }
  return { candidate: null, ambiguous: true };
}

/**
 * Extract the principal payment amount from OCR text without trusting a bare
 * first decimal. Candidate scores are based only on receipt context. The
 * expected booking amount is deliberately not an input: ambiguous reads must
 * go to a person instead of being repaired toward the value the system wants.
 */
export function extractReceiptAmount(
  rawText: string,
  options: ReceiptAmountOptions = {},
): ReceiptAmountExtraction {
  const text = normalizeReceiptText(rawText);
  const candidates = collectCandidates(text, options);
  if (candidates.length === 0) {
    return {
      amount: null,
      reliable: false,
      ambiguous: false,
      evidence: [],
      selectedCandidate: null,
      candidates,
      reason: "no_candidates",
    };
  }

  const eligible = candidates.filter((candidate) => !candidate.excluded);
  if (eligible.length === 0) {
    return {
      amount: null,
      reliable: false,
      ambiguous: false,
      evidence: [],
      selectedCandidate: null,
      candidates,
      reason: "all_candidates_excluded",
    };
  }

  const bestScore = Math.max(...eligible.map((candidate) => candidate.score));
  const equivalent = eligible.filter((candidate) =>
    candidate.score === bestScore
  );
  const selected = selectEquivalentCandidate(equivalent);

  if (!selected.candidate) {
    return {
      amount: null,
      reliable: false,
      ambiguous: selected.ambiguous,
      evidence: [],
      selectedCandidate: null,
      candidates,
      reason: "ambiguous",
    };
  }

  return {
    amount: selected.candidate.amount,
    reliable: isReliableCandidate(selected.candidate),
    ambiguous: false,
    evidence: [...selected.candidate.evidence],
    selectedCandidate: selected.candidate,
    candidates,
    reason: "selected",
  };
}
