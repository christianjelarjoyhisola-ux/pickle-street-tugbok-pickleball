import assert from 'node:assert/strict';
import { receiptApprovalTiming } from './index.ts';
const now=Date.parse('2026-09-09T12:00:00Z');
const booking={status:'confirmed',payment_status:'paid',starts_at:'2026-09-08T10:00:00Z',checked_in_at:null};
const details={groupRescheduleV1:true,quote:{changedSessionIds:['moved']},proposedSessions:[{sessionId:'unchanged',startsAt:'2026-09-08T10:00:00Z'},{sessionId:'moved',startsAt:'2026-09-10T10:00:00Z'}]};
Deno.test('pending grouped balance can be approved for future moved sessions while an unchanged session is past',()=>{
  assert.equal(receiptApprovalTiming(booking,details,now),true);
});
Deno.test('group approval still blocks moved sessions that have started or invalid selected session identities',()=>{
  assert.equal(receiptApprovalTiming(booking,{...details,quote:{changedSessionIds:['unchanged']}},now),false);
  assert.equal(receiptApprovalTiming(booking,{...details,quote:{changedSessionIds:['missing']}},now),false);
  assert.equal(receiptApprovalTiming(booking,{...details,quote:{changedSessionIds:[]}},now),false);
  assert.equal(receiptApprovalTiming(booking,{...details,proposedSessions:[]},now),false);
});
Deno.test('checked-in, cancelled or unpaid bookings never gain approval through grouped metadata',()=>{
  for(const patch of [{checked_in_at:'2026-09-09T11:00:00Z'},{status:'cancelled'},{status:'completed'},{payment_status:'pending'}]){
    assert.equal(receiptApprovalTiming({...booking,...patch},details,now),false);
  }
});
Deno.test('ordinary initial receipts retain their own future-booking timing check',()=>{
  assert.equal(receiptApprovalTiming({...booking,status:'payment_review',payment_status:'pending',starts_at:'2026-09-10T10:00:00Z'},null,now),true);
  assert.equal(receiptApprovalTiming(booking,null,now),false);
});
