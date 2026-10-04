import { RequestError } from "../_shared/http.ts";
import { createClient } from "@supabase/supabase-js";
import { sendMailerooEmail } from "../_shared/maileroo.ts";
import {
  createRescheduleBookingHandler,
  type RescheduleEmailSender,
} from "../_shared/reschedule-booking.ts";
import { createSupabaseRescheduleBookingStore } from "../picklestreet-receipts/reschedule-store.ts";

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const anonKey = requiredEnvironment("SUPABASE_ANON_KEY");
const db = createClient(
  supabaseUrl,
  requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const store = createSupabaseRescheduleBookingStore({
  db,
  supabaseUrl,
  anonKey,
  bookingAccessTokenSecret: requiredEnvironment("BOOKING_ACCESS_TOKEN_SECRET"),
});
const resolveTenant = store.resolveTenant.bind(store);
store.resolveTenant = async (slug, origin) => {
  const context = await resolveTenant(slug, origin);
  if (context.tenantId !== 'f19f457a-68e2-42ea-9f8e-1f6e8ac84b3a') {
    throw new RequestError(403, 'TENANT_ACCESS_DENIED', 'Tenant booking access denied.');
  }
  return context;
};
const sender: RescheduleEmailSender = {
  async send(message) {
    return await sendMailerooEmail({
      apiKey: requiredEnvironment("PICKLESTREET_MAILEROO_API_KEY"),
      fromAddress: requiredEnvironment("PICKLESTREET_MAILEROO_FROM_EMAIL"),
      fromName: message.fromName,
      replyTo: message.replyTo,
      replyToName: message.replyToName,
      to: message.to,
      toName: message.toName,
      subject: message.subject,
      html: message.html,
      plainText: message.plainText,
      referenceId: message.referenceId,
      tags: message.tags,
    });
  },
};

Deno.serve(createRescheduleBookingHandler(store, sender));
