import assert from 'node:assert/strict';
import {receiptVisionWords} from '../_shared/receipt-verification.ts';
import {criticalFieldConfidence} from './field-confidence.ts';
Deno.test('native word extraction preserves missing and zero confidence without inventing scores',()=>{
 const words=receiptVisionWords({pages:[{blocks:[{paragraphs:[{words:[
  {symbols:[{text:'A'},{text:'B'}],confidence:.98},
  {symbols:[{text:'C'}]}, {symbols:[{text:'D'}],confidence:0},
 ]}]}]}]});
 assert.deepEqual(words,[{text:'AB',confidence:.98},{text:'C',confidence:null},{text:'D',confidence:0}]);
});
Deno.test('critical values require complete token boundaries and all occurrences remain strong',()=>{
 assert.equal(criticalFieldConfidence([{text:'999123456',confidence:.99}],{reference:'123456'}),null);
 assert.deepEqual(criticalFieldConfidence([{text:'123',confidence:.99},{text:'456',confidence:.98}],{reference:'123456'}),{reference:.98});
 assert.deepEqual(criticalFieldConfidence([{text:'110.00',confidence:.99},{text:'110.00',confidence:.6}],{amount:'110.00'}),{amount:.6});
});
