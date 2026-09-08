(function managePickleStreet(){
  'use strict';
  const slug='pickle-street-tugbok';
  const $=id=>document.getElementById(id);
  let generation=0;
  const money=value=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(value)||0);
  function privateAccess(record){
    if(!record || record.tenantSlug!==slug || !record.reference || !record.bookingToken) return null;
    return {tenantSlug:slug,reference:String(record.reference),bookingToken:String(record.bookingToken),preliminaryHold:record.booking?.detailsCompleted===true?false:record.preliminaryHold===true||record.booking?.detailsCompleted===false,...(record.draft?{draft:record.draft}:{}),...(record.form?{form:record.form}:{})};
  }
  function parseLink(value){
    const link=new URL(value);
    if(!window.PB_TENANT_CONFIG.productionHosts.includes(link.hostname) && !window.PB_TENANT_CONFIG.developmentHosts.includes(link.hostname)) throw new Error('Use a Pickle Street booking link.');
    const hash=new URLSearchParams(link.hash.slice(1));
    const encoded=hash.get('resume');
    const access=encoded?privateAccess(JSON.parse(encoded)):privateAccess({tenantSlug:slug,reference:hash.get('reference'),bookingToken:hash.get('token')});
    if(!access) throw new Error('This link does not contain private booking access.');
    return access;
  }
  function detail(label,value){const group=document.createElement('div');const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value||'—';group.append(dt,dd);return group;}
  function render(booking,access){
    const result=$('bookingResult');result.replaceChildren();result.hidden=false;
    const status=document.createElement('span');status.className='ps-status';status.textContent=window.PBReceiptPending?.label(booking) || String(booking.status||'Pending').replaceAll('_',' ');
    const ref=document.createElement('p');ref.className='ps-booking-reference';ref.textContent=booking.reference||access.reference;
    const grid=document.createElement('dl');grid.className='ps-detail-grid';
    const date=booking.startsAt?new Date(booking.startsAt):null;
    grid.append(detail('Court',booking.courtName),detail('Date & time',date && Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}).format(date):booking.bookingDate),detail('Booking total',money(booking.totalAmount)),detail('Payment',String(booking.paymentStatus||'unpaid').replaceAll('_',' ')));
    const actions=document.createElement('div');actions.className='ps-result-actions';
    if(booking.canSubmitReceipt===true){const correction=document.createElement('button');correction.className='btn btn-p';correction.textContent='Upload corrected receipt';correction.addEventListener('click',()=>window.PBReceiptPending.openUpload(access,booking,()=>lookup(access)));actions.append(correction);}
    const resume=document.createElement('a');resume.className='btn btn-p';resume.textContent='Open booking & payment';resume.href='index.html#resume='+encodeURIComponent(JSON.stringify(access));actions.append(resume);
    const refresh=document.createElement('button');refresh.className='btn btn-g';refresh.textContent='Refresh status';refresh.addEventListener('click',()=>lookup(access));actions.append(refresh);
    const note=document.createElement('p');note.className='ps-help';note.textContent='For a schedule change, contact the venue. The court manager will check availability and any payment adjustment before changing your booking.';
    const paymentNote=document.createElement('p');paymentNote.className='ps-help';paymentNote.textContent=[window.PBReceiptPending?.reason(booking),window.PBReceiptPending?.hold(booking)].filter(Boolean).join(' ');
    result.append(status,ref,grid,paymentNote,actions,note);
  }
  async function lookup(access){
    const request=++generation;const button=$('lookupButton');button.disabled=true;$('lookupMessage').className='';$('lookupMessage').textContent='Checking your booking…';$('bookingResult').hidden=true;
    try{
      const booking=await DB.getPublicBookingStatus({bookingReference:access.reference,bookingToken:access.bookingToken,preliminaryHold:access.preliminaryHold===true});
      if(booking.detailsCompleted===true)access.preliminaryHold=false;
      if(request!==generation)return;
      render(booking,access);$('lookupMessage').textContent='Booking found.';
    }catch(error){if(request===generation){$('lookupMessage').className='ps-error';$('lookupMessage').textContent=error.message||'The booking could not be loaded. Check your private link and try again.';}}
    finally{if(request===generation)button.disabled=false;}
  }
  $('lookupForm').addEventListener('submit',event=>{
    event.preventDefault();
    try{
      const link=$('bookingLink').value.trim();
      const access=link?parseLink(link):privateAccess({tenantSlug:slug,reference:$('bookingReference').value.trim(),bookingToken:$('bookingToken').value.trim()});
      if(!access)throw new Error('Enter your private booking link, or your reference and access code.');
      lookup(access);
    }catch(error){$('lookupMessage').className='ps-error';$('lookupMessage').textContent=error.message;}
  });
  try{
    let access=location.hash?parseLink(location.href):null;
    if(location.hash)history.replaceState(null,'',location.pathname);
    for(const [storage,key] of [[sessionStorage,'pb_last_booking_access'],[sessionStorage,'pb_platform_booking_access'],[localStorage,'pb_last_booking_access_v2:'+slug],[localStorage,'pb_platform_booking_recovery_v2:'+slug]]){
      if(!access)access=privateAccess(JSON.parse(storage.getItem(key)||'null'));
    }
    if(access){$('bookingReference').value=access.reference;$('bookingToken').value=access.bookingToken;lookup(access);}
  }catch(_){/* Invalid local recovery data never grants access. */}
})();
