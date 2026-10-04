import assert from 'node:assert/strict';
import {singleReceiptText,receiptSourceFromText} from './single-reading.ts';
Deno.test('single observation preserves spatial amount rows and masked identity',()=>{
 const text=singleReceiptText({text:'wrong linear ordering',layoutText:'MA .... A S * C.\nAmount PHP 320.00\nRef . No . 1234567890123\nSep 24 , 2026\nG - Xchange'});
 assert.equal(text,'MA....A S* C.\nAmount PHP 320.00\nRef. No. 1234567890123\nSep 24, 2026\nG-Xchange');
 assert.equal(singleReceiptText({text:'Failed\nAmount PHP 200.00\nRecipient\n**** Name'}),'Failed\nAmount PHP 200.00\nRecipient\n**** Name');
});
Deno.test('source detection only switches an unambiguous MariBank-to-GCash receipt',()=>{
 const receipt='MariBank\nTransaction Receipt\nG-Xchange / GCash';
 assert.equal(receiptSourceFromText(receipt,'gcash'),'maribank');
 for(const text of ['MariBank promotion','Transaction Receipt GCash',receipt+'\nSent via GCash']) assert.equal(receiptSourceFromText(text,'gcash'),'gcash');
 assert.equal(receiptSourceFromText(receipt,'maya'),'maya');
});
Deno.test('production analyzer has one OCR call and no recovery retry',()=>{
 const source=Deno.readTextFileSync(new URL('./index.ts',import.meta.url));
 const analyzer=source.slice(source.indexOf('async function analyzeReceipt('),source.indexOf('async function verificationResult('));
 assert.equal((analyzer.match(/await detectReceiptText\(/g)||[]).length,1);
 assert.ok(analyzer.includes('singleReceiptText(observation)'));
 assert.equal(source.includes('recoverReceiptReading'),false);
 assert.equal(analyzer.includes('TEXT_DETECTION'),false);
});
