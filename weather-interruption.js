(function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hours=m=>`${Number((Number(m)/60).toFixed(2))} ${Number(m)===60?'hour':'hours'}`;
  const clock=v=>new Date(v).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'});
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  let el,courts=[],ranges=[],preview=null,request=null,issued=null,busy=false,sequence=0,focus=null;
  const find=s=>el.querySelector(s);
  function message(s){find('[data-wi-message]').textContent=s;}
  function lock(value){busy=value;el.querySelectorAll('button,input,select').forEach(n=>n.disabled=value);if(!value)sync();}
  function shell(){
    if(el)return;
    el=document.createElement('dialog');el.className='weather-credit-dialog wi-dialog';el.setAttribute('aria-labelledby','wi-title');
    el.innerHTML='<header class="wi-header"><div><span class="wi-eyebrow">COURT CARE</span><h2 id="wi-title">Weather interruption</h2><p>One interruption. Every affected booking.</p></div><button type="button" class="wi-close" data-wi-close aria-label="Close weather interruption">×</button></header><div data-wi-body></div><p class="wi-message" data-wi-message role="status" aria-live="polite"></p>';
    find('[data-wi-close]').onclick=()=>{if(!busy)el.close();};
    el.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    el.addEventListener('close',()=>{sequence++;focus?.focus?.();if(issued)window.PBWeatherInterruption.renderPage();});document.body.append(el);
  }
  function rangeLabel(r){return `${esc(courts.find(c=>c.id===r.courtId)?.name||'Court')} · ${esc(r.start.slice(0,10))} · ${esc(clock(r.start))}–${esc(clock(r.end))}`;}
  function renderForm(){
    find('[data-wi-body]').innerHTML=`<div class="wi-steps"><span class="active">1 · Affected time</span><span>2 · Review bookings</span><span>3 · Issue credits</span></div>
      <section class="wi-section" data-wi-setup><h3>Where did play stop?</h3><p class="weather-credit-muted">Select courts and time ranges in Philippine time. Only the affected hours are credited.</p>
      <div class="wi-fields"><label>Date<input type="date" data-wi-date value="${today()}" required></label><label>From<input type="time" data-wi-start value="14:00" step="900" required></label><label>Until<select data-wi-end>${Array.from({length:96},(_,i)=>{const n=i+1,h=Math.floor(n/4),m=n%4*15,v=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');return `<option value="${v}" ${v==='16:00'?'selected':''}>${h===24?'12:00 AM (next day)':`${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`}</option>`;}).join('')}</select></label></div>
      <fieldset class="wi-courts"><legend>Affected courts</legend>${courts.map(c=>`<label><input type="checkbox" data-wi-court value="${esc(c.id)}"><span>${esc(c.name)}</span></label>`).join('')}</fieldset>
      <button type="button" class="wi-secondary" data-wi-add>+ Add time range</button><div class="wi-ranges" data-wi-ranges></div></section>
      <section class="wi-section" data-wi-setup><label class="wi-condition">Weather condition<select data-wi-reason><option value="rain">Rain</option><option value="wet_court">Wet court</option><option value="unsafe_weather">Unsafe weather</option></select></label></section>
      <div data-wi-preview></div><footer class="wi-footer"><p>Original bookings and payments stay on record. Court closures are managed separately under Blocked Dates.</p><button type="button" class="wi-primary" data-wi-preview-button>Preview affected bookings</button></footer>`;
    find('[data-wi-add]').onclick=addRange;
    find('[data-wi-preview-button]').onclick=loadPreview;
    find('[data-wi-reason]').onchange=()=>{request=null;};
    renderRanges();
  }
  function invalidate(){preview=null;request=null;find('[data-wi-preview]').innerHTML='';el.querySelectorAll('[data-wi-setup],.wi-footer').forEach(n=>n.hidden=false);el.querySelectorAll('.wi-steps span').forEach((n,i)=>n.classList.toggle('active',i===0));message('');}
  function addRange(){
    const date=find('[data-wi-date]'),start=find('[data-wi-start]');if(!date.reportValidity()||!start.reportValidity())return;
    const ids=[...el.querySelectorAll('[data-wi-court]:checked')].map(n=>n.value);if(!ids.length){message('Select at least one affected court.');return;}
    const from=`${date.value}T${start.value}:00+08:00`,end=find('[data-wi-end]').value;
    const to=end==='24:00'?new Date(new Date(`${date.value}T00:00:00+08:00`).getTime()+86400000).toISOString():`${date.value}T${end}:00+08:00`;
    if(new Date(to)<=new Date(from)){message('Choose an end time after the start time. Add a separate range for the next day.');return;}
    if(ranges.length+ids.length>48){message('Use up to 48 court time ranges per interruption.');return;}
    if(ids.some(id=>ranges.some(r=>r.courtId===id&&new Date(r.start)<new Date(to)&&new Date(r.end)>new Date(from)))){message('A selected court already has an overlapping range. Remove or adjust it first.');return;}
    ranges.push(...ids.map(courtId=>({courtId,start:from,end:to})));invalidate();renderRanges();
  }
  function renderRanges(){
    find('[data-wi-ranges]').innerHTML=ranges.length?ranges.map((r,i)=>`<div class="wi-range"><span>${rangeLabel(r)}</span><button type="button" data-wi-remove="${i}" aria-label="Remove ${esc(courts.find(c=>c.id===r.courtId)?.name)} time range">×</button></div>`).join(''):'<p class="wi-empty">Add the times affected by this interruption.</p>';
    el.querySelectorAll('[data-wi-remove]').forEach(n=>n.onclick=()=>{ranges.splice(Number(n.dataset.wiRemove),1);invalidate();renderRanges();});sync();
  }
  function sync(){
    if(busy)return;
    const p=find('[data-wi-preview-button]');if(p)p.disabled=!ranges.length;
    const selected=[...el.querySelectorAll('[data-wi-booking]:checked')];
    const total=selected.reduce((n,x)=>n+Number(x.dataset.minutes),0);
    const summary=find('[data-wi-total]');if(summary)summary.textContent=`${selected.length} ${selected.length===1?'booking':'bookings'} · ${hours(total)}`;
    const issue=find('[data-wi-issue]');if(issue)issue.disabled=!selected.length||selected.length>50||!find('[data-wi-attest]').checked;
    const all=find('[data-wi-all]');if(all){const count=el.querySelectorAll('[data-wi-booking]').length;all.disabled=count===0;all.checked=count>0&&selected.length===count;all.indeterminate=selected.length>0&&selected.length<count;}
  }
  async function loadPreview(){
    if(busy||!ranges.length)return;lock(true);message('Checking affected bookings…');const seq=sequence;
    try{const r=await window.DB.weatherCredit('preview-batch',{windows:ranges});if(seq!==sequence)return;preview=r;request=null;renderPreview();message('Review the hours and select the bookings to credit.');}
    catch(e){message(e.message||'Could not load the preview.');}finally{lock(false);}
  }
  function renderPreview(){
    const rows=preview.bookings,eligible=rows.filter(r=>r.eligible);
    find('[data-wi-preview]').innerHTML=`<section class="wi-section wi-review"><div class="wi-review-heading"><div><span class="wi-eyebrow">REVIEW BEFORE ISSUING</span><h3 tabindex="-1" data-wi-review-title>Affected bookings</h3></div><span class="wi-pill">${eligible.length} eligible</span></div><p class="weather-credit-muted">${ranges.map(rangeLabel).join('<br>')}</p><button type="button" class="wi-secondary" data-wi-edit>Edit affected time</button>
      ${rows.length?`<label class="wi-select-all"><input type="checkbox" data-wi-all ${eligible.length?'':'disabled'}> Select all eligible bookings <small>Up to 50 per batch</small></label><div class="wi-bookings">${rows.map((r,i)=>`<label class="wi-booking ${r.eligible?'':'wi-excluded'}">${r.eligible?`<input type="checkbox" data-wi-booking="${i}" data-minutes="${r.minutes}" ${eligible.length<=50?'checked':''}>`:'<span class="wi-skip" aria-hidden="true">—</span>'}<span class="wi-person"><strong>${esc(r.name)}</strong><small>${esc(r.reference)} · ${esc(r.email||'No email')}</small><small>${r.sessions.map(s=>`${esc(s.court)} · ${esc(clock(s.start))}–${esc(clock(s.end))}`).join('<br>')}</small>${r.exclusion?`<em>${esc(r.exclusion)}</em>`:''}</span><span class="wi-hours">${hours(r.minutes)}<small>${r.eligible?'replacement time':'not selected'}</small></span></label>`).join('')}</div>`:'<p class="wi-empty">No active bookings overlap these court times.</p>'}
      ${eligible.length?'<div class="wi-summary"><span>Selected credit</span><strong data-wi-total></strong></div><label class="weather-credit-attest"><input type="checkbox" data-wi-attest> I verified that these hours were lost to weather and have not already been refunded or replaced.</label><button type="button" class="wi-primary" data-wi-issue>Issue & email selected credits</button><p class="weather-credit-muted">Credits include the booking fee for replacement time. No expiry. Valid on the original court(s).</p>':''}</section>`;
    el.querySelectorAll('[data-wi-setup],.wi-footer').forEach(n=>n.hidden=true);
    el.querySelectorAll('.wi-steps span').forEach((n,i)=>n.classList.toggle('active',i===1));
    find('[data-wi-edit]').onclick=()=>{invalidate();sync();el.scrollTop=0;};
    find('[data-wi-review-title]').focus();el.scrollTop=0;
    find('[data-wi-all]')?.addEventListener('change',e=>{el.querySelectorAll('[data-wi-booking]').forEach((n,i)=>n.checked=e.target.checked&&i<50);sync();});
    el.querySelectorAll('[data-wi-booking],[data-wi-attest]').forEach(n=>n.addEventListener('change',sync));
    find('[data-wi-issue]')?.addEventListener('click',issue);sync();
  }
  async function issue(){
    if(busy)return;
    if(!request){
      const selected=[...el.querySelectorAll('[data-wi-booking]:checked')].map(n=>preview.bookings[Number(n.dataset.wiBooking)].reference);
      if(!selected.length||selected.length>50||!find('[data-wi-attest]')?.checked)return;
      request={batchId:crypto.randomUUID(),windows:JSON.parse(JSON.stringify(ranges)),references:selected,snapshot:preview.snapshot,reason:find('[data-wi-reason]').value};
    }
    lock(true);message('Issuing selected credits. Please keep this window open…');
    try{const r=await window.DB.weatherCredit('issue-batch',request);issued=r.bookings.map(b=>({...b,delivery:b.credit.emailSent?'sent':'pending'}));renderResult();await deliver();}
    catch(e){find('[data-wi-body]').innerHTML=`<section class="wi-section"><h3>Check this batch before continuing</h3><p>${esc(e.message||'The response was interrupted.')}</p><p>Retry checks the same request and will not issue duplicate credits.</p><button type="button" class="wi-primary" data-wi-retry>Check / retry batch</button> <button type="button" class="wi-secondary" data-wi-refresh>Refresh preview</button></section>`;find('[data-wi-retry]').onclick=issue;find('[data-wi-refresh]').onclick=()=>{request=null;renderForm();loadPreview();};message('No new batch will be created by retrying.');}
    finally{lock(false);}
  }
  function renderResult(){
    find('[data-wi-body]').innerHTML=`<section class="wi-section"><span class="wi-eyebrow">CREDITS SAVED</span><h3>${issued.length} ${issued.length===1?'booking':'bookings'} · ${hours(issued.reduce((n,b)=>n+b.minutes,0))}</h3><p>Each customer has an individual code. Original bookings and payment records are preserved.</p><div class="wi-bookings">${issued.map(b=>`<div class="wi-booking"><span class="wi-person"><strong>${esc(b.name)}</strong><small>${esc(b.reference)} · ${esc(b.email)}</small><code>${esc(b.credit.code)}</code></span><span class="wi-hours">${hours(b.minutes)}<small>${b.delivery==='sent'?'Email sent':'Email pending'}</small></span></div>`).join('')}</div><button type="button" class="wi-secondary" data-wi-email>Retry pending emails</button><p class="weather-credit-muted">Credit remains valid even if email delivery is pending. Codes are also available in each booking’s Weather Credit details.</p></section>`;
    find('[data-wi-email]').onclick=async()=>{if(busy)return;lock(true);try{await deliver();}finally{lock(false);}};
    find('[data-wi-email]').hidden=issued.every(b=>b.delivery==='sent');el.scrollTop=0;
  }
  async function deliver(){
    message('Credits saved. Sending customer emails…');
    // Two workers keep larger batches responsive without flooding the mail provider.
    const pending=issued.filter(b=>b.delivery!=='sent');let completed=0;
    async function worker(){while(pending.length){const b=pending.shift();try{const r=await window.DB.weatherCredit('email',{bookingReference:b.reference});b.delivery=r.credit?.emailSent?'sent':'pending';}catch{b.delivery='pending';}completed++;message(`Credits saved. Checked ${completed} email deliveries…`);}}
    await Promise.all([worker(),worker()]);
    renderResult();message(issued.every(b=>b.delivery==='sent')?'All credits saved and emails sent.':'All credits saved. Some emails are pending; retry delivery or copy a code.');
  }
  let historySequence=0;
  async function renderPage(offset=0){
    const target=document.getElementById('weatherCreditHistory');if(!target)return;
    const seq=++historySequence;target.textContent='Loading credit history…';
    try{
      const result=await window.DB.weatherCredit('history',{offset});if(seq!==historySequence)return;
      target.innerHTML=result.credits.length?'<div class="wc-history-scroll"><table class="wc-history-table"><thead><tr><th>Issued / booking</th><th>Customer</th><th>Issued time</th><th>Available</th><th>Email</th><th></th></tr></thead><tbody>'+result.credits.map(c=>'<tr><td>'+esc(new Date(c.createdAt).toLocaleDateString('en-PH',{timeZone:'Asia/Manila'}))+'<small>'+esc(c.reference)+'</small></td><td>'+esc(c.name||c.email)+'</td><td>'+hours(c.minutes)+'</td><td>'+hours(c.balanceMinutes)+'</td><td>'+esc(c.emailSent?'Sent':'Pending')+'</td><td><button class="btn btn-g btn-sm" type="button" data-wc-reference="'+esc(c.reference)+'">View credit</button></td></tr>').join('')+'</tbody></table></div>':'<div class="wi-empty"><strong>No weather credits issued yet</strong><p>Start a weather interruption to preview affected bookings before issuing credits.</p></div>';
      target.querySelectorAll('[data-wc-reference]').forEach(button=>button.onclick=()=>window.PBWeatherCredit.openManager(button.dataset.wcReference));
      if(offset||result.hasMore){const pager=document.createElement('div');pager.className='wc-history-pager';for(const [label,next,disabled] of [['Previous',offset-50,!offset],['Next',offset+50,!result.hasMore]]){const button=document.createElement('button');button.type='button';button.className='btn btn-g btn-sm';button.textContent=label;button.disabled=disabled;button.onclick=()=>renderPage(next);pager.append(button);}target.append(pager);}
    }catch(e){if(seq===historySequence)target.textContent=e.message||'Credit history could not be loaded. Use Refresh to try again.';}
  }
  window.PBWeatherInterruption={renderPage,async open(){
    if(busy)return;shell();focus=document.activeElement;ranges=[];preview=null;request=null;issued=null;const seq=++sequence;find('[data-wi-body]').textContent='Loading courts…';message('');el.showModal();
    try{courts=await window.DB.getCourts();if(seq!==sequence)return;if(!courts.length)throw Error('No courts available. Reload the dashboard and try again.');renderForm();}
    catch(e){message(e.message||'Could not load courts.');}
  }};
})();
