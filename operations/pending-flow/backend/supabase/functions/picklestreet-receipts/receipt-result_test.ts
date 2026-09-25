import assert from 'node:assert/strict';
import {receiptSubmissionResult,reconcileDuplicateRejection} from './index.ts';

Deno.test('a duplicate upload replay reports the saved cancellation without a transient rejected flag',()=>{
  const result=receiptSubmissionResult({claimed:false,idempotent:true,status:'rejected',bookingStatus:'cancelled',paymentStatus:'rejected',flags:['duplicate_payment_reference']});
  assert.equal(result.rejected,true);
  assert.equal(result.status,'rejected');
  assert.match(result.publicReason,/rejected.*Please book again/);
  assert.doesNotMatch(result.publicReason,/duplicate|already been used|payment reference/i);
  assert.doesNotMatch(result.publicReason,/pending|processing/i);
});

Deno.test('an initial duplicate cancellation and its idempotent replay give the same customer explanation',()=>{
  const saved={status:'rejected',bookingStatus:'cancelled',paymentStatus:'rejected',flags:['duplicate_payment_reference']};
  assert.equal(receiptSubmissionResult({...saved,rejected:true}).publicReason,receiptSubmissionResult(saved).publicReason);
});

Deno.test('a manual rejection replay does not invent a duplicate-reference accusation',()=>{
  const result=receiptSubmissionResult({status:'rejected',bookingStatus:'cancelled',paymentStatus:'rejected',flags:['amount_mismatch']});
  assert.equal(result.rejected,true);
  assert.match(result.publicReason,/cancelled/);
  assert.doesNotMatch(result.publicReason,/already been used|pending/i);
});

Deno.test('ordinary failed checks remain pending and paid bookings remain confirmed',()=>{
  for(const flags of [['verification_unavailable'],['amount_mismatch'],['duplicate_payment_reference']]){
    const result=receiptSubmissionResult({status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending',flags});
    assert.equal(result.rejected,undefined);
    assert.equal(result.bookingStatus,'payment_review');
    assert.match(result.publicReason,/^Pending/);
  }
  const confirmed=receiptSubmissionResult({status:'auto_approved',bookingStatus:'confirmed',paymentStatus:'paid'});
  assert.equal(confirmed.rejected,undefined);
  assert.match(confirmed.publicReason,/booking is confirmed/);
});

Deno.test('a rejected additional receipt never turns its original paid booking into a cancelled booking',()=>{
  const result=receiptSubmissionResult({status:'rejected',bookingStatus:'confirmed',paymentStatus:'paid',balanceStatus:'cancelled'},'test-balance');
  assert.equal(result.rejected,undefined);
  assert.equal(result.bookingStatus,'confirmed');
});

Deno.test('replaying saved OCR attempts retries the duplicate decision before returning the customer result',async()=>{
  const calls:Array<unknown>=[];
  const chain:any={update:()=>chain,eq:()=>chain,neq:()=>chain,or:()=>chain,select:()=>chain,maybeSingle:async()=>({error:new Error('Email retry queued')})};
  const db:any={rpc:async(name:string,args:unknown)=>{calls.push({name,args});return {data:{rejected:true,bookingId:'test-booking',bookingStatus:'cancelled',paymentStatus:'rejected',status:'rejected',flags:['duplicate_payment_reference']}};},from:()=>chain};
  const saved={attemptId:'saved-attempt',status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'};
  const result=receiptSubmissionResult(await reconcileDuplicateRejection(db,saved));
  assert.deepEqual(calls,[{name:'reject_picklestreet_duplicate',args:{p_attempt_id:'saved-attempt'}}]);
  assert.equal(result.rejected,true);
  assert.equal(result.bookingStatus,'cancelled');
  assert.match(result.publicReason,/rejected.*Please book again/);
});

Deno.test('a superseded or ineligible replay retains the database decision when rejection RPC declines it',async()=>{
  const saved={attemptId:'superseded-attempt',status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'};
  let checked:string|undefined;
  const db:any={rpc:async(_name:string,args:{p_attempt_id:string})=>{checked=args.p_attempt_id;return {data:{rejected:false}};}};
  assert.equal(await reconcileDuplicateRejection(db,saved),saved);
  assert.equal(checked,'superseded-attempt');
});

Deno.test('duplicate decision failures remain pending and balance replays never run initial-booking cancellation',async()=>{
  const saved={attemptId:'saved-attempt',status:'manual_review',bookingStatus:'payment_review',paymentStatus:'pending'};
  for(const rpc of [async()=>({error:new Error('Unavailable')}),async()=>{throw new Error('Connection lost');}]){
    assert.equal(await reconcileDuplicateRejection({rpc} as any,saved),saved);
  }
  let calls=0;
  const db:any={rpc:async()=>{calls++;throw new Error('Must not run');}};
  assert.equal(await reconcileDuplicateRejection(db,saved,'balance-request'),saved);
  const withoutAttempt={status:'manual_review'};
  assert.equal(await reconcileDuplicateRejection(db,withoutAttempt),withoutAttempt);
  assert.equal(calls,0);
});
