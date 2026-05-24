// firebase-functions/src/collection_shares.ts
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, mapSharePermission, truncate } from "./helpers/database"

// ============================================================================
// Row builder
// ============================================================================
function buildShareRow(collectionId: string, data: any) {
  const sharedWithSupabaseId = firebaseUidToUuid(data.id)

  return {
    collection_id: collectionId,
    shared_with_user_id: sharedWithSupabaseId,
    shared_with_email: data.email || null,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    permission: mapSharePermission(data.permission),
    nickname: truncate(data.nickname, 500) || null,
  }
}

// ============================================================================
// 1. onCreate — New share → Insert into collection_shares
// ============================================================================
export const onCollectionShareCreate = functions.firestore
  .document("collections/{collectionId}/sharedWith/{sharedWithId}")
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    const collectionId = context.params.collectionId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onCollectionShareCreate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onCollectionShareCreate] Syncing share of collection ${collectionId} to user ${sharedWithFirebaseId}`)

    try {
      const supabase = getSupabase()
      const row = buildShareRow(collectionId, data)

      const { error } = await supabase.from("collection_shares").insert(row)

      if (error) {
        // 23505 = duplicate key — share already exists (backfill race)
        if (error.code === "23505") {
          console.log(`[onCollectionShareCreate] Share already exists — skipping`)
          return
        }
        // 23503 = FK violation — collection not yet in Supabase or shared-with user not yet migrated
        if (error.code === "23503") {
          console.log(
            `[onCollectionShareCreate] FK violation — collection or user not yet in Supabase. ` +
              `Will be picked up by backfill.`
          )
          return
        }
        console.error(`[onCollectionShareCreate] Failed to insert share:`, error.message)
        return
      }

      console.log(`[onCollectionShareCreate] ✓ Synced share of collection ${collectionId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onCollectionShareCreate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 2. onUpdate — Share modified → Update Supabase (or insert if missing)
// ============================================================================
export const onCollectionShareUpdate = functions.firestore
  .document("collections/{collectionId}/sharedWith/{sharedWithId}")
  .onUpdate(async (change, context) => {
    const data = change.after.data()
    const collectionId = context.params.collectionId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onCollectionShareUpdate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onCollectionShareUpdate] Syncing share of collection ${collectionId} to ${sharedWithFirebaseId}`)

    try {
      const supabase = getSupabase()
      const sharedWithSupabaseId = firebaseUidToUuid(data.id)

      // Only the mutable fields — never change the PK columns
      const updatePayload = {
        shared_with_email: data.email || null,
        updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
        permission: mapSharePermission(data.permission),
        nickname: truncate(data.nickname, 500) || null,
      }

      const { data: updated, error: updateError } = await supabase
        .from("collection_shares")
        .update(updatePayload)
        .eq("collection_id", collectionId)
        .eq("shared_with_user_id", sharedWithSupabaseId)
        .select("collection_id")

      if (updateError) {
        console.error(`[onCollectionShareUpdate] Failed to update share:`, updateError.message)
        return
      }

      if (!updated || updated.length === 0) {
        console.log(`[onCollectionShareUpdate] Share not found in Supabase — inserting instead`)

        // Fall back to insert in case the backfill hasn't reached this document yet
        const insertRow = buildShareRow(collectionId, data)
        const { error: insertError } = await supabase.from("collection_shares").insert(insertRow)

        if (insertError && insertError.code !== "23505" && insertError.code !== "23503") {
          console.error(`[onCollectionShareUpdate] Failed to insert share:`, insertError.message)
        }
        return
      }

      console.log(`[onCollectionShareUpdate] ✓ Synced share of collection ${collectionId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onCollectionShareUpdate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 3. onDelete — Share removed → Delete from Supabase
// ============================================================================
export const onCollectionShareDelete = functions.firestore
  .document("collections/{collectionId}/sharedWith/{sharedWithId}")
  .onDelete(async (snapshot, context) => {
    const data = snapshot.data()
    const collectionId = context.params.collectionId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      // Fall back to the path parameter if the data.id field is missing
      console.warn(`[onCollectionShareDelete] Share ${sharedWithFirebaseId} missing id field — using path parameter`)
    }

    const firebaseUid = data.id || sharedWithFirebaseId
    const sharedWithSupabaseId = firebaseUidToUuid(firebaseUid)

    console.log(`[onCollectionShareDelete] Removing share of collection ${collectionId} from ${firebaseUid}`)

    try {
      const supabase = getSupabase()

      const { error } = await supabase
        .from("collection_shares")
        .delete()
        .eq("collection_id", collectionId)
        .eq("shared_with_user_id", sharedWithSupabaseId)

      if (error) {
        console.error(`[onCollectionShareDelete] Failed to delete share:`, error.message)
        return
      }

      console.log(`[onCollectionShareDelete] ✓ Removed share of collection ${collectionId} from ${firebaseUid}`)
    } catch (err: any) {
      console.error(`[onCollectionShareDelete] Unexpected error:`, err.message || err)
    }
  })
