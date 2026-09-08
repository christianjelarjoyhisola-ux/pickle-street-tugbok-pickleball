import {sendMailerooEmail} from '../_shared/maileroo.ts';
const TENANT='f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a';
export const duplicateRejectionReason='Booking cancelled — this payment reference has already been used for another booking. Please contact Pickle Street Tugbok if you believe this is a mistake.';
export function rejectionEmail(reference:string,name:string){
 const plainText='Hi '+(name||'Player')+',\n\nYour Pickle Street Tugbok booking '+reference+' was cancelled because the payment reference on your receipt has already been used for another booking. All court slots in this booking have been released.\n\nIf you believe this is a mistake, reply to this email with your booking reference and original receipt so our team can review it. Please do not send another payment until you have checked with us.\n\nPickle Street Tugbok';
 const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 return {subject:'Pickle Street Tugbok — booking cancelled ('+reference+')',plainText,html:'<div style="font-family:Arial,sans-serif;line-height:1.65;color:#183d49;max-width:560px;margin:auto;padding:24px"><h2>Booking cancelled</h2><p>'+escape(plainText).replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>')+'</p></div>'};
}
export async function sendDuplicateRejectionEmail(db:any,bookingId:string):Promise<string>{
 let claimed=false;
 try{
  const now=new Date().toISOString();
  const queue=await db.from('picklestreet_rejection_emails').update({status:'sending',lease_until:new Date(Date.now()+120000).toISOString()}).eq('tenant_id',TENANT).eq('booking_id',bookingId).neq('status','sent').or('lease_until.is.null,lease_until.lt.'+now).select('*').maybeSingle();
  if(queue.error||!queue.data)return 'pending';claimed=true;
  const booking=await db.from('bookings').select('reference,customer_name,customer_email,status,payment_status,metadata').eq('tenant_id',TENANT).eq('id',bookingId).single();
  if(booking.error||booking.data?.metadata?.duplicateReferenceRejected!==true||booking.data.status!=='cancelled'||booking.data.payment_status!=='rejected')throw Error('Booking is not duplicate-rejected');
  const payload=await db.rpc('get_booking_email_payload',{p_tenant_slug:'pickle-street-tugbok',p_booking_reference:booking.data.reference});
  if(payload.error)throw Error('Email configuration unavailable');
  const replyTo=payload.data?.tenant?.replyToEmail||payload.data?.tenant?.contactEmail;
  if(!replyTo)throw Error('Reply address unavailable');
  const email=rejectionEmail(booking.data.reference,booking.data.customer_name);
  await sendMailerooEmail({apiKey:Deno.env.get('MAILEROO_API_KEY')||'',fromAddress:Deno.env.get('MAILEROO_FROM_EMAIL')||'',fromName:'Pickle Street Tugbok',replyTo,to:booking.data.customer_email,toName:booking.data.customer_name,...email,referenceId:queue.data.delivery_id.replaceAll('-','').slice(0,24)});
  const saved=await db.from('picklestreet_rejection_emails').update({status:'sent',sent_at:new Date().toISOString(),lease_until:null}).eq('tenant_id',TENANT).eq('booking_id',bookingId);
  return saved.error?'pending':'sent';
 }catch{
  if(claimed)await db.from('picklestreet_rejection_emails').update({status:'pending',lease_until:new Date(Date.now()+120000).toISOString()}).eq('tenant_id',TENANT).eq('booking_id',bookingId).neq('status','sent');
  return 'pending';
 }
}
