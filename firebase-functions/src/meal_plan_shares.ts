import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, mapSharePermission, truncate } from "./helpers/database"

// ============================================================================
// Row builder
// ============================================================================
function buildShareRow(mealPlanId: string, data: any) {
  const sharedWithSupabaseId = firebaseUidToUuid(data.id)

  return {
    meal_plan_id: mealPlanId,
    shared_with_user_id: sharedWithSupabaseId,
    shared_with_email: data.email || null,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    permission: mapSharePermission(data.permission),
    nickname: truncate(data.nickname, 500) || null,
  }
}

// ============================================================================
// 1. onCreate — New share → Insert into meal_plan_shares
// ============================================================================
export const onMealPlanShareCreate = functions.firestore
  .document("mealPlans/{mealPlanId}/sharedWith/{sharedWithId}")
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    const mealPlanId = context.params.mealPlanId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onMealPlanShareCreate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onMealPlanShareCreate] Syncing share of meal plan ${mealPlanId} to user ${sharedWithFirebaseId}`)

    try {
      const supabase = getSupabase()
      const row = buildShareRow(mealPlanId, data)

      const { error } = await supabase.from("meal_plan_shares").insert(row)

      if (error) {
        // 23505 = duplicate key — share already exists (backfill race)
        if (error.code === "23505") {
          console.log(`[onMealPlanShareCreate] Share already exists — skipping`)
          return
        }
        // 23503 = FK violation — meal plan not yet in Supabase or shared-with user not yet migrated
        if (error.code === "23503") {
          console.log(
            `[onMealPlanShareCreate] FK violation — meal plan or user not yet in Supabase. ` +
              `Will be picked up by backfill.`
          )
          return
        }
        console.error(`[onMealPlanShareCreate] Failed to insert share:`, error.message)
        return
      }

      console.log(`[onMealPlanShareCreate] ✓ Synced share of meal plan ${mealPlanId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onMealPlanShareCreate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 2. onUpdate — Share modified → Update Supabase (or insert if missing)
// ============================================================================
export const onMealPlanShareUpdate = functions.firestore
  .document("mealPlans/{mealPlanId}/sharedWith/{sharedWithId}")
  .onUpdate(async (change, context) => {
    const data = change.after.data()
    const mealPlanId = context.params.mealPlanId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      console.error(`[onMealPlanShareUpdate] Share ${sharedWithFirebaseId} missing id field — skipping`)
      return
    }

    console.log(`[onMealPlanShareUpdate] Syncing share of meal plan ${mealPlanId} to ${sharedWithFirebaseId}`)

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
        .from("meal_plan_shares")
        .update(updatePayload)
        .eq("meal_plan_id", mealPlanId)
        .eq("shared_with_user_id", sharedWithSupabaseId)
        .select("meal_plan_id")

      if (updateError) {
        console.error(`[onMealPlanShareUpdate] Failed to update share:`, updateError.message)
        return
      }

      if (!updated || updated.length === 0) {
        console.log(`[onMealPlanShareUpdate] Share not found in Supabase — inserting instead`)

        // Fall back to insert in case the backfill hasn't reached this document yet
        const insertRow = buildShareRow(mealPlanId, data)
        const { error: insertError } = await supabase.from("meal_plan_shares").insert(insertRow)

        if (insertError && insertError.code !== "23505" && insertError.code !== "23503") {
          console.error(`[onMealPlanShareUpdate] Failed to insert share:`, insertError.message)
        }
        return
      }

      console.log(`[onMealPlanShareUpdate] ✓ Synced share of meal plan ${mealPlanId} to ${sharedWithFirebaseId}`)
    } catch (err: any) {
      console.error(`[onMealPlanShareUpdate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 3. onDelete — Share removed → Delete from Supabase
// ============================================================================
export const onMealPlanShareDelete = functions.firestore
  .document("mealPlans/{mealPlanId}/sharedWith/{sharedWithId}")
  .onDelete(async (snapshot, context) => {
    const data = snapshot.data()
    const mealPlanId = context.params.mealPlanId
    const sharedWithFirebaseId = context.params.sharedWithId

    if (!data.id) {
      // Fall back to the path parameter if the data.id field is missing
      console.warn(`[onMealPlanShareDelete] Share ${sharedWithFirebaseId} missing id field — using path parameter`)
    }

    const firebaseUid = data.id || sharedWithFirebaseId
    const sharedWithSupabaseId = firebaseUidToUuid(firebaseUid)

    console.log(`[onMealPlanShareDelete] Removing share of meal plan ${mealPlanId} from ${firebaseUid}`)

    try {
      const supabase = getSupabase()

      const { error } = await supabase
        .from("meal_plan_shares")
        .delete()
        .eq("meal_plan_id", mealPlanId)
        .eq("shared_with_user_id", sharedWithSupabaseId)

      if (error) {
        console.error(`[onMealPlanShareDelete] Failed to delete share:`, error.message)
        return
      }

      console.log(`[onMealPlanShareDelete] ✓ Removed share of meal plan ${mealPlanId} from ${firebaseUid}`)
    } catch (err: any) {
      console.error(`[onMealPlanShareDelete] Unexpected error:`, err.message || err)
    }
  })
