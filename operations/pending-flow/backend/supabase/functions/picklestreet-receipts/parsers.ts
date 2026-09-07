import { buildSafeReceiptExtraction } from "../_shared/receipt-verification.ts";
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
  const text=input.vision.text;
  const lines=text.split(/\r?\n/).map(l=>l.trim());
  const anchor=lines.findIndex(l=>/^(?:sent\s+to|send\s+to|recipient|receiver|paid\s+to)\b/i.test(l));
  const block=anchor<0?"":lines.slice(anchor,anchor+6).join("\n").split(/\b(?:amount|reference|ref\.?\s*no|transaction|sender|sent\s+from)\b/i)[0];
  const account=(input.payment?.receiverReference || "").replace(/\D/g,"").replace(/^(?:63|0)(?=9)/,"");
  const numbers=block.match(/(?:\+?63|0)?9[\d\s-]{8,20}\d/g) || [];
  const accountMatches=account.length===10 && numbers.some(n=>n.replace(/\D/g,"").replace(/^(?:63|0)(?=9)/,"")===account);
  if(!accountMatches) result=pending(result,"payment_receiver_unverified");
  const names=(input.payment?.receiverName || "").normalize('NFKD').toUpperCase().match(/[A-Z]{2,}/g) || [];
  const blockNames:string[]=block.normalize('NFKD').toUpperCase().match(/[A-Z]{2,}/g) || [];
  if(names.length<2 || !names.every(n=>blockNames.includes(n))) result=pending(result,"payment_receiver_name_unverified");
  const principal=[...text.matchAll(/(?:^|\n)\s*(?:amount(?:\s+sent)?|principal\s+amount)\s*[:\-]?\s*(?:PHP|₱|P)?\s*([\d,]+\.\d{2})\b/gi)].map(m=>Number(m[1].replaceAll(',','')));
  if(!principal.length || principal.some(n=>Math.abs(n-input.expectedAmount)>.001)) result=pending(result,"payment_principal_unverified");
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
