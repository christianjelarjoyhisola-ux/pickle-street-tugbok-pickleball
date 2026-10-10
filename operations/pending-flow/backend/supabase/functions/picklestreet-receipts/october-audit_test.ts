import assert from 'node:assert/strict';
import {verifySourceRoute, type SourceRouteInput} from './source-routes.ts';
import {singleReceiptText,receiptSourceFromText,readReceiptOnce} from './single-reading.ts';
import {RequestError} from '../_shared/http.ts';
const name='MARIANA SANTOS CRUZ', phone='09171234567', qr='SYNTHETICQR123456';
function verify(text:string,method='gcash',reference='') {
 const input:SourceRouteInput={vision:{text:singleReceiptText({text}),confidence:.96},image:{mimeType:'image/png',sizeBytes:40000},expectedAmount:210,currency:'PHP',payment:{paymentMethod:method,submittedReference:reference,receiverName:name,receiverReference:phone},timing:{bookingStartedAt:'2026-10-10T02:00:00Z',tenantTimezone:'Asia/Manila'},route:{tenantId:'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',tenantSlug:'pickle-street-tugbok',sourceProvider:method,destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true,gcashQrAlias:name,gcashQrToken:qr}};
 return verifySourceRoute(input);
}
const gcash='MAA S. C.\n+63 9.4567\nSent via GCash\nAmount 210.00\nTotal Amount Sent P210.00\nRef No. 1234567890123 Oct 10, 2026 10:02 AM';
Deno.test('compact GCash mask and one-dot masked phone pass only matching recipient',()=>{
 assert.equal(verify(gcash).autoApprove,true);
 for(const text of [gcash.replace('4567','4568'),gcash.replace('MAA','MAZ'),gcash.replace('S. C.','Z. C.'),gcash.replaceAll('210.00','220.00'),gcash.replace('10:02','11:02'),gcash+'\nTransfer failed']) assert.equal(verify(text).autoApprove,false,text);
});
const bpi='Transfer successful!\nSaturday, Oct 10 2026; 10:02:00 AM (GMT +8)\nConfirmation No. 1628300000001\nTransaction Ref. No. 155544\nSent via BPI\nTransfer to\nGCash / G-Xchange\nMARIANA SANTOS CRUZ\n09171234567\nTransfer amount\nPHP 210.00\nFee\nPHP 0.00\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX5438\nTransfer service\nInstaPay\nTransfer using\nAccount number';
Deno.test('BPI source recognition is structural and does not override conflicting brand',()=>{
 assert.equal(receiptSourceFromText(bpi,'gcash'),'bpi');
 assert.equal(receiptSourceFromText(bpi+'\nSent via GCash','gcash'),'gcash');
 assert.equal(receiptSourceFromText('Sent via BPI advertisement','gcash'),'gcash');
 assert.equal(verify(bpi,'bpi').autoApprove,true);
});
Deno.test('BPI omitted JR needs exact full account and remaining full name',()=>{
 const test=(text:string,expectedName:string)=>verifySourceRoute({vision:{text,confidence:.96},image:{mimeType:'image/png',sizeBytes:40000},expectedAmount:210,currency:'PHP',payment:{paymentMethod:'bpi',submittedReference:'',receiverName:expectedName,receiverReference:phone},timing:{bookingStartedAt:'2026-10-10T02:00:00Z',tenantTimezone:'Asia/Manila'},route:{tenantId:'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a',tenantSlug:'pickle-street-tugbok',sourceProvider:'bpi',destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,autoApprovalEnabled:true}});
 assert.equal(test(bpi.replace(name,'MARIANA CRUZ'),'MARIANA JR CRUZ').autoApprove,true);
 assert.equal(test(bpi.replace(name,'MARIANA CRUZ').replace(phone,'09171234568'),'MARIANA JR CRUZ').autoApprove,false);
 assert.equal(test(bpi.replace(name,'MARIA CRUZ'),'MARIANA JR CRUZ').autoApprove,false);
});
const maya='Sent money via ☑\n- P210.00 instaPay\nOct 10, 2026, 10:02 am\nAccount type G-Xchange Inc. / GCash\nAccount number 09171234567\nAccount name MARIANA SANTOS CRUZ\nTransfer Fee P10.00\nReference ID E6FA B72D 4AA1\nInstaPay Ref. No 318496\nmaya';
Deno.test('Maya checkbox heading and exact secondary reference preserve primary reference',()=>{
 const result=verify(maya,'maya','318496');
 assert.equal(result.autoApprove,true,JSON.stringify(result.flags));assert.equal(result.paymentReference,'E6FAB72D4AA1');
 assert.equal(verify(maya,'maya','999999').autoApprove,false);
 assert.equal(verify(maya+'\nProcessing','maya','318496').autoApprove,false);
});
Deno.test('one successful OCR result is never replaced; service failure retries at most once',async()=>{
 let calls=0;const value={text:'first result'};
 assert.equal(await readReceiptOnce(async()=>{calls++;return value}),value);assert.equal(calls,1);
 calls=0;assert.equal(await readReceiptOnce(async()=>{if(++calls===1)throw new RequestError(502,'VISION_UNAVAILABLE','offline');return value}),value);assert.equal(calls,2);
 calls=0;await assert.rejects(()=>readReceiptOnce(async()=>{calls++;throw new RequestError(502,'VISION_UNAVAILABLE','offline')}));assert.equal(calls,2);
 calls=0;await assert.rejects(()=>readReceiptOnce(async()=>{calls++;throw new RequestError(422,'RECEIPT_FILE_INVALID','invalid')}));assert.equal(calls,1);
});
const bdo=`Sent!\nPHP 210.00\nOct 10, 2026 10:02 AM\nAmount PHP 210.00\nService Fee PHP 0.00\nSend via Money instaFay\nTo MA****A S* C.\nG-XCHANGE, INC. / GCASH\n${qr}\nFrom OTHER PERSON\n3609\nInvoice 937707\nnumber\nReference no.\nBN-NB-20261010-05350785`;
Deno.test('BDO QR receipt preserves full reference and exact destination token',()=>{
 const result=verify(bdo,'bdo_pay');assert.equal(result.autoApprove,true,JSON.stringify(result.flags));
 assert.equal(result.paymentReference,'BNNB2026101005350785');
 for(const text of [bdo.replace(qr,'OTHERQR9999999999'),bdo.replace('MA****A','XX****Z'),bdo.replace('Sent!','Pending')])assert.equal(verify(text,'bdo_pay').autoApprove,false);
});
