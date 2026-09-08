(function enhancePickleStreet() {
  'use strict';
  function showWelcome() {
    const welcome = document.getElementById('psWelcome');
    if (!welcome || typeof welcome.showModal !== 'function') return;
    // Show the welcome on each page load, including ordinary anchors and tracking links.
    // Private payment links and a checkout in progress retain their direct entry.
    try {
      if (window.readPlatformRecoveryFragment?.() || window.balancePaymentLinkAccess?.()) return;
    } catch (_) {}
    try {
      if (window.readPlatformRecovery?.() || window.readPlatformPendingDraft?.() ||
          (!window.PB_PLATFORM_V1 && window.readGuestBookingResume?.())) return;
    } catch (_) {}
    const activeFlow = () => document.querySelector('.bk-modal-overlay.active,.overlay.show,.modal-bg.show,dialog[open]:not(#psWelcome)');
    if (activeFlow()) return;
    let observer;
    const finish = (focusCourts = false) => {
      if (!welcome.open) return;
      observer?.disconnect();
      document.documentElement.classList.remove('ps-welcome-open');
      welcome.close();
      if (focusCourts && !activeFlow()) {
        const heading = document.getElementById('courtsHeading');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({preventScroll:true});
          heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), {once:true});
        }
      }
    };
    welcome.querySelectorAll('[data-welcome-dismiss]').forEach(button => button.addEventListener('click', () => finish(true)));
    welcome.querySelectorAll('[data-welcome-link]').forEach(link => link.addEventListener('click', () => finish(false)));
    welcome.addEventListener('keydown', event => event.stopPropagation());
    welcome.addEventListener('cancel', event => { event.preventDefault(); finish(true); });
    welcome.addEventListener('close', () => {
      observer?.disconnect();
      document.documentElement.classList.remove('ps-welcome-open');
    });
    observer = new MutationObserver(() => { if (activeFlow()) finish(false); });
    try {
      welcome.showModal();
      document.documentElement.classList.add('ps-welcome-open');
      observer.observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['class','open']});
    } catch (_) { observer.disconnect(); }
    window.addEventListener('hashchange', () => finish(false), {once:true});
  }
  function ready() {
    const splash = document.getElementById('splashScreen');
    if (splash) { splash.style.display='none'; splash.classList.add('dismissed'); splash.inert=true; }
    if (!document.querySelector('.bk-modal-overlay.active,.overlay.show')) document.body.style.overflow='';
    const headline=document.getElementById('navHeadline');
    if(headline) {
      headline.hidden=false;
      headline.innerHTML='<a href="#courts">Book a court</a><button class="ps-nav-button" type="button" id="psOpenPlay">Open Play</button>';
      document.getElementById('psOpenPlay').addEventListener('click',()=>window.startOpenPlayFromSplash?.());
    }
    document.querySelectorAll('.bg-grid,.bg-glow').forEach(el=>el.hidden=true);
    const scope=document.documentElement.dataset.pbDataScope;
    if(scope==='public') {
      showWelcome();
      const grid=document.getElementById('courtsGrid');
      if(grid) {
        const watch = new MutationObserver(()=>{
          if(!window.PB_PUBLIC_BOOKING_ENABLED && !grid.querySelector('.cc')) {
            const empty=grid.querySelector('.empty');
            if(empty && !empty.dataset.pickleStreet) {
              empty.dataset.pickleStreet='true';
              empty.innerHTML='<h3>We’re getting the courts ready.</h3><p>Online reservations will open once the venue publishes its courts, schedules, and payment options.</p><a class="btn btn-g" href="login.html">Venue management</a>';
            }
          }
        });
        watch.observe(grid,{childList:true,subtree:true});
      }
    }
    const context=document.modelContext;
    if(context?.registerTool && scope==='public') {
      const lifecycle=new AbortController();
      window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
      Promise.resolve(context.registerTool({
        name:'select_booking_date',title:'Choose booking date',
        description:'Select a date in the visible Pickle Street court availability view. Does not reserve a court.',
        inputSchema:{type:'object',properties:{date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}},required:['date'],additionalProperties:false},
        annotations:{readOnlyHint:false,untrustedContentHint:false},
        async execute(input) {
          if(!input || Object.keys(input).length!==1 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Choose a valid date.');
          const date=new Date(input.date+'T00:00:00Z');
          if(!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==input.date) throw new Error('Choose a valid date.');
          if(input.date < new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(new Date())) throw new Error('Choose today or a future date.');
          await window.onSharedCourtDate(input.date);
          return {date:input.date,tenant:'pickle-street-tugbok',reserved:false};
        }
      },{signal:lifecycle.signal})).catch(()=>{});
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',ready,{once:true}); else ready();
})();
