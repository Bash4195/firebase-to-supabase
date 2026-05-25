import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, truncate } from "./helpers/database"

// ============================================================================
// Row builders
// ============================================================================

function buildMealPlanRow(mealPlanId: string, data: any) {
  const supabaseUserId = firebaseUidToUuid(data.userId)

  return {
    id: mealPlanId,
    user_id: supabaseUserId,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    title: truncate(data.title || "Meal plan", 500)!,
  }
}

// ============================================================================
// 1. onMealPlanCreate — New Firestore meal plan → Insert into Supabase
// ============================================================================
export const onMealPlanCreate = functions.firestore.document("mealPlans/{mealPlanId}").onCreate(async (snapshot) => {
  const data = snapshot.data()
  const mealPlanId = snapshot.id

  if (!data.userId) {
    console.error(`[onMealPlanCreate] Meal plan ${mealPlanId} has no userId — skipping`)
    return
  }

  console.log(`[onMealPlanCreate] Syncing meal plan ${mealPlanId} to Supabase`)

  try {
    const supabase = getSupabase()
    const row = buildMealPlanRow(mealPlanId, data)

    const { error } = await supabase.from("meal_plans").insert(row)

    if (error) {
      // Duplicate key means the backfill already inserted this meal plan
      if (error.code === "23505") {
        console.log(`[onMealPlanCreate] Meal plan ${mealPlanId} already exists in Supabase — skipping`)
        return
      }
      console.error(`[onMealPlanCreate] Failed to insert meal plan ${mealPlanId}:`, error.message)
      return
    }

    console.log(`[onMealPlanCreate] ✓ Synced meal plan ${mealPlanId}`)
  } catch (err: any) {
    console.error(`[onMealPlanCreate] Unexpected error for ${mealPlanId}:`, err.message || err)
  }
})

// ============================================================================
// 2. onMealPlanUpdate — Firestore meal plan edited → Update Supabase
// ============================================================================
export const onMealPlanUpdate = functions.firestore.document("mealPlans/{mealPlanId}").onUpdate(async (change) => {
  const data = change.after.data()
  const mealPlanId = change.after.id

  if (!data.userId) {
    console.error(`[onMealPlanUpdate] Meal plan ${mealPlanId} has no userId — skipping`)
    return
  }

  console.log(`[onMealPlanUpdate] Syncing meal plan ${mealPlanId} to Supabase`)

  try {
    const supabase = getSupabase()
    const fullRow = buildMealPlanRow(mealPlanId, data)

    // Strip fields that should never change on update
    const { id: _id, created_at: _ca, user_id: _uid, ...updatePayload } = fullRow

    const { data: updated, error: updateError } = await supabase
      .from("meal_plans")
      .update(updatePayload)
      .eq("id", mealPlanId)
      .select("id")

    if (updateError) {
      console.error(`[onMealPlanUpdate] Failed to update meal plan ${mealPlanId}:`, updateError.message)
      return
    }

    if (!updated || updated.length === 0) {
      console.log(`[onMealPlanUpdate] Meal plan ${mealPlanId} not found in Supabase — inserting instead`)

      // Fall back to insert in case the backfill hasn't reached this document yet
      const insertRow = buildMealPlanRow(mealPlanId, data)
      const { error: insertError } = await supabase.from("meal_plans").insert(insertRow)

      if (insertError && insertError.code !== "23505") {
        console.error(`[onMealPlanUpdate] Failed to insert meal plan ${mealPlanId}:`, insertError.message)
      }
      return
    }

    console.log(`[onMealPlanUpdate] ✓ Synced meal plan ${mealPlanId}`)
  } catch (err: any) {
    console.error(`[onMealPlanUpdate] Unexpected error for ${mealPlanId}:`, err.message || err)
  }
})

// ============================================================================
// 3. onMealPlanDelete — Firestore meal plan deleted → Delete from Supabase
// ============================================================================
export const onMealPlanDelete = functions.firestore.document("mealPlans/{mealPlanId}").onDelete(async (snapshot) => {
  const mealPlanId = snapshot.id

  console.log(`[onMealPlanDelete] Deleting meal plan ${mealPlanId} from Supabase`)

  try {
    const supabase = getSupabase()

    // ON DELETE CASCADE on meal_plan_recipes and meal_plan_shares
    // means we only need to delete the meal plan row itself.
    const { error } = await supabase.from("meal_plans").delete().eq("id", mealPlanId)

    if (error) {
      console.error(`[onMealPlanDelete] Failed to delete meal plan ${mealPlanId}:`, error.message)
      return
    }

    console.log(`[onMealPlanDelete] ✓ Deleted meal plan ${mealPlanId}`)
  } catch (err: any) {
    console.error(`[onMealPlanDelete] Unexpected error for ${mealPlanId}:`, err.message || err)
  }
})
