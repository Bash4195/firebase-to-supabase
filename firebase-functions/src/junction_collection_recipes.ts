import { admin } from "./admin"
import * as functions from "firebase-functions/v1"

import { getSupabase } from "./helpers/supabase"
import { firestoreTimestampToISO } from "./helpers/database"

// ============================================================================
// Row builder
// ============================================================================
function buildJunctionRow(data: any) {
  return {
    collection_id: data.collectionId,
    recipe_id: data.recipeId,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
  }
}

// ============================================================================
// 1. onCreate — New junction doc → Insert into collection_recipes
// ============================================================================
export const onJunctionCollectionRecipeCreate = functions.firestore
  .document("junction_collection_recipes/{docId}")
  .onCreate(async (snapshot) => {
    const data = snapshot.data()
    const docId = snapshot.id

    if (!data.collectionId || !data.recipeId) {
      console.error(
        `[onJCRCreate] Document ${docId} missing collectionId or recipeId — skipping`
      )
      return
    }

    console.log(
      `[onJCRCreate] Syncing junction (collection: ${data.collectionId}, recipe: ${data.recipeId})`
    )

    try {
      const supabase = getSupabase()
      const row = buildJunctionRow(data)

      const { error } = await supabase.from("collection_recipes").insert(row)

      if (error) {
        // 23505 = duplicate key — pair already exists (backfill race)
        if (error.code === "23505") {
          console.log(`[onJCRCreate] Junction already exists — skipping`)
          return
        }
        // 23503 = FK violation — parent collection or recipe not yet in Supabase
        if (error.code === "23503") {
          console.log(
            `[onJCRCreate] FK violation — collection or recipe not yet in Supabase. ` +
              `Will be picked up by backfill.`
          )
          return
        }
        console.error(`[onJCRCreate] Failed to insert junction:`, error.message)
        return
      }

      console.log(`[onJCRCreate] ✓ Synced junction ${docId}`)
    } catch (err: any) {
      console.error(`[onJCRCreate] Unexpected error:`, err.message || err)
    }
  })

// ============================================================================
// 2. onDelete — Delete the (collection_id, recipe_id) pair from Supabase
// ============================================================================
export const onJunctionCollectionRecipeDelete = functions.firestore
  .document("junction_collection_recipes/{docId}")
  .onDelete(async (snapshot) => {
    const data = snapshot.data()
    const docId = snapshot.id
    const { collectionId, recipeId } = data

    if (!collectionId || !recipeId) {
      console.error(
        `[onJCRDelete] Document ${docId} missing collectionId or recipeId — cannot delete`
      )
      return
    }

    console.log(
      `[onJCRDelete] Removing recipe ${recipeId} from collection ${collectionId}`
    )

    try {
      const supabase = getSupabase()

      const { error } = await supabase
        .from("collection_recipes")
        .delete()
        .eq("collection_id", collectionId)
        .eq("recipe_id", recipeId)

      if (error) {
        console.error(`[onJCRDelete] Failed to delete junction:`, error.message)
        return
      }

      console.log(
        `[onJCRDelete] ✓ Removed recipe ${recipeId} from collection ${collectionId}`
      )
    } catch (err: any) {
      console.error(`[onJCRDelete] Unexpected error:`, err.message || err)
    }
  })