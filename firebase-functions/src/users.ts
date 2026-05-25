import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO } from "./helpers/database"

// ============================================================================
// Helpers
// ============================================================================

/**
 * Validate and transform agree_to_terms from Firebase to Supabase format.
 * Firebase: { version: number, agreed: boolean, timestamp: number (ms) }[]
 * Supabase: { version: number, agreed: boolean, timestamp: string (ISO) }[]
 */
function validateAgreeToTerms(val: any): any[] | null {
  if (!Array.isArray(val) || val.length === 0) return null

  const result: any[] = []
  for (const item of val) {
    if (typeof item !== "object" || item === null) continue

    const entry: Record<string, any> = {}

    if (typeof item.version === "number") entry.version = item.version
    else continue // version is required

    if (typeof item.agreed === "boolean") entry.agreed = item.agreed
    else continue // agreed is required

    // Convert numeric timestamp (ms) to ISO string, or keep string as-is
    if (typeof item.timestamp === "number") {
      entry.timestamp = new Date(item.timestamp).toISOString()
    } else if (typeof item.timestamp === "string") {
      entry.timestamp = item.timestamp
    } else {
      entry.timestamp = new Date().toISOString()
    }

    result.push(entry)
  }

  return result.length > 0 ? result : null
}

// ============================================================================
// Row builder
// ============================================================================
function buildProfileUpdatePayload(data: any): Record<string, any> {
  const agreeToTerms = validateAgreeToTerms(data.agreeToTerms) ?? [
    { version: 1, agreed: true, timestamp: new Date().toISOString() },
  ]

  return {
    email: data.email || null,
    agree_to_terms: agreeToTerms,
    requested_app_store_review: data.requestedAppStoreReview ?? false,
    free_recipe_social_media_imports_used: data.freeRecipeSocialMediaImportsUsed ?? 0,
    free_recipe_image_imports_used: data.freeRecipeImageImportsUsed ?? 0,
    free_recipe_text_imports_used: data.freeRecipeTextImportsUsed ?? 0,
    free_ai_recipe_generations_used: data.freeAIRecipeGenerationsUsed ?? 0,
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
  }
}

// ============================================================================
// onProfileUpdate — Firestore user doc changed → Update Supabase profile
// ============================================================================
export const onProfileUpdate = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const data = change.after.data()
    const firebaseUid = context.params.userId
    const supabaseId = firebaseUidToUuid(firebaseUid)

    console.log(`[onProfileUpdate] Syncing profile for user ${supabaseId}`)

    try {
      const supabase = getSupabase()
      const payload = buildProfileUpdatePayload(data)

      const { data: updated, error } = await supabase
        .from("profiles")
        .update(payload)
        .eq("id", supabaseId)
        .select("id")

      if (error) {
        console.error(
          `[onProfileUpdate] Failed to update profile ${supabaseId}:`,
          error.message
        )
        return
      }

      if (!updated || updated.length === 0) {
        console.log(
          `[onProfileUpdate] Profile ${supabaseId} not found — ` +
          `auth user may not exist yet. Will be picked up by backfill.`
        )
        return
      }

      console.log(`[onProfileUpdate] ✓ Synced profile ${supabaseId}`)
    } catch (err: any) {
      console.error(
        `[onProfileUpdate] Unexpected error for ${supabaseId}:`,
        err.message || err
      )
    }
  })