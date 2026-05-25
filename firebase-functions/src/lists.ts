import { admin } from "./admin"
import * as functions from "firebase-functions/v1"
import { SupabaseClient } from "@supabase/supabase-js"
import { v4 as uuidv4 } from "uuid"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import { firestoreTimestampToISO, mapIngredientCategory, safePositiveNumber, truncate } from "./helpers/database"

// ============================================================================
// Row builders
// ============================================================================

function buildListRow(listId: string, data: any) {
  const supabaseUserId = firebaseUidToUuid(data.userId)

  return {
    id: listId,
    user_id: supabaseUserId,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),
    title: truncate(data.title || "Shopping list", 500)!,
  }
}

function buildListItemRows(listId: string, items: any[]): Record<string, any>[] {
  if (!Array.isArray(items)) return []

  return items
    .map((item, i) => {
      const text = truncate(item.name || item.text || item.description || "", 500)
      // Skip items with no meaningful text that aren't group headers
      if (!text && !item.isGroupHeader) return null

      return {
        id: item.id || uuidv4(),
        list_id: listId,
        text: text || "",
        description: truncate(item.description, 500) || null,
        quantity: safePositiveNumber(item.quantity),
        quantity2: safePositiveNumber(item.quantity2),
        unit_of_measure: truncate(item.unitOfMeasure, 200) || null,
        unit_of_measure_id: truncate(item.unitOfMeasureID, 200) || null,
        is_group_header: item.isGroupHeader || false,
        checked: item.checked || false,
        category_id: mapIngredientCategory(item.category_id),
        notes: truncate(item.notes, 5000) || null,
        recipe_id: item.recipe?.id || null,
        sort_order: i,
      }
    })
    .filter(Boolean) as Record<string, any>[]
}

// ============================================================================
// Shared insert helper
// ============================================================================

async function insertListItems(supabase: SupabaseClient, listId: string, data: any): Promise<void> {
  const rows = buildListItemRows(listId, data.items || [])
  if (rows.length === 0) return

  const { error } = await supabase.from("list_items").insert(rows)

  if (error) {
    console.error(`[syncList] Failed to insert items for list ${listId}:`, error.message)

    // FK violation on recipe_id — the referenced recipe may not have been synced yet.
    // Retry without recipe references so the rest of the items aren't lost.
    if (error.code === "23503") {
      console.log(`[syncList] FK violation — retrying without recipe_id references`)
      const rowsWithoutRecipe = rows.map(({ recipe_id: _, ...rest }) => ({
        ...rest,
        recipe_id: null,
      }))
      const { error: retryError } = await supabase.from("list_items").insert(rowsWithoutRecipe)
      if (retryError) {
        console.error(`[syncList] Retry also failed for list ${listId}:`, retryError.message)
      }
    }
  }
}

// ============================================================================
// 1. onListCreate — New Firestore list → Insert into Supabase
// ============================================================================

export const onListCreate = functions.firestore.document("lists/{listId}").onCreate(async (snapshot) => {
  const data = snapshot.data()
  const listId = snapshot.id

  if (!data.userId) {
    console.error(`[onListCreate] List ${listId} has no userId — skipping`)
    return
  }

  console.log(`[onListCreate] Syncing list ${listId} to Supabase`)

  try {
    const supabase = getSupabase()
    const listRow = buildListRow(listId, data)

    const { error: listError } = await supabase.from("lists").insert(listRow)

    if (listError) {
      // Duplicate key means the backfill already inserted this list — that's fine
      if (listError.code === "23505") {
        console.log(`[onListCreate] List ${listId} already exists in Supabase — skipping`)
        return
      }
      console.error(`[onListCreate] Failed to insert list ${listId}:`, listError.message)
      return
    }

    await insertListItems(supabase, listId, data)

    console.log(`[onListCreate] ✓ Synced list ${listId}`)
  } catch (err: any) {
    console.error(`[onListCreate] Unexpected error for ${listId}:`, err.message || err)
  }
})

// ============================================================================
// 2. onListUpdate — Firestore list edited → Update Supabase (only if row exists)
// ============================================================================

export const onListUpdate = functions.firestore.document("lists/{listId}").onUpdate(async (change) => {
  const data = change.after.data()
  const listId = change.after.id

  if (!data.userId) {
    console.error(`[onListUpdate] List ${listId} has no userId — skipping`)
    return
  }

  console.log(`[onListUpdate] Syncing list ${listId} to Supabase`)

  try {
    const supabase = getSupabase()
    const fullRow = buildListRow(listId, data)

    // Strip fields that should never change on update.
    // updated_at is intentionally kept — the DB trigger overrides it with NOW()
    // but including it is a harmless safety net if the trigger is ever disabled.
    const { id: _id, created_at: _ca, user_id: _uid, ...updatePayload } = fullRow

    // .update() naturally affects 0 rows when the list doesn't exist yet
    const { data: updated, error: updateError } = await supabase
      .from("lists")
      .update(updatePayload)
      .eq("id", listId)
      .select("id")

    if (updateError) {
      console.error(`[onListUpdate] Failed to update list ${listId}:`, updateError.message)
      return
    }

    if (!updated || updated.length === 0) {
      console.log(`[onListUpdate] List ${listId} not found in Supabase — inserting instead`)

      // Fall back to an insert in case the backfill hasn't reached this document yet
      const insertRow = buildListRow(listId, data)
      const { error: insertError } = await supabase.from("lists").insert(insertRow)

      if (insertError && insertError.code !== "23505") {
        console.error(`[onListUpdate] Failed to insert list ${listId}:`, insertError.message)
        return
      }
    }

    // Delete-and-reinsert list items.
    // Simpler and safer than diffing arrays — keeps Supabase in exact sync with Firestore.
    const { error: deleteError } = await supabase.from("list_items").delete().eq("list_id", listId)

    if (deleteError) {
      console.error(`[onListUpdate] Failed to delete old items for list ${listId}:`, deleteError.message)
    }

    await insertListItems(supabase, listId, data)

    console.log(`[onListUpdate] ✓ Synced list ${listId}`)
  } catch (err: any) {
    console.error(`[onListUpdate] Unexpected error for ${listId}:`, err.message || err)
  }
})

// ============================================================================
// 3. onListDelete — Firestore list deleted → Delete from Supabase (if exists)
// ============================================================================

export const onListDelete = functions.firestore.document("lists/{listId}").onDelete(async (snapshot) => {
  const listId = snapshot.id

  console.log(`[onListDelete] Deleting list ${listId} from Supabase`)

  try {
    const supabase = getSupabase()

    // ON DELETE CASCADE on list_items and list_shares
    // means we only need to delete the list row itself.
    const { error } = await supabase.from("lists").delete().eq("id", listId)

    if (error) {
      console.error(`[onListDelete] Failed to delete list ${listId}:`, error.message)
      return
    }

    console.log(`[onListDelete] ✓ Deleted list ${listId}`)
  } catch (err: any) {
    console.error(`[onListDelete] Unexpected error for ${listId}:`, err.message || err)
  }
})
