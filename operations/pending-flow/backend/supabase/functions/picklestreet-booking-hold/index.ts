import { createClient } from '@supabase/supabase-js';
import { errorResponse } from '../_shared/http.ts';
import { createHoldHandler } from './handler.ts';
import { createHoldStore } from './store.ts';
function required(name:string):string{const value=Deno.env.get(name)?.trim();if(!value)throw Error('Required booking configuration unavailable');return value;}
export async function handleRequest(request:Request):Promise<Response>{
  try{
    const db=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{'X-Client-Info':'picklestreet-booking-hold/1.0'}}});
    return await createHoldHandler({store:createHoldStore(db),bookingSecret:required('BOOKING_ACCESS_TOKEN_SECRET'),turnstileSecret:required('TURNSTILE_SECRET_KEY')})(request);
  }catch{return errorResponse(503,'BOOKING_SERVICE_UNAVAILABLE','The booking service is temporarily unavailable. Retry the same selection.');}
}
if(import.meta.main)Deno.serve(handleRequest);
