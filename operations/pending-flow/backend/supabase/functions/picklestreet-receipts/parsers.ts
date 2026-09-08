import { buildSafeReceiptExtraction } from "../_shared/receipt-verification.ts";
import { parseProviderReceipt, verifyProviderReceipt } from "../_shared/picklestreet-source/receipt-providers/index.ts";
type Input = Parameters<typeof buildSafeReceiptExtraction>[0];
type Result = ReturnType<typeof buildSafeReceiptExtraction>;
export const PICKLESTREET_PAYMENT_WINDOW_MINUTES = 15;

function pending(result: Result, flag: string): Result {
  return {...result,autoApprove:false,flags:[...new Set([...result.flags.filter(f=>f!=="auto_approval_eligible"),flag])]};
}
function common(input:Input):Result {
  let result=buildSafeReceiptExtraction({...input,timing:{...input.timing,paymentWindowMinutes:PICKLESTREET_PAYMENT_WINDOW_MINUTES}});
  if(input.payment?.autoApprovalEnabled!==true) result=pending(result,'automatic_method_disabled');
  if (/\b(?:failed|unsuccessful|pending|processing|scheduled|reversed|refunded|cancelled|canceled)\b/i.test(input.vision.text)) result=pending(result,"transaction_not_successful");
  if(input.currency!=="PHP" || /\b(?:USD|EUR|SGD|AUD|JPY)\b/.test(input.vision.text)) result=pending(result,"currency_unverified");
  return result;
}
export function verifyGcash(input:Input):Result {
  let result=common(input);
  const parsed=parseProviderReceipt('gcash',input.vision.text,{typedReference:input.payment?.submittedReference || ''});
  const evidence=verifyProviderReceipt(parsed,{
    typedReference:input.payment?.submittedReference || '',expectedAmount:input.expectedAmount,
    pricingAvailable:Number.isFinite(input.expectedAmount)&&input.expectedAmount>0,amountTolerance:.001,
    expectedRecipientNumber:input.payment?.receiverReference || '',expectedRecipientName:input.payment?.receiverName || '',
    bookingStartedAt:input.timing?.bookingStartedAt,paymentWindowMinutes:PICKLESTREET_PAYMENT_WINDOW_MINUTES,earlyToleranceMinutes:2,
  });
  for(const flag of evidence.flags) result=pending(result,flag.toLowerCase());
  if(evidence.provider!=='gcash') return pending(result,'receipt_parser_unavailable');
  if(evidence.recipientComparison.phone!=='exact') result=pending(result,'payment_receiver_unverified');
  if(!['exact','masked_compatible'].includes(evidence.recipientComparison.name)) result=pending(result,'payment_receiver_name_unverified');
  return result;
}
export function verifyGotyme(input:Input):Result { return common(input); }
export function verifyMaya(input:Input):Result { return pending(common(input),"automatic_method_unsupported"); }
export function verifyBdoPay(input:Input):Result { return pending(common(input),"automatic_method_unsupported"); }
export function verifyBpi(input:Input):Result { return pending(common(input),"automatic_method_unsupported"); }
export function verifyPnb(input:Input):Result { return pending(common(input),"automatic_method_unsupported"); }
const parsers:Record<string,(input:Input)=>Result>={gcash:verifyGcash,gotyme:verifyGotyme,maya:verifyMaya,bdo_pay:verifyBdoPay,bdo:verifyBdoPay,bdopay:verifyBdoPay,bpi:verifyBpi,pnb:verifyPnb};
export function verifyByMethod(input:Input):Result {
  const method=input.payment?.paymentMethod || '';
  return parsers[method]?.(input) ?? pending(common(input),'automatic_method_unsupported');
}
export function publicPendingReason(flags:string[],errorCode=''):string {
  const all=[...flags,errorCode].join(' ').toLowerCase();
  if(/duplicate|reference_used|already_used/.test(all)) return 'Pending — this receipt or transaction reference may already be in use. Contact the venue to resolve it.';
  if(/slot|hold|availability|court|booking_not_eligible/.test(all)) return 'Pending — the court time needs an availability check before confirmation. Contact the venue if your original time is unavailable.';
  if(/unsupported|method_disabled|layout/.test(all)) return 'Pending — automatic verification is not available for this receipt format yet. Your proof is saved.';
  if(/not_successful/.test(all)) return 'Pending — the receipt does not show a completed transfer. Upload the completed transaction receipt when available.';
  if(/receiver/.test(all)) return 'Pending — the receiving account details could not be fully verified. Upload a clearer receipt showing the recipient and account.';
  if(/amount|principal|currency/.test(all)) return 'Pending — the payment amount or currency could not be matched to this booking. Check the receipt and contact the venue if needed.';
  if(/reference/.test(all)) return 'Pending — the transaction reference could not be matched. Check the reference and upload clearer proof.';
  if(/timing|time_|date/.test(all)) return 'Pending — the payment date or time could not be verified. Upload a receipt showing the full transaction date and time.';
  if(/vision|timeout|unavailable|failed|processing/.test(all)) return 'Pending — automatic verification could not finish. Your receipt is saved and can be checked again.';
  return 'Pending — some receipt details could not be verified. Upload clearer proof or ask the venue to retry verification.';
}
