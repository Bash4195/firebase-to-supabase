import { createClient, SupabaseClient } from "@supabase/supabase-js"

let _supabase: SupabaseClient | null = null

/**
 * Lazily initialise a Supabase admin client (service_role key — bypasses RLS).
 * Safe to call repeatedly; the client is cached in module scope.
 */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment")
    }

    _supabase = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return _supabase
}