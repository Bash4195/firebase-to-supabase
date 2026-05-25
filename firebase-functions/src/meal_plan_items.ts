import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToDate, firestoreTimestampToISO, mapMealType, truncate } from "./helpers/database"

// ============================================================================
// Row builders
// ============================================================================

function buildMealPlanRecipeRow(itemId: string, mealPlanId: string, data: any): Record<string, any> | null {
  const recipeId = data.recipe?.recipeId
  if (!recipeId) return null

  const dateVal = firestoreTimestampToDate(data.date)
  if (!dateVal) return null

  return {
    id: itemId,
    meal_plan_id: mealPlanId,
    recipe_id: recipeId,
    date: dateVal,
    meal_type: mapMealType(data.mealType),
    notes: truncate(data.note, 5000) || null,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
  }
}

// ============================================================================
// 1. onMealPlanItemCreate — New item → Insert into meal_plan_recipes
// ============================================================================
export const onMealPlanItemCreate = functions.firestore
  .document("mealPlans/{mealPlanId}/items/{itemId}")
  .onCreate(async (snapshot, context) => {
    const data = snapshot.data()
    const mealPlanId = context.params.mealPlanId
    const itemId = context.params.itemId

    // Only sync items that reference a recipe.
    // Note-only items cannot be stored in meal_plan_recipes (recipe_id is NOT NULL).
    if (!data.recipe?.recipeId) {
      console.log(`[onMealPlanItemCreate] Item ${itemId} has no recipe — skipping (note-only)`)
      return
    }

    console.log(`[onMealPlanItemCreate] Syncing item ${itemId} to meal_plan_recipes`)

    try {
      const supabase = getSupabase()
      const row = buildMealPlanRecipeRow(itemId, mealPlanId, data)

      if (!row) {
        console.log(`[onMealPlanItemCreate] Could not build row for item ${itemId} — skipping`)
        return
      }

      const { error } = await supabase.from("meal_plan_recipes").insert(row)

      if (error) {
        if (error.code === "23505") {
          console.log(`[onMealPlanItemCreate] Item ${itemId} already exists — skipping`)
          return
        }
        // FK violation — meal plan or recipe not yet in Supabase (backfill race)
        if (error.code === "23503") {
          console.log(
            `[onMealPlanItemCreate] FK violation — meal plan or recipe not yet ` +
              `in Supabase. Will be picked up by backfill.`
          )
          return
        }
        console.error(`[onMealPlanItemCreate] Failed to insert item ${itemId}:`, error.message)
        return
      }

      console.log(`[onMealPlanItemCreate] ✓ Synced item ${itemId}`)
    } catch (err: any) {
      console.error(`[onMealPlanItemCreate] Unexpected error for ${itemId}:`, err.message || err)
    }
  })

// ============================================================================
// 2. onMealPlanItemUpdate — Item modified → Upsert logic for meal_plan_recipes
// ============================================================================
export const onMealPlanItemUpdate = functions.firestore
  .document("mealPlans/{mealPlanId}/items/{itemId}")
  .onUpdate(async (change, context) => {
    const data = change.after.data()
    const previousData = change.before.data()
    const mealPlanId = context.params.mealPlanId
    const itemId = context.params.itemId

    const hasRecipe = !!data.recipe?.recipeId
    const hadRecipe = !!previousData.recipe?.recipeId

    console.log(`[onMealPlanItemUpdate] Syncing item ${itemId}`)

    try {
      const supabase = getSupabase()

      // Case 1: Recipe was removed from the item → delete from meal_plan_recipes
      if (hadRecipe && !hasRecipe) {
        console.log(`[onMealPlanItemUpdate] Recipe removed from item ${itemId} — deleting`)
        const { error } = await supabase.from("meal_plan_recipes").delete().eq("id", itemId)

        if (error) {
          console.error(`[onMealPlanItemUpdate] Failed to delete item ${itemId}:`, error.message)
        } else {
          console.log(`[onMealPlanItemUpdate] ✓ Deleted item ${itemId}`)
        }
        return
      }

      // Case 2: Still no recipe → nothing to sync
      if (!hasRecipe) {
        console.log(`[onMealPlanItemUpdate] Item ${itemId} has no recipe — skipping`)
        return
      }

      // Case 3: Has a recipe → update (or insert if not found)
      const row = buildMealPlanRecipeRow(itemId, mealPlanId, data)
      if (!row) {
        console.log(`[onMealPlanItemUpdate] Could not build row for item ${itemId} — skipping`)
        return
      }

      // Only update mutable fields — id, created_at, and meal_plan_id should not change
      const { id: _id, created_at: _ca, meal_plan_id: _mpid, ...updatePayload } = row

      const { data: updated, error: updateError } = await supabase
        .from("meal_plan_recipes")
        .update(updatePayload)
        .eq("id", itemId)
        .select("id")

      if (updateError) {
        console.error(`[onMealPlanItemUpdate] Failed to update item ${itemId}:`, updateError.message)
        return
      }

      if (!updated || updated.length === 0) {
        console.log(`[onMealPlanItemUpdate] Item ${itemId} not found — inserting instead`)

        const { error: insertError } = await supabase.from("meal_plan_recipes").insert(row)

        if (insertError) {
          if (insertError.code === "23505") {
            console.log(`[onMealPlanItemUpdate] Item ${itemId} already exists — skipping`)
          } else if (insertError.code === "23503") {
            console.log(`[onMealPlanItemUpdate] FK violation — will be picked up by backfill.`)
          } else {
            console.error(`[onMealPlanItemUpdate] Failed to insert item ${itemId}:`, insertError.message)
          }
        } else {
          console.log(`[onMealPlanItemUpdate] ✓ Inserted item ${itemId}`)
        }
        return
      }

      console.log(`[onMealPlanItemUpdate] ✓ Synced item ${itemId}`)
    } catch (err: any) {
      console.error(`[onMealPlanItemUpdate] Unexpected error for ${itemId}:`, err.message || err)
    }
  })

// ============================================================================
// 3. onMealPlanItemDelete — Item removed → Delete from meal_plan_recipes
// ============================================================================
export const onMealPlanItemDelete = functions.firestore
  .document("mealPlans/{mealPlanId}/items/{itemId}")
  .onDelete(async (snapshot, context) => {
    const data = snapshot.data()
    const itemId = context.params.itemId

    // Note-only items were never in meal_plan_recipes — nothing to delete
    if (!data.recipe?.recipeId) {
      console.log(`[onMealPlanItemDelete] Item ${itemId} was note-only — nothing to delete`)
      return
    }

    console.log(`[onMealPlanItemDelete] Removing item ${itemId} from meal_plan_recipes`)

    try {
      const supabase = getSupabase()

      const { error } = await supabase.from("meal_plan_recipes").delete().eq("id", itemId)

      if (error) {
        console.error(`[onMealPlanItemDelete] Failed to delete item ${itemId}:`, error.message)
        return
      }

      console.log(`[onMealPlanItemDelete] ✓ Deleted item ${itemId}`)
    } catch (err: any) {
      console.error(`[onMealPlanItemDelete] Unexpected error for ${itemId}:`, err.message || err)
    }
  })
