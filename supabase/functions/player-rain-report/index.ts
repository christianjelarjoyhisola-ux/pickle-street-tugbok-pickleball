import { createClient } from "@supabase/supabase-js";
import { createPlayerRainReportHandler } from "../_shared/player-rain-report.ts";
import { createSupabasePlayerRainReportStore } from "./store.ts";

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const db = createClient(
  requiredEnvironment("SUPABASE_URL"),
  requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(
  createPlayerRainReportHandler(
    createSupabasePlayerRainReportStore(db),
    {
      bookingAccessTokenSecret: requiredEnvironment(
        "BOOKING_ACCESS_TOKEN_SECRET",
      ),
    },
  ),
);
