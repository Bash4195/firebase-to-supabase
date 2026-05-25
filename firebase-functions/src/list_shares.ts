import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, mapSharePermission, truncate } from "./helpers/database"

// ============================================================================
// Row builder
// ============================================================================
function buildShareRow(listId: string, data: any) {
  const sharedWithSupabaseId = firebaseUidToUuid(data.id)

  return {
    list_id: listId,
    shared_with_user_id: sharedWithSupabaseId,
    shared_with_email: data.email || null,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    permission: mapSharePermission(data.permission),
    nickname: truncate(data.nickname, 500) || null,
  }
}

// ============================================================================
// 1. onCreate — New share → Insert into list_shares
// ============================================================================
export const onListShareCreate = functions.firestore
  .document("lists/{listId}/sharedWith/{sharedWithId}")
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    const listId = context.params.listId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onListShareCreate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onListShareCreate] Syncing share of list ${listId} to user ${sharedWithFirebaseId}`)

    try {
      const supabase = getSupabase()
      const row = buildShareRow(listId, data)

      const { error } = await supabase.from("list_shares").insert(row)

      if (error) {
        // 23505 = duplicate key — share already exists (backfill race)
        if (error.code === "23505") {
          console.log(`[onListShareCreate] Share already exists — skipping`)
          return
        }
        // 23503 = FK violation — list not yet in Supabase or shared-with user not yet migrated
        if (error.code === "23503") {
          console.log(
            `[onListShareCreate] FK violation — list or user not yet in Supabase. ` + `Will be picked up by backfill.`
          )
          return
        }
        console.error(`[onListShareCreate] Failed to insert share:`, error.message)
        return
      }

      console.log(`[onListShareCreate] ✓ Synced share of list ${listId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onListShareCreate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 2. onUpdate — Share modified → Update Supabase (or insert if missing)
// ============================================================================
export const onListShareUpdate = functions.firestore
  .document("lists/{listId}/sharedWith/{sharedWithId}")
  .onUpdate(async (change, context) => {
    const data = change.after.data()
    const listId = context.params.listId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onListShareUpdate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onListShareUpdate] Syncing share of list ${listId} to ${sharedWithFirebaseId}`)

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
        .from("list_shares")
        .update(updatePayload)
        .eq("list_id", listId)
        .eq("shared_with_user_id", sharedWithSupabaseId)
        .select("list_id")

      if (updateError) {
        console.error(`[onListShareUpdate] Failed to update share:`, updateError.message)
        return
      }

      if (!updated || updated.length === 0) {
        console.log(`[onListShareUpdate] Share not found in Supabase — inserting instead`)

        // Fall back to insert in case the backfill hasn't reached this document yet
        const insertRow = buildShareRow(listId, data)
        const { error: insertError } = await supabase.from("list_shares").insert(insertRow)

        if (insertError && insertError.code !== "23505" && insertError.code !== "23503") {
          console.error(`[onListShareUpdate] Failed to insert share:`, insertError.message)
        }
        return
      }

      console.log(`[onListShareUpdate] ✓ Synced share of list ${listId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onListShareUpdate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 3. onDelete — Share removed → Delete from Supabase
// ============================================================================
export const onListShareDelete = functions.firestore
  .document("lists/{listId}/sharedWith/{sharedWithId}")
  .onDelete(async (snapshot, context) => {
    const data = snapshot.data()
    const listId = context.params.listId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      // Fall back to the path parameter if the data.id field is missing
      console.warn(`[onListShareDelete] Share ${sharedWithFirebaseId} missing id field — using path parameter`)
    }

    const firebaseUid = data.id || sharedWithFirebaseId
    const sharedWithSupabaseId = firebaseUidToUuid(firebaseUid)

    console.log(`[onListShareDelete] Removing share of list ${listId} from ${firebaseUid}`)

    try {
      const supabase = getSupabase()

      const { error } = await supabase
        .from("list_shares")
        .delete()
        .eq("list_id", listId)
        .eq("shared_with_user_id", sharedWithSupabaseId)

      if (error) {
        console.error(`[onListShareDelete] Failed to delete share:`, error.message)
        return
      }

      console.log(`[onListShareDelete] ✓ Removed share of list ${listId} from ${firebaseUid}`)
    } catch (err: any) {
      console.error(`[onListShareDelete] Unexpected error:`, err.message || err)
    }
  })
