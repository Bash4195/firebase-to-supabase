// Migrates a single recipe (by Firestore document ID) from Firebase to Supabase.
// Useful for retrying recipes that failed during the bulk migration.
//
// Usage:
//   npx ts-node migrate_single_recipe.ts <recipeId>
//   npx ts-node migrate_single_recipe.ts <recipeId1> <recipeId2> <recipeId3>
//   npx ts-node migrate_single_recipe.ts id1,id2,id3

import * as admin from "firebase-admin"
import * as fs from "fs"
import * as path from "path"
import { Pool } from "pg"
import { v4 as uuidv4 } from "uuid"

import { firebaseUidToUuid } from "../helpers/firebaseUidToUuid"

// --- Configuration ---
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!

// --- Validate config ---
if (!SUPABASE_DB_URL) {
  console.error("ERROR: SUPABASE_DB_URL must be set in .env")
  process.exit(1)
}
if (!process.env.FB_UID_NAMESPACE) {
  console.error("ERROR: FB_UID_NAMESPACE must be set in .env")
  process.exit(1)
}

// --- CLI Args ---
// Accept IDs as separate args or comma-separated in a single arg
const rawArgs = process.argv.slice(2)
if (rawArgs.length === 0) {
  console.error("Usage: npx ts-node migrate_single_recipe.ts <recipeId> [recipeId2 ...]")
  console.error("       npx ts-node migrate_single_recipe.ts id1,id2,id3")
  process.exit(1)
}

const recipeIds: string[] = rawArgs
  .flatMap((arg) => arg.split(","))
  .map((id) => id.trim())
  .filter(Boolean)

if (recipeIds.length === 0) {
  console.error("ERROR: No valid recipe IDs provided.")
  process.exit(1)
}

// --- Initialize Firebase Admin ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  })
}
const db = admin.firestore()

// --- Postgres Pool ---
const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
})

// ============================================================
// Helpers (same as the bulk migration script)
// ============================================================

/**
 * Convert a Firestore Timestamp or { seconds, nanoseconds } to ISO string
 */
function firestoreTimestampToISO(ts: any): string | null {
  if (!ts) return null
  if (ts.toDate && typeof ts.toDate === "function") {
    return ts.toDate().toISOString()
  }
  if (ts._seconds !== undefined) {
    return new Date(ts._seconds * 1000).toISOString()
  }
  if (ts.seconds !== undefined) {
    return new Date(ts.seconds * 1000).toISOString()
  }
  return null
}

/**
 * Convert a Firestore Timestamp to a date string (YYYY-MM-DD)
 */
function firestoreTimestampToDate(ts: any): string | null {
  const iso = firestoreTimestampToISO(ts)
  if (!iso) return null
  return iso.split("T")[0]
}

/**
 * Parse a date value from various formats into an ISO 8601 string suitable for timestamptz.
 * Handles Firestore Timestamps, ISO strings, date-only strings, unix timestamps, etc.
 * Returns null if the value cannot be parsed into a valid date.
 */
function parseDateToISO(val: any): string | null {
  if (val === null || val === undefined) return null

  // If it's an object, try Firestore Timestamp conversion
  if (typeof val === "object") {
    return firestoreTimestampToISO(val)
  }

  // If it's a number, treat as unix timestamp (seconds or ms)
  if (typeof val === "number") {
    if (isNaN(val) || !isFinite(val)) return null
    // Heuristic: values > 1e10 are likely ms, smaller are seconds
    const ms = val > 1e10 ? val : val * 1000
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }

  // String: coerce and trim
  const str = String(val).trim()
  if (!str || str === "undefined" || str === "null" || str === "Invalid Date") return null

  // Try direct Date parse (handles ISO 8601 and many common formats)
  const d = new Date(str)
  if (!isNaN(d.getTime())) return d.toISOString()

  // Try YYYY-MM-DD strictly (some runtimes reject this in `new Date()`)
  const dateOnlyMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnlyMatch) {
    const d2 = new Date(+dateOnlyMatch[1], +dateOnlyMatch[2] - 1, +dateOnlyMatch[3], 12, 0, 0)
    if (!isNaN(d2.getTime())) return d2.toISOString()
  }

  // Try MM/DD/YYYY
  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    const d3 = new Date(+slashMatch[3], +slashMatch[1] - 1, +slashMatch[2], 12, 0, 0)
    if (!isNaN(d3.getTime())) return d3.toISOString()
  }

  // Unparseable — let it become NULL rather than crashing the migration
  return null
}

/**
 * Escape a string for use in SQL (prevent SQL injection in migration scripts)
 */
function escSql(val: string | null | undefined): string {
  if (val === null || val === undefined) return "NULL"
  // Coerce to string in case a non-string value slips through
  const str = typeof val === "string" ? val : String(val)
  // Escape single quotes by doubling them
  return `'${str.replace(/'/g, "''")}'`
}

/**
 * Escape a value as a SQL literal
 */
function sqlVal(val: any, type?: string): string {
  if (val === null || val === undefined) return "NULL"
  if (type === "boolean") return val ? "TRUE" : "FALSE"
  if (type === "number" || type === "integer") {
    const num = Number(val)
    if (isNaN(num) || !isFinite(num)) return "NULL"
    return String(num)
  }
  if (type === "jsonb") return `${escSql(JSON.stringify(val))}::jsonb`
  if (type === "text[]") {
    if (!Array.isArray(val)) val = [val]
    const elements = val.map((v: string) => escSql(v)).join(",")
    return `ARRAY[${elements}]::text[]`
  }
  if (type === "uuid") return `${escSql(val)}::uuid`
  if (type === "timestamptz") {
    // Handle Firestore Timestamp objects, numeric timestamps, and string dates
    if (typeof val === "object") {
      const iso = firestoreTimestampToISO(val)
      if (!iso) return "NULL"
      return `${escSql(iso)}::timestamptz`
    }
    const str = String(val)
    if (!str || str === "undefined" || str === "null") return "NULL"
    return `${escSql(str)}::timestamptz`
  }
  if (type === "date") {
    if (typeof val === "object") {
      const d = firestoreTimestampToDate(val)
      if (!d) return "NULL"
      return `${escSql(d)}::date`
    }
    const str = String(val)
    if (!str || str === "undefined" || str === "null") return "NULL"
    return `${escSql(str)}::date`
  }
  if (type === "enum") return escSql(val)
  return escSql(String(val))
}

/**
 * Truncate string to max length
 */
function truncate(str: string | null | undefined, maxLen: number): string | null {
  if (!str) return null
  return str.length > maxLen ? str.substring(0, maxLen) : str
}

/**
 * Returns a positive number, or null
 */
function safePositiveNumber(val: any): number | null {
  if (val === null || val === undefined) return null
  const num = Number(val)
  if (isNaN(num) || !isFinite(num)) return null
  return Math.abs(num)
}

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

/**
 * Map Firebase ingredient category_id to Supabase enum value
 */
function mapIngredientCategory(val: string | null | undefined): string | null {
  if (!val || val === "") return null
  // The Firebase enum values should match the Supabase enum values
  const validCategories = [
    "alcohol",
    "baking",
    "beverages",
    "bread-and-bakery",
    "canned-goods",
    "cereal-and-breakfast-foods",
    "coffee-and-tea",
    "condiments-and-sauces",
    "dairy-and-eggs",
    "fish-and-seafood",
    "frozen-foods",
    "fruits-and-vegetables",
    "herbs-and-spices",
    "meat-and-poultry",
    "pasta-and-noodles",
    "rice-and-grains",
    "snacks",
    "other",
  ]
  return validCategories.includes(val) ? val : null
}

// ============================================================
// Per-recipe result tracking
// ============================================================

interface RecipeResult {
  recipeId: string
  title?: string
  status: "success" | "failed" | "not_found"
  recipeInserted: boolean
  ingredientsInserted: number
  ingredientsFailed: number
  instructionsInserted: number
  instructionsFailed: number
  error?: string
  ingredientErrors: { index: number; error: string }[]
  instructionErrors: { index: number; error: string }[]
}

// ============================================================
// Core: migrate a single recipe
// ============================================================

async function migrateSingleRecipe(recipeId: string): Promise<RecipeResult> {
  const result: RecipeResult = {
    recipeId,
    status: "failed",
    recipeInserted: false,
    ingredientsInserted: 0,
    ingredientsFailed: 0,
    instructionsInserted: 0,
    instructionsFailed: 0,
    ingredientErrors: [],
    instructionErrors: [],
  }

  console.log(`\n--- Migrating recipe: ${recipeId} ---`)

  // 1. Fetch the recipe document from Firestore
  let doc: admin.firestore.DocumentSnapshot
  try {
    doc = await db.collection("recipes").doc(recipeId).get()
  } catch (err: any) {
    result.status = "failed"
    result.error = `Firestore fetch error: ${err.message}`
    console.error(`  ✗ Firestore fetch failed: ${err.message}`)
    return result
  }

  if (!doc.exists) {
    result.status = "not_found"
    result.error = "Recipe document not found in Firestore"
    console.error(`  ✗ Recipe not found in Firestore collection "recipes"`)
    return result
  }

  const data = doc.data()!
  const firebaseUserId = data.userId

  if (!firebaseUserId) {
    result.status = "failed"
    result.error = "Missing userId field on recipe document"
    console.error(`  ✗ Recipe is missing a userId field`)
    return result
  }

  result.title = data.title || "(untitled)"
  const supabaseUserId = firebaseUidToUuid(firebaseUserId)

  const client = await pool.connect()
  try {
    // 2. Delete any existing partial data for this recipe (clean slate for retry)
    console.log(`  Cleaning up any existing data for ${recipeId}...`)
    await client.query(`DELETE FROM public.recipe_ingredients WHERE recipe_id = ${sqlVal(recipeId, "uuid")}`)
    await client.query(`DELETE FROM public.recipe_instructions WHERE recipe_id = ${sqlVal(recipeId, "uuid")}`)
    await client.query(`DELETE FROM public.recipes WHERE id = ${sqlVal(recipeId, "uuid")}`)

    // 3. Build and insert the recipe row
    const socialMediaImported = data.socialMediaImported || false
    const imageImported = data.imageImported || false
    const textImported = data.textImported || false
    const aiGenerated = data.aiGenerated || false
    const imported = data.imported || false
    const manual = !socialMediaImported && !imageImported && !textImported && !aiGenerated && !imported

    const importedFromApp = mapImportedFromApp(data.importedFromApp)
    const authors = validateAuthors(data.authors)
    const aggregateRating = validateAggregateRating(data.aggregateRating)
    const video = validateVideo(data.video)
    const keywords = toTextArray(data.keywords)
    const category = toTextArray(data.category)
    const cuisine = toTextArray(data.cuisine)
    const prepTime = normalizeTime(data.prepTime)
    const cookTime = normalizeTime(data.cookTime)
    const totalTime = normalizeTime(data.totalTime)
    const createdAt = firestoreTimestampToISO(data._created) || new Date().toISOString()
    const updatedAt = firestoreTimestampToISO(data._updated) || createdAt

    const recipeSql = `
      INSERT INTO public.recipes (
        id, created_at, updated_at, user_id,
        title, description, image_url,
        prep_time_hours, prep_time_minutes,
        cook_time_hours, cook_time_minutes,
        total_time_hours, total_time_minutes,
        servings,
        source_name, source_url,
        authors, date_published, date_modified,
        keywords, category, cuisine,
        aggregate_rating,
        nutrition_serving_size, nutrition_calories,
        nutrition_carbohydrate_content, nutrition_cholesterol_content,
        nutrition_fat_content, nutrition_fiber_content,
        nutrition_protein_content, nutrition_saturated_fat_content,
        nutrition_sodium_content, nutrition_sugar_content,
        nutrition_trans_fat_content, nutrition_unsaturated_fat_content,
        video, notes,
        social_media_imported, image_imported, text_imported,
        ai_generated, imported, manual,
        imported_from_app
      ) VALUES (
        ${sqlVal(recipeId, "uuid")},
        ${sqlVal(createdAt, "timestamptz")},
        ${sqlVal(updatedAt, "timestamptz")},
        ${sqlVal(supabaseUserId, "uuid")},
        ${sqlVal(truncate(data.title || "Recipe title", 500))},
        ${sqlVal(truncate(data.description, 5000))},
        ${sqlVal(truncate(data.image?.url, 2000))},
        ${sqlVal(prepTime.hours, "number")},
        ${sqlVal(prepTime.minutes, "number")},
        ${sqlVal(cookTime.hours, "number")},
        ${sqlVal(cookTime.minutes, "number")},
        ${sqlVal(totalTime.hours, "number")},
        ${sqlVal(totalTime.minutes, "number")},
        ${sqlVal(safePositiveNumber(data.servings), "number")},
        ${sqlVal(truncate(data.source?.name, 500))},
        ${sqlVal(truncate(data.source?.url, 2000))},
        ${sqlVal(authors, "jsonb")},
        ${sqlVal(parseDateToISO(data.datePublished), "timestamptz")},
        ${sqlVal(parseDateToISO(data.dateModified), "timestamptz")},
        ${keywords ? sqlVal(keywords, "text[]") : "NULL"},
        ${category ? sqlVal(category, "text[]") : "NULL"},
        ${cuisine ? sqlVal(cuisine, "text[]") : "NULL"},
        ${sqlVal(aggregateRating, "jsonb")},
        ${sqlVal(truncate(data.nutrition?.servingSize, 200))},
        ${sqlVal(truncate(data.nutrition?.calories, 200))},
        ${sqlVal(truncate(data.nutrition?.carbohydrateContent, 200))},
        ${sqlVal(truncate(data.nutrition?.cholesterolContent, 200))},
        ${sqlVal(truncate(data.nutrition?.fatContent, 200))},
        ${sqlVal(truncate(data.nutrition?.fiberContent, 200))},
        ${sqlVal(truncate(data.nutrition?.proteinContent, 200))},
        ${sqlVal(truncate(data.nutrition?.saturatedFatContent, 200))},
        ${sqlVal(truncate(data.nutrition?.sodiumContent, 200))},
        ${sqlVal(truncate(data.nutrition?.sugarContent, 200))},
        ${sqlVal(truncate(data.nutrition?.transFatContent, 200))},
        ${sqlVal(truncate(data.nutrition?.unsaturatedFatContent, 200))},
        ${sqlVal(video, "jsonb")},
        ${sqlVal(truncate(data.notes, 5000))},
        ${sqlVal(socialMediaImported, "boolean")},
        ${sqlVal(imageImported, "boolean")},
        ${sqlVal(textImported, "boolean")},
        ${sqlVal(aiGenerated, "boolean")},
        ${sqlVal(imported, "boolean")},
        ${sqlVal(manual, "boolean")},
        ${importedFromApp ? sqlVal(importedFromApp, "enum") : "NULL"}
      )
    `

    await client.query(recipeSql)
    result.recipeInserted = true
    console.log(`  ✓ Recipe inserted: "${result.title}"`)

    // 4. Insert ingredients (individually for better error isolation)
    const ingredients: any[] = data.ingredients || []
    for (let i = 0; i < ingredients.length; i++) {
      const ing = ingredients[i]
      const ingText = truncate(ing.name || ing.text || ing.description || "", 500)
      if (!ingText && !ing.isGroupHeader) continue

      try {
        await client.query(`
          INSERT INTO public.recipe_ingredients (
            id, recipe_id, text, description, quantity, quantity2,
            unit_of_measure, unit_of_measure_id, is_group_header,
            category_id, sort_order
          ) VALUES (
            ${sqlVal(ing.id || uuidv4(), "uuid")},
            ${sqlVal(recipeId, "uuid")},
            ${sqlVal(ingText)},
            ${sqlVal(truncate(ing.description, 500))},
            ${sqlVal(safePositiveNumber(ing.quantity), "number")},
            ${sqlVal(safePositiveNumber(ing.quantity2), "number")},
            ${sqlVal(truncate(ing.unitOfMeasure, 200))},
            ${sqlVal(truncate(ing.unitOfMeasureID, 200))},
            ${sqlVal(ing.isGroupHeader || false, "boolean")},
            ${mapIngredientCategory(ing.category_id) ? sqlVal(mapIngredientCategory(ing.category_id), "enum") : "NULL"},
            ${sqlVal(i, "number")}
          )
        `)
        result.ingredientsInserted++
      } catch (err: any) {
        result.ingredientsFailed++
        result.ingredientErrors.push({ index: i, error: err.message })
        console.error(`  ✗ Ingredient [${i}] failed: ${err.message}`)
      }
    }

    // 5. Insert instructions (individually for better error isolation)
    const instructions: any[] = data.instructions || []
    for (let i = 0; i < instructions.length; i++) {
      const inst = instructions[i]
      const instText = truncate(inst.text || "", 5000)
      if (!instText) continue

      let imageUrl: string | null = null
      if (inst.image) {
        imageUrl = Array.isArray(inst.image) ? inst.image[0] || null : inst.image
      }

      try {
        await client.query(`
          INSERT INTO public.recipe_instructions (
            id, recipe_id, text, is_group_header, url, image_url, sort_order
          ) VALUES (
            ${sqlVal(inst.id || uuidv4(), "uuid")},
            ${sqlVal(recipeId, "uuid")},
            ${sqlVal(instText)},
            ${sqlVal(inst.isGroupHeader || false, "boolean")},
            ${sqlVal(truncate(inst.url, 2000))},
            ${sqlVal(truncate(imageUrl, 2000))},
            ${sqlVal(i, "number")}
          )
        `)
        result.instructionsInserted++
      } catch (err: any) {
        result.instructionsFailed++
        result.instructionErrors.push({ index: i, error: err.message })
        console.error(`  ✗ Instruction [${i}] failed: ${err.message}`)
      }
    }

    // Determine overall status
    if (result.ingredientsFailed === 0 && result.instructionsFailed === 0) {
      result.status = "success"
    } else {
      // Recipe row was inserted but some children failed — still a partial success
      result.status = "failed"
      result.error = `${result.ingredientsFailed} ingredient(s) and ${result.instructionsFailed} instruction(s) failed`
    }

    console.log(
      `  Summary: recipe=✓ | ingredients=${result.ingredientsInserted}✓ ${result.ingredientsFailed}✗ | instructions=${result.instructionsInserted}✓ ${result.instructionsFailed}✗`
    )
  } catch (err: any) {
    result.status = "failed"
    result.error = err.message
    console.error(`  ✗ Recipe insert failed: ${err.message}`)
  } finally {
    client.release()
  }

  return result
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("==============================================")
  console.log(" Firebase → Supabase: Single Recipe Migration")
  console.log("==============================================")
  console.log(`Recipe IDs: ${recipeIds.join(", ")}`)
  console.log(`Database:   ${SUPABASE_DB_URL.replace(/:[^:@]+@/, ":***@")}`)
  console.log("")

  const startTime = Date.now()
  const setupClient = await pool.connect()
  console.log("✓ Connected to Supabase Postgres")

  const results: RecipeResult[] = []

  try {
    // Disable triggers (same as bulk script)
    console.log("\nDisabling triggers...")
    await setupClient.query(`ALTER TABLE public.recipes DISABLE TRIGGER recipes_paywall_insert`)
    await setupClient.query(`ALTER TABLE public.recipes DISABLE TRIGGER set_updated_at`)
    console.log("✓ Triggers disabled")

    // Migrate each requested recipe
    for (const recipeId of recipeIds) {
      const result = await migrateSingleRecipe(recipeId)
      results.push(result)
    }
  } finally {
    // Re-enable triggers
    console.log("\nRe-enabling triggers...")
    await setupClient.query(`ALTER TABLE public.recipes ENABLE TRIGGER recipes_paywall_insert`)
    await setupClient.query(`ALTER TABLE public.recipes ENABLE TRIGGER set_updated_at`)
    console.log("✓ Triggers re-enabled")

    setupClient.release()
  }

  await pool.end()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // --- Final Report ---
  console.log("")
  console.log("==============================================")
  console.log(" Results")
  console.log("==============================================")
  console.log(`Time elapsed: ${elapsed}s`)
  console.log(`Total recipes: ${results.length}`)
  console.log(`  Succeeded:   ${results.filter((r) => r.status === "success").length}`)
  console.log(`  Failed:      ${results.filter((r) => r.status === "failed").length}`)
  console.log(`  Not found:   ${results.filter((r) => r.status === "not_found").length}`)
  console.log("")

  for (const r of results) {
    const icon = r.status === "success" ? "✓" : r.status === "not_found" ? "?" : "✗"
    const titleStr = r.title ? ` "${r.title}"` : ""
    console.log(`  ${icon} ${r.recipeId}${titleStr} — ${r.status}${r.error ? ` (${r.error})` : ""}`)
    if (r.ingredientErrors.length > 0) {
      for (const e of r.ingredientErrors) {
        console.log(`      Ingredient [${e.index}]: ${e.error}`)
      }
    }
    if (r.instructionErrors.length > 0) {
      for (const e of r.instructionErrors) {
        console.log(`      Instruction [${e.index}]: ${e.error}`)
      }
    }
  }

  // Write detailed results to file
  const outputFile = path.join(__dirname, "single_recipe_migration_results.json")
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2))
  console.log(`\nDetailed results written to: ${outputFile}`)

  // Exit with error code if any failed
  const hasFailures = results.some((r) => r.status !== "success")
  if (hasFailures) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
