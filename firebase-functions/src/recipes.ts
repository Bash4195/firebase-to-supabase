import { admin } from "./admin"
import * as functions from "firebase-functions/v1"
import { SupabaseClient } from "@supabase/supabase-js"
import { v4 as uuidv4 } from "uuid"

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"
import {
  firestoreTimestampToISO,
  mapIngredientCategory,
  parseDateToISO,
  safePositiveNumber,
  truncate,
} from "./helpers/database"

/**
 * Map Firebase importedFromApp values to Supabase enum
 */
function mapImportedFromApp(val: string | null | undefined): string | null {
  if (!val) return null
  const map: Record<string, string | null> = {
    flavorish: null,
    Flavorish: null,
    cookbook: "cookbook",
    CookBook: "cookbook",
    mrCook: "mrCook",
    MrCook: "mrCook",
    paprika: "paprika",
    Paprika: "paprika",
    recipeKeeper: "recipeKeeper",
    RecipeKeeper: "recipeKeeper",
  }
  return map[val] ?? null
}

/**
 * Normalize keywords/category/cuisine to a string array
 */
function toTextArray(val: any): string[] | null {
  if (!val) return null
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string" && v.trim())
  if (typeof val === "string" && val.trim()) {
    // Split comma-separated string into array
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return null
}

/**
 * Normalize a time object { hours, minutes } so that:
 * - Overflow minutes are converted to hours (e.g. 75 min → 1h 15min)
 * - Hours are capped at 999
 * - Minutes are capped at 59
 * - Returns null if both values are null/undefined/invalid
 */
function normalizeTime(time: { hours?: number; minutes?: number } | undefined | null): {
  hours: number | null
  minutes: number | null
} {
  if (!time) return { hours: null, minutes: null }

  let hours = typeof time.hours === "number" && !isNaN(time.hours) ? Math.max(0, Math.floor(time.hours)) : 0
  let minutes = typeof time.minutes === "number" && !isNaN(time.minutes) ? Math.max(0, Math.floor(time.minutes)) : 0

  // Both zero and both were originally absent → treat as null
  if (hours === 0 && minutes === 0 && time.hours == null && time.minutes == null) {
    return { hours: null, minutes: null }
  }

  // Convert overflow minutes to hours
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60)
    minutes = minutes % 60
  }

  // Cap at schema maximums
  if (hours > 999) {
    hours = 999
    minutes = 59 // Max out minutes too since hours overflowed
  }

  return { hours, minutes }
}

/**
 * Validate and transform authors from Firebase to Supabase format.
 * Both use: { name?: string, url?: string }[]
 */
function validateAuthors(val: any): any[] | null {
  if (!Array.isArray(val) || val.length === 0) return null

  const result: any[] = []
  for (const item of val) {
    if (typeof item !== "object" || item === null) continue

    const entry: Record<string, any> = {}
    if (typeof item.name === "string" && item.name.trim()) entry.name = item.name.trim()
    if (typeof item.url === "string" && item.url.trim()) entry.url = item.url.trim()

    // Only include if at least one field is present
    if (Object.keys(entry).length > 0) result.push(entry)
  }

  return result.length > 0 ? result : null
}

/**
 * Validate and transform aggregateRating from Firebase to Supabase format.
 * Firebase: { ratingValue?: string, ratingCount?: string }
 * Supabase: { rating_value?: number, rating_count?: number }
 */
function validateAggregateRating(val: any): Record<string, any> | null {
  if (typeof val !== "object" || val === null) return null

  const result: Record<string, any> = {}

  // Convert from camelCase string → snake_case number
  const ratingValue = parseFloat(val.ratingValue ?? val.rating_value)
  if (!isNaN(ratingValue)) result.rating_value = ratingValue

  const ratingCount = parseFloat(val.ratingCount ?? val.rating_count)
  if (!isNaN(ratingCount)) result.rating_count = ratingCount

  return Object.keys(result).length > 0 ? result : null
}

/**
 * Validate and transform video from Firebase to Supabase format.
 * Firebase: { name?, description?, thumbnailUrl?: string[], contentUrl, embedUrl?, uploadDate?, duration?: { hours, minutes } }
 * Supabase: { name?, description?, thumbnail_url?: string[], content_url?, embed_url?, upload_date?, duration?: { hours?, minutes? } }
 */
function validateVideo(val: any): Record<string, any> | null {
  if (typeof val !== "object" || val === null) return null

  const result: Record<string, any> = {}

  if (typeof val.name === "string" && val.name.trim()) result.name = val.name.trim()
  if (typeof val.description === "string" && val.description.trim()) result.description = val.description.trim()

  // thumbnailUrl → thumbnail_url
  const thumbs = val.thumbnailUrl ?? val.thumbnail_url
  if (Array.isArray(thumbs)) {
    const validThumbs = thumbs.filter((t: any) => typeof t === "string" && t.trim())
    if (validThumbs.length > 0) result.thumbnail_url = validThumbs
  }

  // contentUrl → content_url
  const contentUrl = val.contentUrl ?? val.content_url
  if (typeof contentUrl === "string" && contentUrl.trim()) result.content_url = contentUrl.trim()

  // embedUrl → embed_url
  const embedUrl = val.embedUrl ?? val.embed_url
  if (typeof embedUrl === "string" && embedUrl.trim()) result.embed_url = embedUrl.trim()

  // uploadDate → upload_date
  const uploadDate = val.uploadDate ?? val.upload_date
  if (typeof uploadDate === "string" && uploadDate.trim()) result.upload_date = uploadDate.trim()

  // duration
  if (typeof val.duration === "object" && val.duration !== null) {
    const dur: Record<string, any> = {}
    if (typeof val.duration.hours === "number") dur.hours = val.duration.hours
    if (typeof val.duration.minutes === "number") dur.minutes = val.duration.minutes
    if (Object.keys(dur).length > 0) result.duration = dur
  }

  // Must have at least content_url to be meaningful
  return result.content_url ? result : null
}

// ============================================================================
// Row builders
// ============================================================================
function buildRecipeRow(recipeId: string, data: any) {
  const supabaseUserId = firebaseUidToUuid(data.userId)

  const socialMediaImported = data.socialMediaImported || false
  const imageImported = data.imageImported || false
  const textImported = data.textImported || false
  const aiGenerated = data.aiGenerated || false
  const imported = data.imported || false
  const manual = !socialMediaImported && !imageImported && !textImported && !aiGenerated && !imported

  const prepTime = normalizeTime(data.prepTime)
  const cookTime = normalizeTime(data.cookTime)
  const totalTime = normalizeTime(data.totalTime)

  return {
    id: recipeId,
    user_id: supabaseUserId,
    created_at: firestoreTimestampToISO(data._created) || new Date().toISOString(),
    updated_at: firestoreTimestampToISO(data._updated) || new Date().toISOString(),

    title: truncate(data.title || "Recipe title", 500)!,
    description: truncate(data.description, 5000) || null,
    image_url: truncate(data.image?.url, 2000) || null,

    prep_time_hours: prepTime.hours,
    prep_time_minutes: prepTime.minutes,
    cook_time_hours: cookTime.hours,
    cook_time_minutes: cookTime.minutes,
    total_time_hours: totalTime.hours,
    total_time_minutes: totalTime.minutes,

    servings: safePositiveNumber(data.servings),

    source_name: truncate(data.source?.name, 500) || null,
    source_url: truncate(data.source?.url, 2000) || null,

    authors: validateAuthors(data.authors),
    date_published: parseDateToISO(data.datePublished),
    date_modified: parseDateToISO(data.dateModified),

    keywords: toTextArray(data.keywords),
    category: toTextArray(data.category),
    cuisine: toTextArray(data.cuisine),

    aggregate_rating: validateAggregateRating(data.aggregateRating),

    nutrition_serving_size: truncate(data.nutrition?.servingSize, 200) || null,
    nutrition_calories: truncate(data.nutrition?.calories, 200) || null,
    nutrition_carbohydrate_content: truncate(data.nutrition?.carbohydrateContent, 200) || null,
    nutrition_cholesterol_content: truncate(data.nutrition?.cholesterolContent, 200) || null,
    nutrition_fat_content: truncate(data.nutrition?.fatContent, 200) || null,
    nutrition_fiber_content: truncate(data.nutrition?.fiberContent, 200) || null,
    nutrition_protein_content: truncate(data.nutrition?.proteinContent, 200) || null,
    nutrition_saturated_fat_content: truncate(data.nutrition?.saturatedFatContent, 200) || null,
    nutrition_sodium_content: truncate(data.nutrition?.sodiumContent, 200) || null,
    nutrition_sugar_content: truncate(data.nutrition?.sugarContent, 200) || null,
    nutrition_trans_fat_content: truncate(data.nutrition?.transFatContent, 200) || null,
    nutrition_unsaturated_fat_content: truncate(data.nutrition?.unsaturatedFatContent, 200) || null,

    video: validateVideo(data.video),
    notes: truncate(data.notes, 5000) || null,

    social_media_imported: socialMediaImported,
    image_imported: imageImported,
    text_imported: textImported,
    ai_generated: aiGenerated,
    imported: imported,
    manual: manual,
    imported_from_app: mapImportedFromApp(data.importedFromApp),
  }
}

function buildIngredientRows(recipeId: string, ingredients: any[]): Record<string, any>[] {
  if (!Array.isArray(ingredients)) return []

  return ingredients
    .map((ing, i) => {
      const text = truncate(ing.name || ing.text || ing.description || "", 500)
      if (!text && !ing.isGroupHeader) return null

      return {
        id: ing.id || uuidv4(),
        recipe_id: recipeId,
        text: text || "",
        description: truncate(ing.description, 500) || null,
        quantity: safePositiveNumber(ing.quantity),
        quantity2: safePositiveNumber(ing.quantity2),
        unit_of_measure: truncate(ing.unitOfMeasure, 200) || null,
        unit_of_measure_id: truncate(ing.unitOfMeasureID, 200) || null,
        is_group_header: ing.isGroupHeader || false,
        category_id: mapIngredientCategory(ing.category_id),
        sort_order: i,
      }
    })
    .filter(Boolean) as Record<string, any>[]
}

function buildInstructionRows(recipeId: string, instructions: any[]): Record<string, any>[] {
  if (!Array.isArray(instructions)) return []

  return instructions
    .map((inst, i) => {
      const text = truncate(inst.text || "", 5000)
      if (!text) return null

      let imageUrl: string | null = null
      if (inst.image) {
        imageUrl = Array.isArray(inst.image) ? inst.image[0] || null : inst.image
      }

      return {
        id: inst.id || uuidv4(),
        recipe_id: recipeId,
        text,
        is_group_header: inst.isGroupHeader || false,
        url: truncate(inst.url, 2000) || null,
        image_url: truncate(imageUrl, 2000) || null,
        sort_order: i,
      }
    })
    .filter(Boolean) as Record<string, any>[]
}

// ============================================================================
// Shared insert helpers (used by both create and update)
// ============================================================================
async function insertIngredients(supabase: SupabaseClient, recipeId: string, data: any): Promise<void> {
  const rows = buildIngredientRows(recipeId, data.ingredients || [])
  if (rows.length === 0) return

  const { error } = await supabase.from("recipe_ingredients").insert(rows)
  if (error) {
    console.error(`[syncRecipe] Failed to insert ingredients for ${recipeId}:`, error.message)
  }
}

async function insertInstructions(supabase: SupabaseClient, recipeId: string, data: any): Promise<void> {
  const rows = buildInstructionRows(recipeId, data.instructions || [])
  if (rows.length === 0) return

  const { error } = await supabase.from("recipe_instructions").insert(rows)
  if (error) {
    console.error(`[syncRecipe] Failed to insert instructions for ${recipeId}:`, error.message)
  }
}

// ============================================================================
// 1. onRecipeCreate — New Firestore recipe → Insert into Supabase
// ============================================================================
export const onRecipeCreate = functions.firestore.document("recipes/{recipeId}").onCreate(async (snapshot) => {
  const data = snapshot.data()
  const recipeId = snapshot.id

  if (!data.userId) {
    console.error(`[onRecipeCreate] Recipe ${recipeId} has no userId — skipping`)
    return
  }

  console.log(`[onRecipeCreate] Syncing recipe ${recipeId} to Supabase`)

  try {
    const supabase = getSupabase()
    const recipeRow = buildRecipeRow(recipeId, data)

    const { error: recipeError } = await supabase.from("recipes").insert(recipeRow)

    if (recipeError) {
      // Duplicate key means the backfill already inserted this recipe — that's fine
      if (recipeError.code === "23505") {
        console.log(`[onRecipeCreate] Recipe ${recipeId} already exists in Supabase — skipping`)
        return
      }
      console.error(`[onRecipeCreate] Failed to insert recipe ${recipeId}:`, recipeError.message)
      return
    }

    // Insert child rows in parallel
    await Promise.all([insertIngredients(supabase, recipeId, data), insertInstructions(supabase, recipeId, data)])

    console.log(`[onRecipeCreate] ✓ Synced recipe ${recipeId}`)
  } catch (err: any) {
    console.error(`[onRecipeCreate] Unexpected error for ${recipeId}:`, err.message || err)
  }
})

// ============================================================================
// 2. onRecipeUpdate — Firestore recipe edited → Update Supabase (only if row exists)
// ============================================================================
export const onRecipeUpdate = functions.firestore.document("recipes/{recipeId}").onUpdate(async (change) => {
  const data = change.after.data()
  const recipeId = change.after.id

  if (!data.userId) {
    console.error(`[onRecipeUpdate] Recipe ${recipeId} has no userId — skipping`)
    return
  }

  console.log(`[onRecipeUpdate] Syncing recipe ${recipeId} to Supabase`)

  try {
    const supabase = getSupabase()
    const fullRow = buildRecipeRow(recipeId, data)

    // Strip fields that should never change on update.
    // updated_at is intentionally kept — the DB trigger overrides it with NOW()
    // but including it is a harmless safety net if the trigger is ever disabled.
    const { id: _id, created_at: _ca, ...updatePayload } = fullRow

    // .update() naturally affects 0 rows when the recipe doesn't exist yet
    const { data: updated, error: updateError } = await supabase
      .from("recipes")
      .update(updatePayload)
      .eq("id", recipeId)
      .select("id")

    if (updateError) {
      console.error(`[onRecipeUpdate] Failed to update recipe ${recipeId}:`, updateError.message)
      return
    }

    if (!updated || updated.length === 0) {
      console.log(`[onRecipeUpdate] Recipe ${recipeId} not found in Supabase — skipping (backfill will handle it)`)
      return
    }

    // Delete-and-reinsert ingredients & instructions.
    // Simpler and safer than diffing arrays — keeps Supabase in exact sync with Firestore.
    const [ingDel, instDel] = await Promise.all([
      supabase.from("recipe_ingredients").delete().eq("recipe_id", recipeId),
      supabase.from("recipe_instructions").delete().eq("recipe_id", recipeId),
    ])

    if (ingDel.error) {
      console.error(`[onRecipeUpdate] Failed to delete old ingredients for ${recipeId}:`, ingDel.error.message)
    }
    if (instDel.error) {
      console.error(`[onRecipeUpdate] Failed to delete old instructions for ${recipeId}:`, instDel.error.message)
    }

    await Promise.all([insertIngredients(supabase, recipeId, data), insertInstructions(supabase, recipeId, data)])

    console.log(`[onRecipeUpdate] ✓ Synced recipe ${recipeId}`)
  } catch (err: any) {
    console.error(`[onRecipeUpdate] Unexpected error for ${recipeId}:`, err.message || err)
  }
})

// ============================================================================
// 3. onRecipeDelete — Firestore recipe deleted → Delete from Supabase (if exists)
// ============================================================================
export const onRecipeDelete = functions.firestore.document("recipes/{recipeId}").onDelete(async (snapshot) => {
  const recipeId = snapshot.id

  console.log(`[onRecipeDelete] Deleting recipe ${recipeId} from Supabase`)

  try {
    const supabase = getSupabase()

    // ON DELETE CASCADE on recipe_ingredients / recipe_instructions
    // means we only need to delete the recipe row itself.
    const { error } = await supabase.from("recipes").delete().eq("id", recipeId)

    if (error) {
      console.error(`[onRecipeDelete] Failed to delete recipe ${recipeId}:`, error.message)
      return
    }

    console.log(`[onRecipeDelete] ✓ Deleted recipe ${recipeId}`)
  } catch (err: any) {
    console.error(`[onRecipeDelete] Unexpected error for ${recipeId}:`, err.message || err)
  }
})
