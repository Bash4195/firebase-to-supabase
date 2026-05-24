import { admin } from "./admin"
import * as functions from "firebase-functions/v1"
import { v4 as uuidv4 } from "uuid"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, truncate } from "./helpers/database"

// ============================================================================
// Row builder
// ============================================================================
function buildCollectionRow(collectionId: string, data: any) {
  const supabaseUserId = firebaseUidToUuid(data.userId)

  return {
    id: collectionId,
    user_id: supabaseUserId,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    title: truncate(data.title || "Collection", 500)!,
  }
}

// ============================================================================
// 1. onCollectionCreate — New Firestore collection → Insert into Supabase
// ============================================================================
export const onCollectionCreate = functions.firestore
  .document("collections/{collectionId}")
  .onCreate(async (snapshot) => {
    const data = snapshot.data()
    const collectionId = snapshot.id

    if (!data.userId) {
      console.error(`[onCollectionCreate] Collection ${collectionId} has no userId — skipping`)
      return
    }

    console.log(`[onCollectionCreate] Syncing collection ${collectionId} to Supabase`)

    try {
      const supabase = getSupabase()
      const collectionRow = buildCollectionRow(collectionId, data)

      const { error } = await supabase.from("collections").insert(collectionRow)

      if (error) {
        // Duplicate key means the backfill already inserted this collection — that's fine
        if (error.code === "23505") {
          console.log(`[onCollectionCreate] Collection ${collectionId} already exists in Supabase — skipping`)
          return
        }
        console.error(`[onCollectionCreate] Failed to insert collection ${collectionId}:`, error.message)
        return
      }

      console.log(`[onCollectionCreate] ✓ Synced collection ${collectionId}`)
    } catch (err: any) {
      console.error(`[onCollectionCreate] Unexpected error for ${collectionId}:`, err.message || err)
    }
  })

// ============================================================================
// 2. onCollectionUpdate — Firestore collection edited → Update Supabase
// ============================================================================
export const onCollectionUpdate = functions.firestore
  .document("collections/{collectionId}")
  .onUpdate(async (change) => {
    const data = change.after.data()
    const collectionId = change.after.id

    if (!data.userId) {
      console.error(`[onCollectionUpdate] Collection ${collectionId} has no userId — skipping`)
      return
    }

    console.log(`[onCollectionUpdate] Syncing collection ${collectionId} to Supabase`)

    try {
      const supabase = getSupabase()
      const fullRow = buildCollectionRow(collectionId, data)

      // Strip fields that should never change on update.
      // updated_at is intentionally kept — the DB trigger overrides it with NOW()
      // but including it is a harmless safety net if the trigger is ever disabled.
      const { id: _id, created_at: _ca, user_id: _uid, ...updatePayload } = fullRow

      // .update() naturally affects 0 rows when the collection doesn't exist yet
      const { data: updated, error: updateError } = await supabase
        .from("collections")
        .update(updatePayload)
        .eq("id", collectionId)
        .select("id")

      if (updateError) {
        console.error(`[onCollectionUpdate] Failed to update collection ${collectionId}:`, updateError.message)
        return
      }

      if (!updated || updated.length === 0) {
        console.log(`[onCollectionUpdate] Collection ${collectionId} not found in Supabase — inserting instead`)

        // Fall back to an insert in case the backfill hasn't reached this document yet
        const insertRow = buildCollectionRow(collectionId, data)
        const { error: insertError } = await supabase.from("collections").insert(insertRow)

        if (insertError && insertError.code !== "23505") {
          console.error(`[onCollectionUpdate] Failed to insert collection ${collectionId}:`, insertError.message)
        }
        return
      }

      console.log(`[onCollectionUpdate] ✓ Synced collection ${collectionId}`)
    } catch (err: any) {
      console.error(`[onCollectionUpdate] Unexpected error for ${collectionId}:`, err.message || err)
    }
  })

// ============================================================================
// 3. onCollectionDelete — Firestore collection deleted → Delete from Supabase
// ============================================================================
export const onCollectionDelete = functions.firestore
  .document("collections/{collectionId}")
  .onDelete(async (snapshot) => {
    const collectionId = snapshot.id

    console.log(`[onCollectionDelete] Deleting collection ${collectionId} from Supabase`)

    try {
      const supabase = getSupabase()

      // ON DELETE CASCADE on collection_recipes and collection_shares
      // means we only need to delete the collection row itself.
      const { error } = await supabase.from("collections").delete().eq("id", collectionId)

      if (error) {
        console.error(`[onCollectionDelete] Failed to delete collection ${collectionId}:`, error.message)
        return
      }

      console.log(`[onCollectionDelete] ✓ Deleted collection ${collectionId}`)
    } catch (err: any) {
      console.error(`[onCollectionDelete] Unexpected error for ${collectionId}:`, err.message || err)
    }
  })
