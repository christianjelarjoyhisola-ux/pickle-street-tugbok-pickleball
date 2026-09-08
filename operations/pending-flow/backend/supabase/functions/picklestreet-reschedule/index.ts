import { createClient } from "@supabase/supabase-js";
import { createGroupedRescheduleEmailSender } from "./email.ts";
import { createGroupRescheduleHandler } from "./handler.ts";
import { createGroupStore } from "./store.ts";

export function handleRequest(request: Request): Promise<Response> {
  const env = (name: string) => {
    const value = Deno.env.get(name)?.trim();
    if (!value) throw new Error("Service configuration unavailable.");
    return value;
  };
  const db = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return createGroupRescheduleHandler(
    createGroupStore(db, env("BOOKING_ACCESS_TOKEN_SECRET")),
    createGroupedRescheduleEmailSender(),
  )(request);
}

if (import.meta.main) Deno.serve(handleRequest);
