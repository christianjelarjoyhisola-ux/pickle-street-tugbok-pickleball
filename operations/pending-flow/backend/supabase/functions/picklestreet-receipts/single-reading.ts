/** Recognize an unambiguous MariBank receipt sent to the configured GCash destination. */
export function receiptSourceFromText(text:string,selected:string):string {
  return selected==='gcash' && /\bmari\s*bank\b/i.test(text) && /transaction\s+receipt/i.test(text) && /g[- ]?xchange|gcash/i.test(text)
    && !/sent\s+via\s+gcash/i.test(text) ? 'maribank' : selected;
}

/** Preserve receipt punctuation when Vision's spatial words insert extra spaces. */
export function singleReceiptText(vision:{text:string;layoutText?:string}):string {
 return (vision.layoutText || vision.text)
   .replace(/([A-Za-z])[ \t]+([.*•●]{2,})[ \t]*([A-Za-z])/g,'$1$2$3')
   .replace(/([A-Za-z])[ \t]+([*•●])(?=\s|$)/g,'$1$2')
   .replace(/ +([,.;:])/g,'$1')
   .replace(/G\s*-\s*Xchange/gi,'G-Xchange')
   .replace(/^(-?\s*(?:PHP|P|₱)\s*\d[\d,]*\.\d{2})\s+(instaPay)$/gim,'$1\n$2');
}
