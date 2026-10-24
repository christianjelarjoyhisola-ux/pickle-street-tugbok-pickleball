import type {VisionTextResult} from '../_shared/receipt-verification.ts';
// All values come from the same Vision response. Never replace native scores
// with matching-field counts, and never run a second recognition request.
const normalize=(s:string)=>s.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
export function criticalFieldConfidence(words:VisionTextResult['words'],fields:Record<string,string|null|undefined>):Record<string,number>|null {
 if(!words?.length)return null;
 const tokens=words.map(w=>({...w,text:normalize(w.text)})).filter(w=>w.text);
 const scores:Record<string,number>={};
 for(const [field,value] of Object.entries(fields)){
  const target=normalize(value||'');if(!target)return null;
  const occurrences:number[]=[];
  for(let start=0;start<tokens.length;start++){
   let text='';const confidence:number[]=[];
   for(let end=start;end<tokens.length&&text.length<target.length;end++){
    text+=tokens[end].text;confidence.push(tokens[end].confidence??-1);
    if(text===target)occurrences.push(Math.min(...confidence));
   }
  }
  if(!occurrences.length||Math.min(...occurrences)<0)return null;
  // A weak reading of any repeated critical value must not be hidden.
  scores[field]=Math.min(...occurrences);
 }
 return scores;
}
