// One-time source integration. Reads the protected platform reference; writes this workspace only.
'use strict';
const fs=require('node:fs');
const reference=fs.readFileSync('D:/r&e-pickleball-haven/admin.html','utf8');
let admin=fs.readFileSync('admin.html','utf8');
function extract(source,name){
  const expression=new RegExp('^(?:async )?function '+name+'\\(', 'm');
  const start=source.search(expression);if(start<0)throw Error('Missing function '+name);
  const rest=source.slice(start+1);const next=rest.search(/^(?:async )?function \w+\(/m);
  if(next<0)throw Error('Missing function boundary '+name);
  return source.slice(start,start+1+next);
}
for(const name of ['rescheduleDurationHours','rescheduleDurationLabel','rescheduleRangeSegments','rescheduleUnavailableReasonLabel']) {
  if(admin.includes('function '+name+'(')) admin=admin.replace(extract(admin,name),extract(reference,name));
  else admin=admin.replace('function rescheduleSelectedOption()',extract(reference,name)+'function rescheduleSelectedOption()');
}
for(const name of ['updateRescheduleSaveState','updateRescheduleSummary','renderRescheduleOptions','loadRescheduleOptions']) admin=admin.replace(extract(admin,name),extract(reference,name));
const from=reference.indexOf('      <div class="reschedule-summary" id="rsSummary"');
const to=reference.indexOf('      <div class="reschedule-error" id="rsError"',from);
const start=admin.indexOf('      <div class="reschedule-summary" id="rsSummary"');
const end=admin.indexOf('      <div class="reschedule-error" id="rsError"',start);
if([from,to,start,end].some(n=>n<0))throw Error('Missing reschedule markup');
admin=admin.slice(0,start)+reference.slice(from,to)+admin.slice(end);
admin=admin.replace('<div class="reschedule-options" id="rsOptions"','<p class="reschedule-date-help" id="rsDurationHint"></p><div class="reschedule-options" id="rsOptions"');
admin=admin.replace('<button class="btn btn-p" type="button" id="rsSaveBtn"','<span id="rsSaveHelp" class="reschedule-date-help" aria-live="polite"></span><button class="btn btn-p" type="button" id="rsSaveBtn"');
admin=admin.replace('Move this reservation safely without changing its payment or total.','Choose a new time and review any price difference before confirming.');
admin=admin.replace('Same court and duration. Payment status and total stay unchanged.','Same court and duration. Prices are checked against the new schedule.');
fs.writeFileSync('admin.html',admin);
let index=fs.readFileSync('index.html','utf8');
const referenceIndex=fs.readFileSync('D:/r&e-pickleball-haven/index.html','utf8');
for(const name of ['balanceStatusCopy','renderBalancePayment'])index=index.replace(extract(index,name),extract(referenceIndex,name));
index=index.replace("if (status === 'cancelled') return ['danger', 'This booking and payment request are no longer active.'];","if (status === 'cancelled') return ['danger', adjustment ? 'The requested move was cancelled. Your original confirmed schedule was kept.' : 'This booking and payment request are no longer active.'];");
fs.writeFileSync('index.html',index);
