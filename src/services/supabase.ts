// Supabase client factory (service role key: server only, never sent to the browser).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";

export function createSupabase(env: Pick<Env, "supabaseUrl" | "supabaseServiceRoleKey">): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
