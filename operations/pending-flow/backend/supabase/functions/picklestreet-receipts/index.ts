import {duplicateRejectionReason,sendDuplicateRejectionEmail} from './duplicate-rejection.ts';
import { createClient } from "@supabase/supabase-js";
import { errorResponse,jsonResponse,readJsonObject,RequestError } from "../_shared/http.ts";
import { receiptPreflightResponse } from "./cors.ts";
import { parseBookingAccessToken,verifyBookingAccessToken } from "../_shared/booking-access.ts";
import { resolveTenantForRequest } from "../_shared/tenant.ts";
import { detectReceiptText,inspectReceiptImage,parseReceiptObjectPath,RECEIPT_BUCKET,MAX_RECEIPT_BYTES,sha256Hex } from "../_shared/receipt-verification.ts";
import { originalBookingStatus } from "./status.ts";
import { originalBalanceStatus } from "./balance-status.ts";
import { verifyByMethod,publicPendingReason,PICKLESTREET_PAYMENT_WINDOW_MINUTES } from "./parsers.ts";
import { canonicalSourceProvider,verifySourceRoute } from "./source-routes.ts";
import { deliverEmail } from "../_shared/reschedule-booking.ts";
import { sendMailerooEmail } from "../_shared/maileroo.ts";
import { createSupabaseRescheduleBookingStore } from "./reschedule-store.ts";
import { createGroupEmailStore, createGroupedRescheduleEmailSender, deliverGroupedRescheduleEmail } from "../picklestreet-reschedule/email.ts";

export const TENANT_ID="f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a";
export const TENANT_SLUG="pickle-street-tugbok";
type Obj=Record<string,any>;
const obj=(value:unknown):Obj=>value && typeof value==='object' && !Array.isArray(value)?value as Obj:{};
const env=(name:string)=>{const value=Deno.env.get(name)?.trim();if(!value)throw Error('Required service configuration unavailable');return value;};
const dbClient=()=>createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
type DB=ReturnType<typeof dbClient>;
function reference(value:unknown):string{const s=String(value||'').trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(s))throw new RequestError(400,'BOOKING_REFERENCE_INVALID','Enter a valid booking reference.');return s;}
function uuid(value:unknown):string{const s=String(value||'').trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s))throw new RequestError(400,'REQUEST_ID_INVALID','Refresh the booking and try again.');return s;}
function fail(code:string,message:string,status=409):never{throw new RequestError(status,code,message);}
async function operator(db:DB,authorization:string|null):Promise<string>{
  const token=/^Bearer (\S+)$/.exec(authorization||'')?.[1];if(!token)fail('AUTHENTICATION_REQUIRED','Sign in to review this receipt.',401);
  const {data,error}=await db.auth.getUser(token!);const userId=data.user?.id;if(error||!userId)fail('AUTHENTICATION_REQUIRED','Sign in to review this receipt.',401);
  const [membership,owner]=await Promise.all([
    db.from('tenant_memberships').select('id').eq('tenant_id',TENANT_ID).eq('user_id',userId!).eq('status','active').in('role',['owner','admin','staff']).maybeSingle(),
    db.from('platform_profiles').select('user_id').eq('user_id',userId!).eq('is_platform_owner',true).maybeSingle(),
  ]);
  if(membership.error||owner.error)fail('AUTHORIZATION_UNAVAILABLE','Staff access could not be verified.',503);
  if(!membership.data&&!owner.data)fail('TENANT_ACCESS_DENIED','This account cannot manage Pickle Street receipts.',403);
  return userId!;
}
async function systemOwner(db:DB,authorization:string|null):Promise<string>{
  const token=/^Bearer (\S+)$/.exec(authorization||'')?.[1];if(!token)fail('AUTHENTICATION_REQUIRED','Sign in as System Owner to re-read this receipt.',401);
  const {data,error}=await db.auth.getUser(token!);const userId=data.user?.id;if(error||!userId)fail('AUTHENTICATION_REQUIRED','Sign in as System Owner to re-read this receipt.',401);
  const owner=await db.from('platform_profiles').select('user_id').eq('user_id',userId!).eq('is_platform_owner',true).maybeSingle();
  if(owner.error)fail('AUTHORIZATION_UNAVAILABLE','System Owner access could not be verified.',503);
  if(!owner.data)fail('SYSTEM_OWNER_REQUIRED','Only the System Owner can re-read a confirmed receipt.',403);
  return userId!;
}
async function bookingAccess(db:DB,ref:string,tokenValue:unknown,balanceId:string|null=null):Promise<Obj>{
  const token=parseBookingAccessToken(tokenValue);
  const {data:booking,error}=await db.from('bookings').select('id,reference,status,payment_status,metadata').eq('tenant_id',TENANT_ID).eq('reference',ref).single();
  if(error||!booking)fail('BOOKING_ACCESS_DENIED','The private booking access is invalid.',401);
  const access=balanceId
    ? await db.from('booking_balance_requests').select('token_hash').eq('tenant_id',TENANT_ID).eq('booking_id',booking!.id).eq('id',balanceId).single()
    : await db.from('booking_access_tokens').select('token_hash').eq('tenant_id',TENANT_ID).eq('booking_id',booking!.id).gt('expires_at',new Date().toISOString()).single();
  if(access.error||!access.data)fail('BOOKING_ACCESS_DENIED','The private booking access is invalid or expired.',401);
  await verifyBookingAccessToken({token,expectedHash:access.data!.token_hash});return booking!;
}
async function balanceStatusResponse(request:Request,db:DB,body:Obj,origin:string):Promise<Response>{
  const balanceId=uuid(body.balanceRequestId);
  const original=await originalBalanceStatus(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({tenantSlug:TENANT_SLUG,balanceRequestId:balanceId,balanceToken:body.balanceToken})}));
  if(!original.ok)return original;
  const result=await original.json();
  const fresh=await db.from('booking_balance_requests').select('id,booking_id,status,request_type,request_details,deadline_at').eq('tenant_id',TENANT_ID).eq('id',balanceId).single();
  if(fresh.error||!fresh.data)fail('STATUS_UNAVAILABLE','The additional payment status could not be refreshed.',503);
  const swept=await db.rpc('expire_picklestreet_balance_receipt_holds',{p_booking_id:fresh.data!.booking_id});
  if(swept.error)fail('STATUS_UNAVAILABLE','Court availability could not be refreshed. The payment remains pending.',503);
  const [job,receipt,session,slots]=await Promise.all([
    db.from('picklestreet_balance_receipt_jobs').select('balance_request_id').eq('tenant_id',TENANT_ID).eq('balance_request_id',balanceId).maybeSingle(),
    db.from('receipt_verifications').select('status,flags').eq('tenant_id',TENANT_ID).eq('balance_request_id',balanceId).order('created_at',{ascending:false}).limit(1).maybeSingle(),
    db.from('payment_sessions').select('provider_payload').eq('tenant_id',TENANT_ID).eq('booking_id',fresh.data!.booking_id).eq('provider','manual_balance_receipt').contains('provider_payload',{balanceRequestId:balanceId}).order('created_at',{ascending:false}).limit(1).maybeSingle(),
    db.from('booking_slots').select('status,hold_expires_at,balance_request_id').eq('tenant_id',TENANT_ID).eq('booking_id',fresh.data!.booking_id),
  ]);
  if(job.error||receipt.error||session.error||slots.error)fail('STATUS_UNAVAILABLE','The additional payment status could not be refreshed.',503);
  const balance=fresh.data!;
  const flow=!!job.data;
  const pending=flow && !!receipt.data && ['pending','manual_review'].includes(receipt.data.status) && balance.status!=='settled';
  const relevant=(slots.data||[]).filter(s=>balance.request_type==='reschedule_adjustment'?s.balance_request_id===balanceId:!s.balance_request_id);
  const held=relevant.length>0 && relevant.every(s=>s.status==='confirmed'||(s.status==='held'&&new Date(s.hold_expires_at).getTime()>Date.now()));
  result.balance={...result.balance,status:balance.status==='settled'?'settled':pending?'payment_review':result.balance.status,
    receiptFlow:flow?'picklestreet_pending_balance_v1':null,receiptPending:pending,canSubmitReceipt:pending||(!receipt.data&&balance.status==='awaiting_payment'&&new Date(balance.deadline_at).getTime()>Date.now()),
    reservationHeld:held,reservationStatus:balance.status,deadlineAt:balance.deadline_at,
    paymentMethod:obj(session.data?.provider_payload).paymentMethod||'',submittedReference:obj(session.data?.provider_payload).submittedReference||'',
    publicReason:pending?publicPendingReason(receipt.data?.flags||[],''):'',
  };
  return jsonResponse(result,200,origin);
}
async function statusResponse(request:Request,db:DB,body:Obj,origin:string):Promise<Response>{
  const original=await originalBookingStatus(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify({tenantSlug:TENANT_SLUG,bookingReference:body.bookingReference,bookingToken:body.bookingToken})}));
  if(!original.ok)return original;
  const result=await original.json();
  const {data:booking,error}=await db.from('bookings').select('id,metadata,status,payment_status,expires_at,payment_sessions(provider_payload,created_at),receipt_verifications(id,status,flags,created_at,balance_request_id),booking_slots(status,hold_expires_at,balance_request_id)').eq('tenant_id',TENANT_ID).eq('reference',reference(body.bookingReference)).single();
  if(error||!booking)fail('STATUS_UNAVAILABLE','Booking status could not be refreshed.',503);
  const metadata=obj(booking!.metadata);
  if(metadata.duplicateReferenceRejected===true)await sendDuplicateRejectionEmail(db,booking!.id);
  const upload=await db.from('picklestreet_receipt_attempts').select('idempotency_key').eq('tenant_id',TENANT_ID).eq('booking_id',booking!.id).in('action',['upload','replace']).order('version',{ascending:false}).limit(1).maybeSingle();
  if(upload.error)fail('STATUS_UNAVAILABLE','Receipt upload status could not be refreshed.',503);
  const receipt=[...(booking!.receipt_verifications||[])].filter(r=>!r.balance_request_id).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
  const session=[...(booking!.payment_sessions||[])].sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
  const flow=metadata.receiptFlow || null;
  const pending=!!receipt && ['payment_review','expired','pending_payment'].includes(booking!.status) && booking!.payment_status==='pending';
  const slots=(booking!.booking_slots||[]).filter(s=>!s.balance_request_id);
  const held=slots.length>0&&slots.every(s=>s.status==='confirmed'||(s.status==='held'&&new Date(s.hold_expires_at).getTime()>Date.now()));
  const flags=receipt?.flags||[];
  result.booking={...result.booking,receiptUploadRequestId:upload.data?.idempotency_key||null,receiptFlow:flow,receiptPending:pending,reservationHeld:held,reservationStatus:booking!.status,
    status:pending?'payment_review':result.booking.status,
    canSubmitReceipt:pending && !!flow && ['manual_review','pending'].includes(receipt?.status),
    paymentMethod:obj(session?.provider_payload).paymentMethod||'',submittedReference:obj(session?.provider_payload).submittedReference||'',
    publicReason:metadata.duplicateReferenceRejected===true?duplicateRejectionReason:pending?publicPendingReason(flags,String(metadata.receiptPendingReason||'')):'',
  };
  return jsonResponse(result,200,origin);
}
async function readImage(request:Request):Promise<{bytes:Uint8Array;type:string;extension:string}>{
  const limit=MAX_RECEIPT_BYTES+128*1024;
  if(Number(request.headers.get('content-length')||0)>limit)fail('RECEIPT_TOO_LARGE','Use a receipt image under 8 MB.',413);
  const reader=request.body?.getReader();if(!reader)fail('RECEIPT_REQUIRED','Choose a receipt image.',400);
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader!.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader!.cancel();fail('RECEIPT_TOO_LARGE','Use a receipt image under 8 MB.',413);}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();
  const file=form.get('receiptFile');if(!(file instanceof File)||file.size===0||file.size>MAX_RECEIPT_BYTES)fail('RECEIPT_REQUIRED','Choose a receipt image under 8 MB.',400);
  const type=file.type.toLowerCase();const extension=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'} as Obj)[type];
  if(!extension)fail('IMAGE_TYPE_UNSUPPORTED','Use a JPEG, PNG, or WebP receipt.',415);
  return {bytes:new Uint8Array(await file.arrayBuffer()),type,extension};
}
export async function paymentReceiptContext(db:DB,paymentMethod:string):Promise<Obj>{
  const source=await db.from('tenant_payment_methods').select('account_name,account_reference').eq('tenant_id',TENANT_ID).eq('method_code',paymentMethod).eq('is_active',true).maybeSingle();
  if(source.error||!source.data)fail('PAYMENT_METHOD_UNAVAILABLE','The selected payment method is no longer available.');
  const tenant=await db.from('tenants').select('public_config').eq('id',TENANT_ID).single();
  if(tenant.error||!tenant.data)fail('PAYMENT_SETTINGS_UNAVAILABLE','Payment settings could not be checked.',503);
  const config=obj(tenant.data.public_config),provider=canonicalSourceProvider(paymentMethod);
  if(!provider)return {source:source.data,receiver:source.data,config,route:null,
    snapshot:{method:paymentMethod,name:source.data.account_name,account:source.data.account_reference}};
  const [destination,privateSettings]=await Promise.all([
    db.from('tenant_payment_methods').select('account_name,account_reference').eq('tenant_id',TENANT_ID).eq('method_code','gcash').maybeSingle(),
    db.from('picklestreet_receipt_route_settings').select('gcash_qr_alias,gcash_qr_token,revision').eq('tenant_id',TENANT_ID).maybeSingle(),
  ]);
  if(destination.error||privateSettings.error||!destination.data)fail('PAYMENT_SETTINGS_UNAVAILABLE','The shared GCash recipient could not be checked.',503);
  if(source.data.account_name!==destination.data.account_name||source.data.account_reference!==destination.data.account_reference)
    fail('PAYMENT_DESTINATION_CHANGED','The receiving account changed. Staff needs to review this receipt.');
  const receiver=destination.data,settings=privateSettings.data;
  return {source:source.data,receiver,config,route:{tenantId:TENANT_ID,tenantSlug:TENANT_SLUG,
    sourceProvider:provider,destinationProvider:'gcash',destinationMethodCode:'gcash',enabled:true,
    autoApprovalEnabled:config.bookingApprovalMode!=='manual',gcashQrAlias:settings?.gcash_qr_alias||'',gcashQrToken:settings?.gcash_qr_token||''},
    snapshot:{method:paymentMethod,name:receiver.account_name,account:receiver.account_reference,destinationMethod:'gcash',verificationSettingsRevision:Number(settings?.revision||0)}};
}

export async function reconcileDuplicateRejection(db:DB,result:Obj,balanceId:string|null=null):Promise<Obj>{
  if(balanceId || !result.attemptId)return result;
  try{
    // The RPC checks that this is still the current completed initial attempt.
    // Replaying it also repairs an interruption between saving OCR and rejection.
    const rejected=await db.rpc('reject_picklestreet_duplicate',{p_attempt_id:result.attemptId});
    if(!rejected.error && rejected.data?.rejected===true){
      const final={...result,...rejected.data};
      final.rejectionEmail=await sendDuplicateRejectionEmail(db,final.bookingId).catch(()=>'pending');
      return final;
    }
  }catch{
    // A failed check cannot become a rejection. The saved result remains valid
    // and another replay can safely retry the database decision.
  }
  return result;
}

async function analyzeReceipt(db:DB,job:Obj,bytes:Uint8Array,type:string):Promise<Obj>{
  let extracted:unknown=null,flags:string[]=[],paymentReference:string|null=null,confidence:number|null=null,autoApprove=false,errorCode:string|null=null,receiverSnapshot:Obj|null=null;
  try {
    const context=await paymentReceiptContext(db,job.paymentMethod);
    receiverSnapshot=context.snapshot;
    const image=inspectReceiptImage(bytes,parseReceiptObjectPath(job.storagePath),type,type);
    const apiKey=env('GOOGLE_VISION_API_KEY');
    const vision=await detectReceiptText({bytes,apiKey});
    const input={vision,image,expectedAmount:Number(job.expectedAmount),currency:job.currency,
      payment:{paymentMethod:job.paymentMethod,submittedReference:job.submittedReference,receiverName:context.receiver.account_name,receiverReference:context.receiver.account_reference,autoApprovalEnabled:context.config.bookingApprovalMode!=='manual'},
      timing:{bookingStartedAt:job.bookingStartedAt,tenantTimezone:job.tenantTimezone}};
    let result=context.route ? verifySourceRoute({...input,route:context.route}) : verifyByMethod(input);
    // Dense GCash screenshots can occasionally lose one prominent amount in
    // document-layout OCR. Retry with Google's independent sparse-text mode,
    // but use it only when that complete second result passes every existing
    // verification rule. Never merge partial evidence between OCR passes.
    if(
      String(job.paymentMethod||'').toLowerCase()==='gcash' &&
      result.flags.includes('amount_confirmation_unreadable')
    ){
      const alternateVision=await detectReceiptText({bytes,apiKey,feature:'TEXT_DETECTION'});
      const alternateInput={...input,vision:alternateVision};
      const alternate=context.route ? verifySourceRoute({...alternateInput,route:context.route}) : verifyByMethod(alternateInput);
      if(alternate.autoApprove){
        (alternate.extractedData as Obj).ocrFallbackReason='GCash amount rows confirmed by a second text-reading pass';
        result=alternate;
      }
    }
    extracted=result.extractedData;flags=result.flags;paymentReference=result.paymentReference;confidence=result.extractedData.confidence.effective;autoApprove=result.autoApprove;
  } catch(error){errorCode=error instanceof RequestError?error.code.toLowerCase():'verifier_unavailable';flags=['verification_unavailable'];}
  return {extracted,flags,paymentReference,confidence,autoApprove,errorCode,receiverSnapshot};
}
async function verificationResult(db:DB,job:Obj,bytes:Uint8Array,type:string,finishRpc='finish_picklestreet_receipt_attempt'):Promise<Obj>{
  const analysis=await analyzeReceipt(db,job,bytes,type);
  const finished=await db.rpc(finishRpc,{p_attempt_id:job.attemptId,p_lease_token:job.leaseToken,p_extracted_data:analysis.extracted,p_flags:analysis.flags,p_payment_reference:analysis.paymentReference,p_confidence:analysis.confidence,p_auto_approve:analysis.autoApprove,p_error_code:analysis.errorCode,p_receiver_snapshot:analysis.receiverSnapshot});
  if(finished.error||!finished.data)fail('VERIFICATION_PENDING','Your receipt is saved. Verification has not completed; check booking status before retrying.',503);
  const result=obj(finished.data);
  return finishRpc==='finish_picklestreet_receipt_attempt' ? await reconcileDuplicateRejection(db,result) : result;
}
export function confirmedReceiptRereadAllowed(booking:Obj,receipt:Obj):boolean{
  return booking.status==='confirmed' && booking.payment_status==='paid' &&
    receipt.booking_id===booking.id && receipt.balance_request_id==null &&
    ['approved','auto_approved'].includes(String(receipt.status||'')) && !!receipt.storage_path;
}
async function confirmedRereadResponse(request:Request,db:DB,body:Obj,origin:string):Promise<Response>{
  const actor=await systemOwner(db,request.headers.get('authorization'));
  const ref=reference(body.bookingReference),verificationId=uuid(body.verificationId),requestId=uuid(body.idempotencyKey);
  const existing=await db.from('audit_events').select('new_data').eq('tenant_id',TENANT_ID)
    .eq('action','receipt.confirmed_reread').eq('entity_table','receipt_verifications').eq('entity_id',verificationId)
    .eq('request_id',requestId).order('occurred_at',{ascending:false}).limit(1).maybeSingle();
  if(existing.error)fail('REREAD_UNAVAILABLE','The previous re-read could not be checked.',503);
  if(existing.data?.new_data)return jsonResponse({ok:true,...obj(existing.data.new_data),idempotent:true},200,origin);
  const bookingResult=await db.from('bookings').select('id,reference,status,payment_status,total_amount,created_at').eq('tenant_id',TENANT_ID).eq('reference',ref).single();
  if(bookingResult.error||!bookingResult.data)fail('BOOKING_NOT_FOUND','The booking was not found.',404);
  const booking=obj(bookingResult.data);
  const receiptResult=await db.from('receipt_verifications').select('id,booking_id,balance_request_id,status,storage_path,file_sha256,expected_amount,payment_session_id')
    .eq('tenant_id',TENANT_ID).eq('id',verificationId).eq('booking_id',booking.id).single();
  if(receiptResult.error||!receiptResult.data)fail('RECEIPT_NOT_FOUND','The confirmed receipt was not found.',404);
  const receipt=obj(receiptResult.data);
  if(!confirmedReceiptRereadAllowed(booking,receipt))fail('CONFIRMED_RECEIPT_REQUIRED','Only a paid, confirmed booking receipt can be re-read.',409);
  const [attemptResult,sessionResult]=await Promise.all([
    db.from('picklestreet_receipt_attempts').select('payment_method,submitted_reference,storage_path,file_sha256').eq('tenant_id',TENANT_ID).eq('receipt_id',verificationId).order('version',{ascending:false}).limit(1).maybeSingle(),
    receipt.payment_session_id?db.from('payment_sessions').select('provider_payload').eq('tenant_id',TENANT_ID).eq('id',receipt.payment_session_id).maybeSingle():Promise.resolve({data:null,error:null}),
  ]);
  if(attemptResult.error||sessionResult.error)fail('REREAD_UNAVAILABLE','The saved receipt context could not be loaded.',503);
  const attempt=obj(attemptResult.data),payload=obj(sessionResult.data?.provider_payload);
  const storagePath=String(receipt.storage_path||attempt.storage_path||'');
  const paymentMethod=String(attempt.payment_method||payload.paymentMethod||'').toLowerCase();
  if(!storagePath||!paymentMethod)fail('REREAD_UNAVAILABLE','The saved receipt context is incomplete.',409);
  const downloaded=await db.storage.from(RECEIPT_BUCKET).download(storagePath);
  if(downloaded.error||!downloaded.data)fail('REREAD_UNAVAILABLE','The saved receipt image could not be loaded.',503);
  const bytes=new Uint8Array(await downloaded.data.arrayBuffer()),expectedHash=String(receipt.file_sha256||attempt.file_sha256||'').toLowerCase();
  if(expectedHash && await sha256Hex(bytes)!==expectedHash)fail('RECEIPT_FILE_CHANGED','The saved receipt image no longer matches its protected record.',409);
  const analysis=await analyzeReceipt(db,{
    storagePath,paymentMethod,submittedReference:String(attempt.submitted_reference||payload.submittedReference||''),
    expectedAmount:Number(receipt.expected_amount??booking.total_amount),currency:'PHP',bookingStartedAt:booking.created_at,tenantTimezone:'Asia/Manila',
  },bytes,downloaded.data.type);
  const reread={checkedAt:new Date().toISOString(),autoVerified:analysis.autoApprove===true&&!analysis.errorCode,
    flags:analysis.flags,extractedData:analysis.extracted||{},paymentReference:analysis.paymentReference,
    confidence:analysis.confidence,errorCode:analysis.errorCode};
  const saved={reread,bookingStatus:booking.status,paymentStatus:booking.payment_status,bookingReference:booking.reference};
  const audit=await db.from('audit_events').insert({tenant_id:TENANT_ID,actor_user_id:actor,actor_role:'owner',action:'receipt.confirmed_reread',
    entity_table:'receipt_verifications',entity_id:verificationId,request_id:requestId,new_data:saved,
    metadata:{requestId,bookingReference:booking.reference,confirmedStatePreserved:true}});
  if(audit.error)fail('REREAD_AUDIT_FAILED','The receipt was checked, but its protected audit record could not be saved. Please try again.',503);
  return jsonResponse({ok:true,...saved},200,origin);
}
async function sendConfirmation(db:DB,result:Obj):Promise<void>{
  if(result.balanceRequestId && !(['auto_approved','approved'].includes(result.status)&&result.balanceStatus==='settled'))return;
  if(result.bookingStatus!=='confirmed'||result.paymentStatus!=='paid')return;
  try {
    if(result.requestType==='reschedule_adjustment'){
      if(!result.rescheduleEventId)return;
      const groupEvent=await db.from('picklestreet_group_reschedule_events').select('booking_id').eq('tenant_id',TENANT_ID).eq('event_id',result.rescheduleEventId).maybeSingle();
      if(groupEvent.error)throw new Error('Reschedule notification unavailable');
      if(groupEvent.data){
        const delivered=await deliverGroupedRescheduleEmail({store:createGroupEmailStore(db),sender:createGroupedRescheduleEmailSender(),eventId:result.rescheduleEventId,bookingId:groupEvent.data.booking_id});
        result.confirmationEmail=delivered.status;return;
      }
      const store=createSupabaseRescheduleBookingStore({db,supabaseUrl:env('SUPABASE_URL'),anonKey:env('SUPABASE_ANON_KEY'),bookingAccessTokenSecret:env('BOOKING_ACCESS_TOKEN_SECRET')});
      const delivered=await deliverEmail({store,tenantId:TENANT_ID,eventId:result.rescheduleEventId,forceResend:false,sender:{async send(message){return await sendMailerooEmail({apiKey:env('PICKLESTREET_MAILEROO_API_KEY'),fromAddress:env('PICKLESTREET_MAILEROO_FROM_EMAIL'),fromName:message.fromName,replyTo:message.replyTo,replyToName:message.replyToName,to:message.to,toName:message.toName,subject:message.subject,html:message.html,plainText:message.plainText,referenceId:message.referenceId,tags:message.tags});}}});
      result.confirmationEmail=delivered.status;return;
    }
    const r=await fetch(env('SUPABASE_URL')+'/functions/v1/picklestreet-booking-email',{method:'POST',headers:{'Content-Type':'application/json','x-internal-secret':env('EDGE_INTERNAL_SECRET')},body:JSON.stringify({tenantSlug:TENANT_SLUG,bookingReference:result.bookingReference,emailKind:'booking_confirmed'}),signal:AbortSignal.timeout(15000)});
    const sent=await r.json().catch(()=>({}));result.confirmationEmail=r.ok&&sent.ok===true?'sent':'pending';
  }catch(_){result.confirmationEmail='pending';}
}
export function receiptSubmissionResult(result:Obj,balanceId:string|null=null):Obj{
  // Replayed requests return the saved database statuses, without the transient
  // `rejected` flag added by the first duplicate-rejection call.
  const rejected=!balanceId && result.bookingStatus==='cancelled' && result.paymentStatus==='rejected';
  const duplicate=rejected && (result.rejected===true || (result.flags||[]).includes('duplicate_payment_reference'));
  const passed=balanceId
    ? result.status==='auto_approved' && result.balanceStatus==='settled'
    : result.bookingStatus==='confirmed' && result.paymentStatus==='paid';
  return {...result,...(rejected?{rejected:true,status:'rejected'}:{}),publicReason:duplicate
    ? duplicateRejectionReason
    : rejected ? 'Your booking has been cancelled. Please contact Pickle Street Tugbok if you believe this is a mistake.'
    : passed ? balanceId ? 'Your additional payment is verified. The booking update is complete.' : 'All payment checks passed. Your booking is confirmed.'
    : publicPendingReason(result.flags||[],result.errorCode||'verification_processing')};
}
export function receiptApprovalTiming(booking:Obj,requestDetails:Obj|null=null,now=Date.now()):boolean{
  if(booking.checked_in_at||['completed','cancelled','void'].includes(booking.status))return false;
  if(requestDetails?.groupRescheduleV1===true){
    if(booking.status!=='confirmed'||booking.payment_status!=='paid')return false;
    const ids=obj(requestDetails.quote).changedSessionIds;
    const sessions=requestDetails.proposedSessions;
    if(!Array.isArray(ids)||!ids.length||!Array.isArray(sessions))return false;
    const uniqueIds=new Set(ids);
    if(uniqueIds.size!==ids.length)return false;
    return ids.every(id=>{
      const matches=sessions.filter(session=>obj(session).sessionId===id);
      return matches.length===1&&Date.parse(String(obj(matches[0]).startsAt||''))>now;
    });
  }
  return Date.parse(String(booking.starts_at||''))>now;
}
export function receiptRecipientDiagnostics(extracted:unknown):Obj{
  // The shared manager projection intentionally omits route evidence. Expose
  // only these observed fields to authorized Pickle Street reviewers.
  const route=obj(obj(obj(extracted).detected).route);
  const recipient=obj(route.recipient);
  const observed=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max)||null:null;
  return {
    observedName:observed(recipient.observedName,160),
    observedNumber:observed(recipient.observedNumber,80),
    nameMatch:observed(recipient.nameMatch,40),
    phoneMatch:observed(recipient.phoneMatch,40),
    recipientMatched:typeof route.recipientMatched==='boolean'?route.recipientMatched:null,
  };
}
export async function staffReviewResponse(db:DB,body:Obj,actor:string,origin:string):Promise<Response>{
  const verificationId=uuid(body.verificationId);
  const bookingReference=reference(body.bookingReference);
  const receipt=await db.from('receipt_verifications').select('id,booking_id,balance_request_id,status,storage_path,extracted_data')
    .eq('tenant_id',TENANT_ID).eq('id',verificationId).maybeSingle();
  if(receipt.error)fail('REVIEW_UNAVAILABLE','Receipt details could not be loaded. Please try again.',503);
  if(!receipt.data)fail('RECEIPT_NOT_FOUND','The receipt is not available for this venue.',404);
  const booking=await db.from('bookings').select('id,reference,status,payment_status,starts_at,checked_in_at').eq('tenant_id',TENANT_ID)
    .eq('id',receipt.data!.booking_id).eq('reference',bookingReference).maybeSingle();
  if(booking.error||!booking.data)fail('RECEIPT_NOT_FOUND','The receipt does not match this booking.',404);
  if(body.action==='receipt_diagnostics'){
    return jsonResponse({ok:true,verificationId,...receiptRecipientDiagnostics(receipt.data!.extracted_data)},200,origin);
  }
  if(body.action==='review_context'){
    if(!['pending','manual_review'].includes(receipt.data!.status)||!receipt.data!.storage_path)fail('RECEIPT_NOT_PENDING','This receipt is no longer awaiting review. Refresh the booking.');
    const balanceId=receipt.data!.balance_request_id;
    const job=await db.from(balanceId?'picklestreet_balance_receipt_jobs':'picklestreet_receipt_jobs')
      .select('receipt_id,current_attempt_id').eq('tenant_id',TENANT_ID)
      .eq(balanceId?'balance_request_id':'booking_id',balanceId||receipt.data!.booking_id).maybeSingle();
    if(job.error||!job.data?.current_attempt_id||job.data.receipt_id!==verificationId)fail('REVIEW_UNAVAILABLE','Run Retry verification first, then reopen this receipt.');
    let requestDetails:Obj|null=null;
    if(balanceId){
      const balance=await db.from('booking_balance_requests').select('request_details').eq('tenant_id',TENANT_ID).eq('booking_id',booking.data!.id).eq('id',balanceId).maybeSingle();
      if(balance.error||!balance.data)fail('REVIEW_UNAVAILABLE','The additional-payment schedule could not be verified. Reload this receipt.',503);
      requestDetails=obj(balance.data.request_details);
    }
    const canApprove=receiptApprovalTiming(booking.data!,requestDetails);
    return jsonResponse({ok:true,verificationId,attemptId:job.data.current_attempt_id,balanceRequestId:balanceId||null,
      bookingReference,paymentWindowMinutes:PICKLESTREET_PAYMENT_WINDOW_MINUTES,canApprove,
      approvalUnavailableReason:canApprove?'':requestDetails?.groupRescheduleV1===true?'The proposed sessions or booking status no longer allow approval. Refresh the booking before reviewing payment.':'This court time has already started or the booking is no longer eligible for payment confirmation.'},200,origin);
  }
  const decision=String(body.decision||'');
  const note=String(body.note||'').trim();
  if(!['approve','reject'].includes(decision)||note.length>1000||(decision==='reject'&&note.length<3))fail('REVIEW_INVALID','Choose Confirm or Reject and provide a rejection reason of 3–1000 characters.',400);
  const reviewed=await db.rpc('review_picklestreet_pending_receipt',{
    p_verification_id:verificationId,p_expected_attempt_id:uuid(body.expectedAttemptId),p_idempotency_key:uuid(body.idempotencyKey),
    p_decision:decision,p_review_note:note,p_actor_user_id:actor,
  });
  if(reviewed.error){
    const message=String(reviewed.error.message||'');
    if(/stale|changed|attempt|already|pending|idempotency/i.test(message))fail('RECEIPT_CHANGED','This receipt changed or was already reviewed. Reload its details before deciding.');
    if(/slot|court|overlap|blocked|unavailable|23P01/i.test(message+' '+reviewed.error.code))fail('COURT_UNAVAILABLE','The court time is no longer available. The payment decision was not saved.');
    if(/started|past|time/i.test(message))fail('BOOKING_STARTED','This booking time has already started. The payment decision was not saved.');
    if(/access|actor|auth|permission/i.test(message))fail('REVIEW_ACCESS_DENIED','This account cannot review this payment.',403);
    fail('REVIEW_NOT_SAVED','The payment decision could not be saved. Refresh the booking and try again.');
  }
  const result=obj(reviewed.data);
  if(decision==='approve')await sendConfirmation(db,result);
  return jsonResponse({ok:true,...result},200,origin);
}

export async function handleRequest(request:Request):Promise<Response>{
  let origin:string|undefined;
  try {
    if(!['POST','OPTIONS'].includes(request.method))return errorResponse(405,'METHOD_NOT_ALLOWED','Use POST.',origin);
    if(request.headers.has('x-internal-secret'))fail('INTERNAL_CREDENTIAL_DENIED','Internal credentials are not accepted here.',403);
    const url=new URL(request.url);
    const slug=url.searchParams.get('tenantSlug')||request.headers.get('x-tenant-slug');
    if(slug!==TENANT_SLUG)fail('TENANT_ACCESS_DENIED','This endpoint serves Pickle Street only.',403);
    const db=dbClient();const context=await resolveTenantForRequest(db,slug,request.headers.get('origin'));
    if(context.tenantId!==TENANT_ID)fail('TENANT_ACCESS_DENIED','The venue identity could not be verified.',403);
    origin=context.origin;if(request.method==='OPTIONS')return receiptPreflightResponse(origin);
    const isJson=request.headers.get('content-type')?.toLowerCase().startsWith('application/json');
    const body=isJson?await readJsonObject(request,4096):{};
    if(body.tenantSlug && body.tenantSlug!==TENANT_SLUG)fail('TENANT_ACCESS_DENIED','The venue identity could not be verified.',403);
    if(body.action==='status')return await statusResponse(request,db,body,origin);
    if(body.action==='balance_status')return await balanceStatusResponse(request,db,body,origin);
    if(body.action==='reread_confirmed')return await confirmedRereadResponse(request,db,body,origin);
    if(body.action==='review_context'||body.action==='review'||body.action==='receipt_diagnostics'){
      const actor=await operator(db,request.headers.get('authorization'));
      return await staffReviewResponse(db,body,actor,origin);
    }
    const action=isJson?String(body.action||''):'upload';
    if(!['retry','upload'].includes(action))fail('ACTION_INVALID','This receipt action is unavailable.',400);
    const balanceValue=isJson?body.balanceRequestId:request.headers.get('x-balance-request');
    const balanceId=balanceValue?uuid(balanceValue):null;
    const finishRpc=balanceId?'finish_picklestreet_balance_receipt_attempt':'finish_picklestreet_receipt_attempt';
    const attemptsTable=balanceId?'picklestreet_balance_receipt_attempts':'picklestreet_receipt_attempts';
    const jobsTable=balanceId?'picklestreet_balance_receipt_jobs':'picklestreet_receipt_jobs';
    const scopeColumn=balanceId?'balance_request_id':'booking_id';
    const ref=reference(isJson?body.bookingReference:request.headers.get('x-booking-reference'));
    const key=uuid(isJson?body.idempotencyKey:request.headers.get('x-idempotency-key'));
    let actor:string|null=null,booking:Obj;
    if(action==='retry'){
      actor=await operator(db,request.headers.get('authorization'));
      const result=await db.from('bookings').select('id').eq('tenant_id',TENANT_ID).eq('reference',ref).single();
      if(result.error||!result.data)fail('BOOKING_NOT_FOUND','The booking was not found.',404);booking=result.data!;
    }else booking=await bookingAccess(db,ref,request.headers.get('x-booking-token'),balanceId);
    const scopeId=balanceId||booking.id;
    const previous=await db.from(attemptsTable).select('id').eq('tenant_id',TENANT_ID).eq(scopeColumn,scopeId).eq('idempotency_key',key).maybeSingle();
    if(previous.error)fail('VERIFIER_UNAVAILABLE','Receipt checks are unavailable. Please try again shortly.',503);
    if(!previous.data){
      const recent=await db.from(attemptsTable).select('id',{count:'exact',head:true}).eq('tenant_id',TENANT_ID).eq(scopeColumn,scopeId).neq('action','legacy_snapshot').gt('created_at',new Date(Date.now()-30000).toISOString());
      const lease=await db.from(jobsTable).select('lease_until').eq('tenant_id',TENANT_ID).eq(scopeColumn,scopeId).maybeSingle();
      if(recent.error||lease.error)fail('VERIFIER_UNAVAILABLE','Receipt checks are unavailable. Please try again shortly.',503);
      if((recent.count||0)>0 || (lease.data?.lease_until && new Date(lease.data.lease_until).getTime()>Date.now()))fail('RETRY_LATER','A receipt check was just attempted. Wait a minute and refresh before retrying.',429);
    }
    let bytes:Uint8Array|undefined,type='',storagePath:string|null=null,fileSha:string|null=null,method:string|null=null,submitted:string|null=null;
    if(action==='upload'){
      method=String(request.headers.get('x-payment-method')||'').trim().toLowerCase();
      if(!['gcash','maya','bdo','bdo_pay','bdopay','bpi','gotyme','maribank','pnb'].includes(method))fail('PAYMENT_METHOD_UNAVAILABLE','Choose an available payment method.',400);
      submitted=String(request.headers.get('x-payment-reference')||'').trim().toUpperCase();
      if(submitted && !/^[A-Z0-9][A-Z0-9 -]{5,63}$/.test(submitted))fail('PAYMENT_REFERENCE_INVALID','Enter the transaction reference from your receipt.',400);
      const image=await readImage(request);bytes=image.bytes;type=image.type;
      storagePath=`${TENANT_ID}/receipts/${booking.id}/${key}.${image.extension}`;
      inspectReceiptImage(bytes,parseReceiptObjectPath(storagePath),type,type);
      fileSha=await sha256Hex(bytes);
      const upload=await db.storage.from(RECEIPT_BUCKET).upload(storagePath,bytes,{contentType:type,upsert:false});
      if(upload.error){
        const existing=await db.storage.from(RECEIPT_BUCKET).download(storagePath);
        if(existing.error||!existing.data||await sha256Hex(new Uint8Array(await existing.data.arrayBuffer()))!==fileSha)fail('UPLOAD_FAILED','The receipt could not be saved. Try again with the same image.',503);
      }
    }
    const claimed=await db.rpc(balanceId?'begin_picklestreet_balance_receipt_attempt':'begin_picklestreet_receipt_attempt',{p_booking_id:booking.id,...(balanceId?{p_balance_request_id:balanceId}:{}),p_action:action,p_idempotency_key:key,p_storage_path:storagePath,p_file_sha256:fileSha,p_payment_method:method,p_submitted_reference:submitted,p_actor_user_id:actor});
    if(claimed.error||!claimed.data){
      const message=claimed.error?.message||'';
      if(/rate|cooldown|too_many|busy|progress/i.test(message))fail('RETRY_LATER','A receipt check is already running or was just attempted. Wait a minute and refresh before retrying.',429);
      fail('RECEIPT_PENDING','This receipt cannot be changed right now. Refresh the booking to see its current status.',409);
    }
    const job=obj(claimed.data);
    if(job.busy)fail('RETRY_LATER','A receipt check is running. Wait a minute and refresh before retrying.',429);
    if(!job.claimed){
      const result=await reconcileDuplicateRejection(db,obj(job.result || job),balanceId);
      await sendConfirmation(db,result);
      return jsonResponse({ok:true,...receiptSubmissionResult(result,balanceId)},200,origin);
    }
    if(!bytes){
      const downloaded=await db.storage.from(RECEIPT_BUCKET).download(job.storagePath);
      if(downloaded.error||!downloaded.data){
        const finished=await db.rpc(finishRpc,{p_attempt_id:job.attemptId,p_lease_token:job.leaseToken,p_flags:['receipt_object_unavailable'],p_error_code:'receipt_object_unavailable'});
        if(finished.error)fail('VERIFICATION_PENDING','The receipt remains pending. Its image could not be loaded.',503);
        return jsonResponse({ok:true,...obj(finished.data),publicReason:'Pending — the receipt image could not be loaded. Please upload it again.'},200,origin);
      }
      bytes=new Uint8Array(await downloaded.data.arrayBuffer());type=downloaded.data.type;
      if(await sha256Hex(bytes)!==job.fileSha256){
        const finished=await db.rpc(finishRpc,{p_attempt_id:job.attemptId,p_lease_token:job.leaseToken,p_error_code:'receipt_file_changed'});
        if(finished.error)fail('VERIFICATION_PENDING','The stored image could not be verified. Your receipt remains pending.',503);
        return jsonResponse({ok:true,...obj(finished.data),publicReason:'Pending — the stored receipt could not be verified. Please upload the original image again.'},200,origin);
      }
    }
    const result=await verificationResult(db,job,bytes,type,finishRpc);
    await sendConfirmation(db,result);
    return jsonResponse({ok:true,...receiptSubmissionResult(result,balanceId)},200,origin);
  }catch(error){
    if(error instanceof RequestError)return errorResponse(error.status,error.code,error.message,origin);
    console.error('Pickle Street receipt service error',{type:error instanceof Error?error.name:'unknown'});
    return errorResponse(503,'RECEIPT_SERVICE_UNAVAILABLE','The receipt service is unavailable. Your booking has not been rejected. Check its status before retrying.',origin);
  }
}
if(import.meta.main)Deno.serve(handleRequest);
