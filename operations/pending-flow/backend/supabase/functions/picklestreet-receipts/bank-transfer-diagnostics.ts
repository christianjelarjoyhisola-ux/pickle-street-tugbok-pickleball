// An unbranded bank processing screen is not a completed GCash wallet receipt.
// Extract destination evidence for review; never infer the sending bank or settlement.
export function inspectBankTransfer(text:string,alias:string,token:string){
 if(!/transaction\s+(?:has\s+been\s+)?processed/i.test(text)||!/InstaPay\s+Reference/i.test(text)||!/Destination\s+Account/i.test(text))return null;
 const block=text.match(/Destination\s+Account\s*([\s\S]*?)(?=\bAmount\b)/i)?.[1]||'';
 const compact=(s:string)=>s.toUpperCase().replace(/\s/g,'');
 const name=block.split(/G\s*CASH/i)[0]?.trim()||null;
 const observed=block.split(/G\s*CASH/i)[1]?.replace(/\s/g,'').trim()||null;
 const accountMatch=!!token&&/^[A-Z0-9]{10,40}$/i.test(token)&&observed===compact(token);
 const nameMatch=!!name&&!!alias&&compact(name)===compact(alias);
 return {recipientMatched:accountMatch&&nameMatch,recipient:{observedName:name,observedNumber:observed,
   phoneMatch:accountMatch?'exact':'mismatch',nameMatch:nameMatch?'masked_compatible':'mismatch'}};
}
