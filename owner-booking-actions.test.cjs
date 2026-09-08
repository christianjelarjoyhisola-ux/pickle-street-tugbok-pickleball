const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('admin.html','utf8');
const source=html.slice(html.lastIndexOf('function bookingActionsHtml('),html.lastIndexOf('function bookingPayStateSelect('));
function actions(role,status='confirmed') {
 const context={sess:{role},Auth:{can:(_,role)=>role==='owner'},window:{PB_PLATFORM_V1:true,PBReceiptPending:{automatic:()=>true,manualReviewTarget:()=>false}},
  bookingDetailsButton:()=>'',weatherRefundActionButton:()=>'',multiSessionRescheduleNotice:()=>'',canRescheduleBooking:()=>false,canRestoreCancelledBooking:()=>false,jsArg:s=>s};
 vm.createContext(context);vm.runInContext(source,context);
 return context.bookingActionsHtml({ref:'TEST',status},role==='owner');
}
test('System owner sees Cancel, Archive and Delete for automatic receipt bookings',()=>{
 for(const status of ['confirmed','pending','verifying']){
  const s=actions('owner',status);
  for(const label of ['Cancel','Archive','Delete'])assert.ok(s.includes('>'+label+'</button>'));
 }
});
test('Court owner sees Cancel but cannot see Archive or Delete',()=>{
 const s=actions('court_owner');assert.ok(s.includes('>Cancel</button>'));
 assert.ok(!s.includes('>Archive</button>'));assert.ok(!s.includes('>Delete</button>'));
});
test('Staff do not see owner actions',()=>{
 const s=actions('staff');for(const label of ['Cancel','Archive','Delete'])assert.ok(!s.includes('>'+label+'</button>'));
});
test('Cancelled bookings retain owner archive/delete without another cancel',()=>{
 const s=actions('owner','cancelled');assert.ok(!s.includes('>Cancel</button>'));
 assert.ok(s.includes('>Archive</button>'));assert.ok(s.includes('>Delete</button>'));
});
