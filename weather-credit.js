(function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let generation=0,busy=false,reference='',returnFocus=null;
  const money=value=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(value)||0);
  function dialog(){
    let el=document.getElementById('weatherCreditDialog');
    if(el)return el;
    el=document.createElement('dialog');el.id='weatherCreditDialog';el.className='weather-credit-dialog';el.setAttribute('aria-labelledby','weatherCreditTitle');
    el.innerHTML='<div class="weather-credit-heading"><h2 id="weatherCreditTitle">Weather credit</h2><button type="button" data-credit-close aria-label="Close weather credit">×</button></div><div data-credit-body></div><p data-credit-message role="status" aria-live="polite"></p>';
    el.querySelector('[data-credit-close]').addEventListener('click',()=>{if(!busy)el.close();});
    el.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    el.addEventListener('close',()=>{generation++;returnFocus?.focus?.();});
    document.body.append(el);return el;
  }
  function renderManager(result){
    const el=dialog(),credit=result.credit,used=result.usedCredit;
    el.querySelector('[data-credit-body]').innerHTML=`<p class="weather-credit-muted">${esc(reference)}</p>
      ${used?`<div class="weather-credit-summary">${used.minutes} minutes ${used.released?'returned':'used'} · Court credit ${money(used.courtAmount)} · Booking fee credit ${money(used.feeAmount)}</div>`:''}
      ${credit?`<div class="weather-credit-summary"><strong>${credit.balanceMinutes} minutes available</strong><p>${credit.minutes} minutes originally issued</p><code>${esc(credit.code)}</code></div><p>Issued to ${esc(result.email)}. Use the same email for replacement time on the original court(s).</p><button type="button" class="btn btn-g" data-credit-copy>Copy code</button> <button type="button" class="btn btn-p" data-credit-email ${credit.emailSent?'disabled':''}>${credit.emailSent?'Email sent':'Retry email'}</button>`
        :result.eligible?`<p>Record unused time after staff confirm rain or an unsafe court. Issuing credit keeps the original booking and payment history.</p><label for="weatherCreditMinutes">Unused court time (minutes)</label><input id="weatherCreditMinutes" type="number" min="1" max="${result.maximumMinutes}" step="1" value="${result.maximumMinutes}" required><p class="weather-credit-muted">Up to ${result.maximumMinutes} court-minutes. Count only time lost to weather, including each affected court.</p><label for="weatherCreditReason">Weather condition</label><select id="weatherCreditReason"><option value="rain">Rain</option><option value="wet_court">Wet court</option><option value="unsafe_weather">Unsafe weather</option></select><p>Equivalent replacement time includes its booking fee. Extra time is charged separately. Credit is valid on the original court(s) and has no expiry.</p><label class="weather-credit-attest"><input id="weatherCreditAttest" type="checkbox"> I verified this unused time and it has not already been refunded or replaced.</label><button type="button" class="btn btn-p" data-credit-issue>Issue & email credit</button>`
        :'<p>A paid booking with confirmed court time and a guest email is required to issue weather credit.</p>'}`;
    el.querySelector('[data-credit-copy]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(credit.code);message('Code copied.');}catch{message('Select the code above to copy it.');}});
    el.querySelector('[data-credit-email]')?.addEventListener('click',()=>saveManager('email',{}));
    el.querySelector('[data-credit-issue]')?.addEventListener('click',()=>{
      const input=el.querySelector('#weatherCreditMinutes');
      if(!input.reportValidity()||!Number.isInteger(Number(input.value)))return;
      if(!el.querySelector('#weatherCreditAttest').checked){message('Confirm that the time was lost to weather and has not already been replaced.');return;}
      saveManager('issue',{minutes:Number(input.value),reason:el.querySelector('#weatherCreditReason').value});
    });
  }
  function message(text){dialog().querySelector('[data-credit-message]').textContent=text;}
  async function saveManager(action,payload){
    if(busy)return;busy=true;const seq=generation;const el=dialog();
    el.querySelectorAll('button,input,select').forEach(node=>node.disabled=true);message('Saving…');
    try{const result=await window.DB.weatherCredit(action,{bookingReference:reference,...payload});if(seq!==generation)return;renderManager(result);message(result.emailPending?'Credit saved. Email is pending; copy the code or retry delivery.':'Credit saved.');}
    catch(error){if(seq===generation)message(error.message||'Credit could not be saved.');}
    finally{busy=false;el.querySelector('[data-credit-close]').disabled=false;if(seq===generation)el.querySelectorAll('[data-credit-issue],#weatherCreditMinutes,#weatherCreditReason,#weatherCreditAttest,[data-credit-copy]').forEach(node=>node.disabled=false);const retry=el.querySelector('[data-credit-email]');if(retry&&retry.textContent==='Retry email')retry.disabled=false;}
  }
  window.PBWeatherCredit={
    async openManager(ref){
      if(busy)return;const el=dialog();reference=String(ref);returnFocus=document.activeElement;const seq=++generation;
      el.querySelector('[data-credit-body]').textContent='Loading credit details…';message('');if(!el.open)el.showModal();
      try{const result=await window.DB.weatherCredit('get',{bookingReference:reference});if(seq===generation)renderManager(result);}
      catch(error){if(seq===generation)message(error.message||'Credit could not be loaded.');}
    },
    async applyGuest(){
      const button=document.getElementById('weatherCreditApply'),status=document.getElementById('weatherCreditGuestStatus'),input=document.getElementById('weatherCreditCode');
      if(!button||button.disabled)return;
      const code=input.value.trim();if(!code){status.textContent='Enter the weather credit code from your email.';input.focus();return;}
      button.disabled=true;window.PBWeatherCreditBusy=true;status.textContent='Applying credit…';
      const next=document.getElementById('wizNextBtn');const wasDisabled=next?.disabled;if(next)next.disabled=true;
      try{await window.applyGuestWeatherCredit(code);}
      catch(error){status.textContent=error.message||'Credit could not be applied. Check your booking before retrying.';}
      finally{button.disabled=false;window.PBWeatherCreditBusy=false;if(next)next.disabled=wasDisabled;}
    },
  };
})();
