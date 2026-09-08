import { RequestError } from '../_shared/http.ts';
import { resolveTenantForRequest } from '../_shared/tenant.ts';
import { TENANT_ID, type Access, type HoldStore, type Obj, type Selection } from './handler.ts';

const object=(v:unknown):Obj=>{const n=Array.isArray(v)?v[0]:v;return n&&typeof n==='object'?n as Obj:{};};
export function databaseFailure(error:Obj):RequestError{
  const m=String(error?.message||'').toLowerCase(),c=String(error?.code||'');
  if(m.includes('access_denied')||m.includes('tenant_origin_denied')||c==='42501')return new RequestError(401,'BOOKING_ACCESS_DENIED','This private booking access is invalid or expired.');
  if(m.includes('rate_limited'))return new RequestError(429,'HOLD_RATE_LIMITED','Too many new reservations were started from this connection. Resume an existing reservation or wait a few minutes.');
  if(m.includes('hold_expired')||m.includes('hold_not_active'))return new RequestError(409,'HOLD_EXPIRED','The original court hold has ended. Choose available court hours again.');
  if(m.includes('idempotency_conflict'))return new RequestError(409,'REQUEST_SELECTION_CHANGED','This request already holds different court hours. Resume that reservation or start a new selection.');
  if(m.includes('completion_conflict'))return new RequestError(409,'DETAILS_ALREADY_COMPLETED','These booking details were already saved. Check the booking status before changing them.');
  if(m.includes('already_completed'))return new RequestError(409,'DETAILS_ALREADY_COMPLETED','The booking details are complete. Refresh its status before continuing.');
  if(m.includes('cancel_not_allowed'))return new RequestError(409,'CANCELLATION_UNAVAILABLE','This reservation cannot be released here. Refresh its current status.');
  if(m.includes('policy_not_configured'))return new RequestError(503,'BOOKING_POLICY_NOT_CONFIGURED','The venue must publish an approved Refund & Reschedule Policy.');
  if(m.includes('policy_version_stale'))return new RequestError(409,'POLICY_VERSION_STALE','The venue policy changed. Review and accept its current version.');
  if(m.includes('policy_evidence_mismatch'))return new RequestError(409,'POLICY_ACCEPTANCE_INVALID','The current policy could not be verified. Reload it and try again.');
  if(m.includes('guest_limit'))return new RequestError(422,'GUEST_LIMIT_EXCEEDED','The guest count exceeds this court’s booking limit.');
  if(m.includes('event_booking'))return new RequestError(422,'EVENT_BOOKING_UNAVAILABLE','Event booking is not available for this court.');
  if(c==='23P01'||/booking_conflict|slot_conflict|already booked/.test(m))return new RequestError(409,'TIME_UNAVAILABLE','One or more selected court hours are no longer available.');
  if(c==='23505')return new RequestError(409,'REQUEST_ALREADY_SUBMITTED','The reservation request is being processed. Retry the same selection.');
  if(m.includes('booking_not_ready'))return new RequestError(503,'BOOKING_NOT_CONFIGURED','Online booking is not ready for this venue yet.');
  if(c==='22023')return new RequestError(422,'BOOKING_INPUT_REJECTED','The selected court hours or booking details could not be accepted.');
  return new RequestError(503,'BOOKING_SERVICE_UNAVAILABLE','The booking reply was interrupted. Check its status or retry the same request; the deadline is unchanged.');
}
export function createHoldStore(db:Obj):HoldStore{
  const rpc=async(name:string,args:Obj)=>{const r=await db.rpc(name,args);if(r.error)throw databaseFailure(r.error);if(!r.data)throw Error('Booking RPC returned no data');return object(r.data);};
  return {
    resolve:(slug,origin)=>resolveTenantForRequest(db as any,slug,origin),
    async existing(clientRequestId,tokenHash,hostname){
      const held=await db.from('picklestreet_provisional_holds').select('booking_id').eq('tenant_id',TENANT_ID).eq('client_request_id',clientRequestId).eq('token_hash',tokenHash).maybeSingle();
      if(held.error)throw databaseFailure(held.error);if(!held.data)return null;
      const row=await db.from('bookings').select('reference').eq('tenant_id',TENANT_ID).eq('id',held.data.booking_id).single();
      if(row.error||!row.data)throw Error('Original reservation unavailable');
      const booking=await rpc('get_picklestreet_provisional_hold',{p_hostname:hostname,p_booking_reference:row.data.reference,p_access_token_hash:tokenHash});
      const selection:Selection={courtId:booking.courtId,bookingDate:booking.bookingDate,startTime:booking.startTime,durationHours:booking.durationHours,bookingType:booking.bookingType};
      return {booking,selection};
    },
    async configuration(courtId){
      const [tenant,court,billing,equipment,activation]=await Promise.all([
        db.from('tenants').select('id,slug,timezone,status,public_config').eq('id',TENANT_ID).eq('status','active').single(),
        db.from('courts').select('id,name,status,opens_at,closes_at,currency,pricing_config,public_config').eq('tenant_id',TENANT_ID).eq('id',courtId).eq('status','active').single(),
        db.from('tenant_platform_billing').select('fee_mode,fee_amount').eq('tenant_id',TENANT_ID).single(),
        db.from('tenant_equipment_rental_pricing').select('enabled,extra_paddle_rate,ball_rate').eq('tenant_id',TENANT_ID).maybeSingle(),
        db.rpc('tenant_booking_activation_state',{p_tenant_id:TENANT_ID}),
      ]);
      if(tenant.error||!tenant.data)throw new RequestError(403,'TENANT_INACTIVE','This booking website is not active.');
      if(court.error||!court.data)throw new RequestError(404,'COURT_NOT_FOUND','The selected court is not available.');
      if(billing.error||!billing.data||equipment.error||activation.error)throw new RequestError(503,'BOOKING_NOT_CONFIGURED','Online booking is not configured for this venue.');
      return {tenant:tenant.data,court:court.data,billing:billing.data,equipment:equipment.data,ready:object(activation.data).publicBookingEnabled===true};
    },
    async policy(){const r=await db.from('settings').select('value,is_public').eq('tenant_id',TENANT_ID).eq('key','refund_reschedule_policy').maybeSingle();if(r.error)throw new RequestError(503,'BOOKING_POLICY_NOT_CONFIGURED','The current venue policy could not be loaded.');return r.data;},
    create:args=>rpc('create_picklestreet_provisional_hold',args),
    status:(args:Access)=>rpc('get_picklestreet_provisional_hold',args),
    cancel:(args:Access)=>rpc('cancel_picklestreet_provisional_hold',args),
    complete:args=>rpc('complete_picklestreet_provisional_hold',args),
  };
}
