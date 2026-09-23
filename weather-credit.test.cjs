const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const page=fs.readFileSync('index.html','utf8');
function source(name){const start=page.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert(start>=0);return page.slice(start,page.indexOf('\n}',start)+2);}
function harness(result){
 const calls={saved:0,confirmed:0,reset:0};const status={textContent:''};
 const access={reference:'TEST-BOOKING',bookingToken:'test',booking:{totalAmount:215,subtotalAmount:200,serviceFeeAmount:15}};
 const c={window:{PB_PLATFORM_V1:true},_platformBookingAccess:access,_receiptFile:null,$:()=>status,fmt:n=>String(n),platformAccessIsPreliminary:()=>false,
 DB:{weatherCredit:async()=>{if(result instanceof Error)throw result;return result;}},savePlatformRecovery:()=>calls.saved++,updatePrice(){},savePlatformStatusAccess:()=>calls.confirmed++,stopSlotCountdown(){},closeBookModal(){},renderPublicBookingStatus(){},resetForm:()=>calls.reset++,toast(){},renderCourts:async()=>{}};
 vm.createContext(c);vm.runInContext(source('applyGuestWeatherCredit'),c);return {c,calls,status,access};
}
test('partial weather credit saves authoritative top-up without confirming or clearing checkout',async()=>{
 const h=harness({status:'pending_payment',paymentStatus:'unpaid',totalAmount:107.5,subtotalAmount:100,serviceFeeAmount:7.5,minutesUsed:30,feeCredit:7.5,remainingMinutes:0});
 await h.c.applyGuestWeatherCredit('code');assert.equal(h.access.booking.totalAmount,107.5);assert.equal(h.calls.saved,1);assert.equal(h.calls.confirmed,0);assert.equal(h.calls.reset,0);assert.match(h.status.textContent,/107.5/);
});
test('fully credited booking uses server confirmation and preserves zero amount',async()=>{
 const h=harness({status:'confirmed',paymentStatus:'paid',totalAmount:0,subtotalAmount:0,serviceFeeAmount:0,minutesUsed:60,feeCredit:15,remainingMinutes:30});
 await h.c.applyGuestWeatherCredit('code');assert.equal(h.access.booking.totalAmount,0);assert.equal(h.calls.confirmed,1);assert.equal(h.calls.reset,1);
});
test('failed or already-paid credit attempt does not overwrite the existing booking',async()=>{
 const h=harness(new Error('Expired hold'));await assert.rejects(h.c.applyGuestWeatherCredit('code'),/Expired hold/);assert.equal(h.access.booking.totalAmount,215);assert.equal(h.calls.saved,0);
 h.c._receiptFile={};await assert.rejects(h.c.applyGuestWeatherCredit('code'),/before paying/);
});
test('payment display uses saved net amount including zero after a credit',()=>{
 const nodes={};const c={window:{PB_PLATFORM_V1:true},_platformBookingAccess:{booking:{subtotalAmount:0,serviceFeeAmount:0,totalAmount:0}},
 uniqueBookingSelections:x=>x,activeBookingItems:()=>[],bookingItemsDuration:()=>1,bookingItemsCourtFee:()=>200,bookingItemsServiceFee:()=>15,bookingItemsTotal:()=>215,
 downpaymentAmount:x=>x,payFull:true,downpaymentNoteHtml:()=>'',bookingItemsRateLabel:()=>'',bookingFeeDisplay:n=>String(n),fmt:n=>String(n),$:id=>nodes[id]||(nodes[id]={style:{}})};
 vm.createContext(c);vm.runInContext(source('updatePrice'),c);c.updatePrice();assert.equal(nodes.bStepPayAmt.textContent,'0');assert.equal(nodes.gcDownAmt.textContent,'0');
});
