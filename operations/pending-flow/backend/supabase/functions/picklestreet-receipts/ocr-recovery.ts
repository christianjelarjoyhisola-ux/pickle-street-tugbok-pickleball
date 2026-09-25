import type { VisionTextResult } from '../_shared/receipt-verification.ts';

type Reading = {
  autoApprove: boolean;
  flags: string[];
  paymentReference: string | null;
  extractedData: { detected: { amounts: number[]; route?: { recipient?: { nameMatch?: string; phoneMatch?: string } } }; [key: string]: unknown };
};

/** Every candidate is a complete reading. Never combine partial payment evidence. */
export async function recoverReceiptReading<T extends Reading>(options: {
  primary: T;
  vision: VisionTextResult;
  method: string;
  verify: (vision: VisionTextResult) => T;
  retry: () => Promise<VisionTextResult>;
}): Promise<T> {
  const { primary, vision, verify } = options;
  if (primary.autoApprove || !['gcash', 'maribank', 'gotyme'].includes(options.method)) return primary;
  // Do not let another reading erase positive evidence of a failed/pending
  // transfer, a wrong amount, a different source, or an expired payment.
  if (primary.flags.some(f => /transaction_not_successful|payment_source_mismatch|amount_mismatch|payment_window_expired|currency_unverified/.test(f))) return primary;
  // A missing GoTyme mask can be read again, but a positively mismatched
  // recipient must not disappear when Vision changes the reading order.
  const gotymeConflict = (reading: T) => options.method === 'gotyme' && (
    reading.extractedData.detected.route?.recipient?.phoneMatch === 'mismatch' ||
    reading.extractedData.detected.route?.recipient?.nameMatch === 'mismatch' ||
    reading.flags.some(f => /transaction_not_successful|payment_source_mismatch|amount_mismatch|payment_window_expired|currency_unverified/.test(f))
  );
  if (gotymeConflict(primary)) return primary;
  const readings: T[] = [primary];
  const accept = (candidate: VisionTextResult, reason: string): T | null => {
    const result = verify(candidate);
    const conflict = readings.some(previous =>
      (previous.paymentReference && result.paymentReference && previous.paymentReference !== result.paymentReference) ||
      previous.extractedData.detected.amounts.some(amount => !result.extractedData.detected.amounts.includes(amount)) ||
      previous.flags.includes('transaction_not_successful') || gotymeConflict(previous)
    );
    readings.push(result);
    if (!result.autoApprove || conflict) return null;
    result.extractedData.ocrFallbackReason = reason;
    return result;
  };
  if (vision.layoutText) {
    const result = accept({...vision, text: vision.layoutText}, 'Complete receipt read in visual row order');
    if (result) return result;
  }
  try {
    const alternate = await options.retry();
    const result = accept(alternate, 'Complete receipt verified by independent text-mode reading');
    if (result) return result;
    if (alternate.layoutText) {
      const layout = accept({...alternate, text: alternate.layoutText}, 'Complete text-mode receipt read in visual row order');
      if (layout) return layout;
    }
  } catch {
    // A failed optional OCR request must not erase the original diagnostics.
  }
  return primary;
}
