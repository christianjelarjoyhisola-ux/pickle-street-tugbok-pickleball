import type { VisionTextResult } from '../_shared/receipt-verification.ts';

type Reading = {
  autoApprove: boolean;
  flags: string[];
  paymentReference: string | null;
  extractedData: { detected: { amounts: number[] }; [key: string]: unknown };
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
  if (primary.autoApprove || !['gcash', 'maribank'].includes(options.method)) return primary;
  // Do not let another reading erase positive evidence of a failed/pending
  // transfer, a wrong amount, a different source, or an expired payment.
  if (primary.flags.some(f => /transaction_not_successful|payment_source_mismatch|amount_mismatch|payment_window_expired|currency_unverified/.test(f))) return primary;
  const readings: T[] = [primary];
  const accept = (candidate: VisionTextResult, reason: string): T | null => {
    const result = verify(candidate);
    const conflict = readings.some(previous =>
      (previous.paymentReference && result.paymentReference && previous.paymentReference !== result.paymentReference) ||
      previous.extractedData.detected.amounts.some(amount => !result.extractedData.detected.amounts.includes(amount)) ||
      previous.flags.includes('transaction_not_successful')
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
