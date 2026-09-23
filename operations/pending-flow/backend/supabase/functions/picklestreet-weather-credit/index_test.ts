import assert from 'node:assert/strict';
import {handleRequest} from './index.ts';
const tenant='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
async function fixture(body:Record<string,unknown>, options:{signedIn?:boolean;foreign?:boolean;dbError?:boolean;confirmed?:boolean}={}){
 const priorFetch=globalThis.fetch;const priorUrl=Deno.env.get('SUPABASE_URL'),priorKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 Deno.env.set('SUPABASE_URL','https://weather-test.invalid');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','test-service-key');
 const calls:string[]=[];
 globalThis.fetch=async(input)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;calls.push(url);
  if(url.endsWith('/rpc/resolve_tenant_id'))return Response.json(options.foreign?null:tenant);
  if(url.endsWith('/auth/v1/user'))return Response.json({id:'11111111-1111-4111-8111-111111111111'});
  if(url.endsWith('/rpc/apply_picklestreet_weather_credit'))return options.dbError?Response.json({message:'The hold expired.',code:'22023'},{status:400}):Response.json({ok:true,status:options.confirmed?'confirmed':'pending_payment',paymentStatus:options.confirmed?'paid':'unpaid',totalAmount:options.confirmed?0:100});
  if(url.endsWith('/rpc/manage_picklestreet_weather_credit'))return Response.json({ok:true,eligible:true,credit:null});
  throw Error('Unexpected network request: '+url);
 };
 try{
  const response=await handleRequest(new Request('https://weather-test.invalid/functions/v1/picklestreet-weather-credit?tenantSlug=pickle-street-tugbok',{method:'POST',headers:{origin:'https://picklestreetcourt.com','content-type':'application/json',...(options.signedIn?{authorization:'Bearer test-user'}:{})},body:JSON.stringify({tenantSlug:'pickle-street-tugbok',bookingReference:'TEST-BOOKING',...body})}));
  return {status:response.status,data:await response.json(),calls};
 }finally{globalThis.fetch=priorFetch;if(priorUrl)Deno.env.set('SUPABASE_URL',priorUrl);else Deno.env.delete('SUPABASE_URL');if(priorKey)Deno.env.set('SUPABASE_SERVICE_ROLE_KEY',priorKey);else Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');}
}
Deno.test('weather credit denies unauthenticated management and foreign origin resolution',async()=>{
 assert.equal((await fixture({action:'get'})).status,401);
 assert.equal((await fixture({action:'get'},{foreign:true,signedIn:true})).status,403);
});
Deno.test('weather credit validates issuance minutes before calling its transaction',async()=>{
 const r=await fixture({action:'issue',minutes:1.5},{signedIn:true});assert.equal(r.status,400);assert(!r.calls.some(x=>x.includes('manage_picklestreet_weather_credit')));
});
Deno.test('weather credit returns the authoritative remaining payment and database rejection',async()=>{
 const body={action:'apply',bookingToken:'x'.repeat(43),code:'PS-RAIN-'+'A'.repeat(24)};
 const success=await fixture(body);assert.equal(success.status,200);assert.equal(success.data.totalAmount,100);
 const failed=await fixture(body,{dbError:true});assert.equal(failed.status,409);assert.match(failed.data.error.message,/expired/);
});
Deno.test('confirmed credit survives confirmation-email failure without reversing the booking',async()=>{
 const r=await fixture({action:'apply',bookingToken:'x'.repeat(43),code:'PS-RAIN-'+'A'.repeat(24)},{confirmed:true});
 assert.equal(r.status,200);assert.equal(r.data.status,'confirmed');assert.equal(r.data.emailSent,false);
});
