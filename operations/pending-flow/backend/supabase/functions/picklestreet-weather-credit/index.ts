import {createClient} from '@supabase/supabase-js';
import {resolveTenantForRequest} from '../_shared/tenant.ts';
import {errorResponse,jsonResponse,readJsonObject,RequestError} from '../_shared/http.ts';
import {receiptPreflightResponse} from '../picklestreet-receipts/cors.ts';
import {sendMailerooEmail} from '../_shared/maileroo.ts';

const TENANT='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
const SLUG='pickle-street-tugbok';
const env=(name:string)=>{const value=Deno.env.get(name)?.trim();if(!value)throw Error('Missing service configuration');return value;};
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export async function handleRequest(request:Request):Promise<Response>{
 let origin:string|undefined;
 try{
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  const url=new URL(request.url);
  const context=await resolveTenantForRequest(db,url.searchParams.get('tenantSlug')||SLUG,request.headers.get('origin'));
  if(context.tenantId!==TENANT||context.tenantSlug!==SLUG)throw new RequestError(403,'TENANT_DENIED','This venue is not allowed.');
  origin=context.origin;
  if(request.method==='OPTIONS')return receiptPreflightResponse(origin);
  if(request.method!=='POST')return errorResponse(405,'METHOD_NOT_ALLOWED','Use POST.',origin);
  const body=await readJsonObject(request);
  if(body.tenantSlug!==SLUG)throw new RequestError(403,'TENANT_DENIED','This venue is not allowed.');
  const reference=String(body.bookingReference||'').trim().toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(reference))throw new RequestError(400,'REFERENCE_INVALID','Enter a valid booking reference.');
  if(body.action==='apply'){
   const token=String(body.bookingToken||'');const code=String(body.code||'').trim().toUpperCase();
   if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!/^PS-RAIN-[A-F0-9]{24}$/.test(code))throw new RequestError(400,'CREDIT_INVALID','Check your private booking link and weather credit code.');
   const applied=await db.rpc('apply_picklestreet_weather_credit',{p_reference:reference,p_token:token,p_code:code});
   if(applied.error)throw new RequestError(409,'CREDIT_NOT_APPLIED',applied.error.message);
   const result=applied.data;
   if(result.status==='confirmed'){
    try{
     const email=await fetch(env('SUPABASE_URL')+'/functions/v1/picklestreet-booking-email',{method:'POST',headers:{'Content-Type':'application/json','x-internal-secret':env('EDGE_INTERNAL_SECRET')},body:JSON.stringify({tenantSlug:SLUG,bookingReference:reference,emailKind:'booking_confirmed'}),signal:AbortSignal.timeout(15000)});
     const response=await email.json();result.emailSent=email.ok&&response.ok===true;
    }catch{result.emailSent=false;}
   }
   return jsonResponse(result,200,origin);
  }
  if(!['get','issue','email'].includes(String(body.action)))throw new RequestError(400,'ACTION_INVALID','Choose a valid credit action.');
  const token=/^Bearer (\S+)$/.exec(request.headers.get('authorization')||'')?.[1];
  if(!token)throw new RequestError(401,'SIGN_IN_REQUIRED','Sign in to manage weather credits.');
  const auth=await db.auth.getUser(token);if(auth.error||!auth.data.user)throw new RequestError(401,'SIGN_IN_REQUIRED','Sign in to manage weather credits.');
  if(body.action==='issue'&&(!Number.isInteger(body.minutes)||Number(body.minutes)<=0))throw new RequestError(400,'MINUTES_INVALID','Enter the unused playing time in whole minutes.');
  const record=await db.rpc('manage_picklestreet_weather_credit',{p_reference:reference,p_actor:auth.data.user.id,p_minutes:body.action==='issue'?body.minutes:null,p_reason:body.reason||'rain'});
  if(record.error)throw new RequestError(record.error.code==='42501'?403:409,'CREDIT_UNAVAILABLE',record.error.message);
  const result=record.data;
  if(body.action==='get'||!result.credit||result.credit.emailSent)return jsonResponse(result,200,origin);
  try{
   const claimed=await db.from('picklestreet_weather_credits').update({email_attempt_at:new Date().toISOString()}).eq('tenant_id',TENANT).eq('id',result.credit.id).is('email_sent_at',null)
     .or(`email_attempt_at.is.null,email_attempt_at.lt.${new Date(Date.now()-60000).toISOString()}`).select('id');
   if(claimed.error||!claimed.data?.length)throw Error('Email pending');
   const tenant=await db.from('tenants').select('reply_to_email,contact_email').eq('id',TENANT).single();
   if(tenant.error)throw Error('Email settings unavailable');
   const code=result.credit.code;const minutes=result.credit.balanceMinutes;
   const text=`Your Pickle Street weather credit is ready: ${minutes} minutes of replacement court time. Code: ${code}. Book at https://picklestreetcourt.com using ${result.email}, then apply your code before payment. It covers replacement time on your original court(s), including its booking fee. Extra time is payable separately. Unused minutes remain on the code. No account needed. Keep your code private.`;
   await sendMailerooEmail({apiKey:env('PICKLESTREET_MAILEROO_API_KEY'),fromAddress:env('PICKLESTREET_MAILEROO_FROM_EMAIL'),fromName:'Pickle Street Tugbok',replyTo:tenant.data.reply_to_email||tenant.data.contact_email,
     to:result.email,subject:'Your Pickle Street weather credit is ready',plainText:text,
     html:`<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:28px;color:#173c42"><h1>Another day on court</h1><p>Your weather credit is ready.</p><h2>${minutes} minutes</h2><p style="font-family:monospace;word-break:break-all">${escape(code)}</p><p>${escape(text)}</p><a href="https://picklestreetcourt.com">Choose your replacement time</a></div>`});
   const saved=await db.from('picklestreet_weather_credits').update({email_sent_at:new Date().toISOString()}).eq('tenant_id',TENANT).eq('id',result.credit.id);
   if(saved.error)throw Error('Email status unavailable');result.credit.emailSent=true;
  }catch{result.emailPending=true;}
  return jsonResponse(result,200,origin);
 }catch(error){
  if(error instanceof RequestError)return errorResponse(error.status,error.code,error.message,origin);
  return errorResponse(503,'CREDIT_UNAVAILABLE','Weather credit is unavailable. Check your booking before trying again.',origin);
 }
}
if(import.meta.main)Deno.serve(handleRequest);
