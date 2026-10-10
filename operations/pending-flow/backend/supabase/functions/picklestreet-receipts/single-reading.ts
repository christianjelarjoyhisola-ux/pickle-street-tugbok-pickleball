/** Recognize an unambiguous MariBank receipt sent to the configured GCash destination. */
export function receiptSourceFromText(text:string,selected:string):string {
  if (selected === 'gcash' && /sent\s+via\s+bpi/i.test(text) && /transfer\s+successful/i.test(text)
    && /confirmation\s+no/i.test(text) && /transaction\s+ref/i.test(text) && !/sent\s+via\s+gcash/i.test(text)) return 'bpi';
  return selected==='gcash' && /\bmari\s*bank\b/i.test(text) && /transaction\s+receipt/i.test(text) && /g[- ]?xchange|gcash/i.test(text)
    && !/sent\s+via\s+gcash/i.test(text) ? 'maribank' : selected;
}

/** Retry a transport/service failure only; never replace a successful reading. */
export async function readReceiptOnce<T>(read:()=>Promise<T>):Promise<T> {
 try { return await read(); }
 catch(error) {
   if (!(error instanceof Error) || !('code' in error) || error.code !== 'VISION_UNAVAILABLE') throw error;
   return await read();
 }
}

/** Preserve receipt punctuation when Vision's spatial words insert extra spaces. */
export function singleReceiptText(vision:{text:string;layoutText?:string}):string {
 return (vision.layoutText || vision.text)
   .replace(/([A-Za-z])[ \t]+([.*•●]{2,})[ \t]*([A-Za-z])/g,'$1$2$3')
   .replace(/([A-Za-z])[ \t]+([*•●])(?=\s|$)/g,'$1$2')
   .replace(/ +([,.;:])/g,'$1')
   .replace(/G\s*-\s*Xchange/gi,'G-Xchange')
   .replace(/^Invoice\s+(\d{4,20})\nnumber$/gim,'Invoice number $1')
   .replace(/^(-?\s*(?:PHP|P|₱)\s*\d[\d,]*\.\d{2})\s+(instaPay)$/gim,'$1\n$2');
}
