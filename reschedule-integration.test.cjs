'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function extract(source,name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0);const next=source.slice(start+1).search(/^(?:async )?function \w+\(/m);return source.slice(start,start+next+1);}
test('reschedule deadlines must be today in Manila, future, and before play',()=>{
  const source=fs.readFileSync('admin.html','utf8');
  const context={Date,phDateKeyFromTimestamp:d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(d)};
  vm.runInNewContext(extract(source,'isValidReschedulePaymentDeadline'),context);
  const now=new Date('2026-09-07T15:00:00+08:00');const start='2026-09-08T17:00:00+08:00';
  assert.equal(context.isValidReschedulePaymentDeadline(new Date('2026-09-07T18:00:00+08:00'),start,now),true);
  for(const date of ['2026-09-07T14:00:00+08:00','2026-09-08T01:00:00+08:00','bad'])assert.equal(context.isValidReschedulePaymentDeadline(new Date(date),start,now),false);
  assert.equal(context.isValidReschedulePaymentDeadline(new Date('2026-09-07T18:00:00+08:00'),'2026-09-07T17:00:00+08:00',now),false);
});
test('expired and cancelled adjustments explain that the original confirmed schedule remains',()=>{
  const context={fmt:n=>'PHP '+n,balanceDeadlineLabel:()=> 'today'};
  vm.runInNewContext(extract(fs.readFileSync('index.html','utf8'),'balanceStatusCopy'),context);
  for(const status of ['expired','cancelled'])assert.match(context.balanceStatusCopy({requestType:'reschedule_adjustment',status})[1],/original confirmed schedule was kept/i);
  assert.match(context.balanceStatusCopy({requestType:'reschedule_adjustment',status:'payment_review'})[1],/original schedule remains confirmed/i);
});
test('a missing or inconsistent server price cannot be interpreted as a free schedule change',()=>{
  const context={};vm.runInNewContext(extract(fs.readFileSync('supabase-config.js','utf8'),'_pbPlatformRescheduleOptionToLegacy'),context);
  const price={available:true,courtSubtotalAmount:700,newSubtotalAmount:700,newTotalAmount:720,originalTotalAmount:520,amountPaid:520,additionalAmount:200,paymentRequired:true};
  assert.equal(context._pbPlatformRescheduleOptionToLegacy(price).additionalAmount,200);
  assert.throws(()=>context._pbPlatformRescheduleOptionToLegacy({available:true}),/price/);
  assert.throws(()=>context._pbPlatformRescheduleOptionToLegacy({...price,paymentRequired:false}),/requirement/);
  assert.equal(context._pbPlatformRescheduleOptionToLegacy({available:false}).available,false);
});
