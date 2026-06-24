// Migrates recipes, collections, meal plans, and lists for a SINGLE user
// from Firebase (Firestore) to Supabase (Postgres).
//
// Usage:
//   npx ts-node migrate_single_user.ts <firebaseUid> <supabaseUuid>

import * as admin from "firebase-admin"
import * as fs from "fs"
import * as path from "path"
import { Pool } from "pg"
import { v4 as uuidv4 } from "uuid"

import { firebaseUidToUuid } from "../helpers/firebaseUidToUuid"

// --- Configuration ---
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!

// Firestore collection names
const COLLECTIONS = {
  users: "users",
  recipes: "recipes",
  collections: "collections",
  junctionCollectionRecipes: "junction_collection_recipes",
  lists: "lists",
  mealPlans: "mealPlans",
}

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
const args = process.argv.slice(2)
if (args.length < 2) {
  console.error("Usage: npx ts-node migrate_single_user.ts <firebaseUid> <supabaseUuid>")
  process.exit(1)
}

const FIREBASE_UID = args[0]
const SUPABASE_UUID = args[1]
const CONCURRENCY = 12

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
  max: 15, // This is about the max connections we can use without the project running out of disk IO throughput
})

/**
 * Simple async concurrency limiter — no external dependency needed
 */
async function asyncPool<T>(
  concurrency: number,
  items: T[],
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0
  const results: Promise<void>[] = []

  async function run(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++
      await worker(items[currentIndex], currentIndex)
    }
  }

  // Start `concurrency` number of workers
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    results.push(run())
  }

  await Promise.all(results)
}

// --- Counters ---
interface MigrationCounters {
  recipes: { success: number; failed: number; errors: { id: string; error: string }[] }
  recipeIngredients: { success: number; failed: number; errors: { id: string; error: string }[] }
  recipeInstructions: { success: number; failed: number; errors: { id: string; error: string }[] }
  collections: { success: number; failed: number; errors: { id: string; error: string }[] }
  collectionRecipes: { success: number; failed: number; skipped: number; errors: { id: string; error: string }[] }
  collectionShares: { success: number; failed: number; skipped: number; errors: { id: string; error: string }[] }
  lists: { success: number; failed: number; errors: { id: string; error: string }[] }
  listItems: { success: number; failed: number; errors: { id: string; error: string }[] }
  listShares: { success: number; failed: number; skipped: number; errors: { id: string; error: string }[] }
  mealPlans: { success: number; failed: number; errors: { id: string; error: string }[] }
  mealPlanRecipes: { success: number; failed: number; skipped: number; errors: { id: string; error: string }[] }
  mealPlanShares: { success: number; failed: number; skipped: number; errors: { id: string; error: string }[] }
}

const counters: MigrationCounters = {
  recipes: { success: 0, failed: 0, errors: [] },
  recipeIngredients: { success: 0, failed: 0, errors: [] },
  recipeInstructions: { success: 0, failed: 0, errors: [] },
  collections: { success: 0, failed: 0, errors: [] },
  collectionRecipes: { success: 0, failed: 0, skipped: 0, errors: [] },
  collectionShares: { success: 0, failed: 0, skipped: 0, errors: [] },
  lists: { success: 0, failed: 0, errors: [] },
  listItems: { success: 0, failed: 0, errors: [] },
  listShares: { success: 0, failed: 0, skipped: 0, errors: [] },
  mealPlans: { success: 0, failed: 0, errors: [] },
  mealPlanRecipes: { success: 0, failed: 0, skipped: 0, errors: [] },
  mealPlanShares: { success: 0, failed: 0, skipped: 0, errors: [] },
}

// --- Set of successfully migrated recipe IDs for FK validation ---
const migratedRecipeIds = new Set<string>()

// --- Helpers ---

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

/**
 * Map Firebase share permission to Supabase enum
 */
function mapSharePermission(val: string | null | undefined): string {
  if (val === "editor") return "editor"
  return "viewer"
}

/**
 * Map Firebase meal type to Supabase enum
 */
function mapMealType(val: string | null | undefined): string | null {
  if (!val) return null
  const valid = ["breakfast", "lunch", "dinner", "snack"]
  return valid.includes(val) ? val : null
}

async function fetchSubcollection(
  parentCollection: string,
  parentId: string,
  subcollectionName: string
): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  const snapshot = await db.collection(parentCollection).doc(parentId).collection(subcollectionName).get()
  return snapshot.docs
}

// =========================================
// Migration Functions
// =========================================

async function migrateRecipes(): Promise<void> {
  console.log("\n--- Migrating Recipes ---")

  const snapshot = await db
    .collection(COLLECTIONS.recipes)
    .where("userId", "==", FIREBASE_UID)
    .get()
  const docs = snapshot.docs

  if (docs.length === 0) {
    console.log("  No recipes found for this user.")
    return
  }

  console.log(`  Found ${docs.length} recipes`)

  const before = {
    recipes: counters.recipes.success,
    recipesFailed: counters.recipes.failed,
    ingredients: counters.recipeIngredients.success,
    ingredientsFailed: counters.recipeIngredients.failed,
    instructions: counters.recipeInstructions.success,
    instructionsFailed: counters.recipeInstructions.failed,
  }

  await asyncPool(CONCURRENCY, docs, async (doc) => {
    const data = doc.data()
    const recipeId = doc.id || data.id

    const client = await pool.connect()
    try {
      // --- Build recipe INSERT ---
      const socialMediaImported = data.socialMediaImported || false
      const imageImported = data.imageImported || false
      const textImported = data.textImported || false
      const aiGenerated = data.aiGenerated || false
      const imported = data.imported || false
      // Determine manual flag
      const manual = !socialMediaImported && !imageImported && !textImported && !aiGenerated && !imported

      const importedFromApp = mapImportedFromApp(data.importedFromApp)

      const authors = validateAuthors(data.authors)
      const aggregateRating = validateAggregateRating(data.aggregateRating)
      const video = validateVideo(data.video)

      // Parse keywords/category/cuisine to TEXT[]
      const keywords = toTextArray(data.keywords)
      const category = toTextArray(data.category)
      const cuisine = toTextArray(data.cuisine)

      const prepTime = normalizeTime(data.prepTime)
      const cookTime = normalizeTime(data.cookTime)
      const totalTime = normalizeTime(data.totalTime)

      // Parse timestamps
      const createdAt = firestoreTimestampToISO(data._created) || new Date().toISOString()
      const updatedAt = firestoreTimestampToISO(data._updated) || createdAt

      // Build recipe INSERT
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
            ${sqlVal(SUPABASE_UUID, "uuid")},
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
        ON CONFLICT (id) DO NOTHING
      `

      await client.query(recipeSql)
      migratedRecipeIds.add(recipeId) // safe — unique IDs, single-threaded JS
      counters.recipes.success++

      // --- Insert ingredients (multi-row batch with individual fallback) ---
      const ingredients: any[] = data.ingredients || []
      const validIngredients: { ing: any; i: number }[] = []
      for (let i = 0; i < ingredients.length; i++) {
        const ing = ingredients[i]
        const ingText = truncate(ing.name || ing.text || ing.description || "", 500)
        // Skip empty filler ingredients (no name, no text, not a group header)
        if (!ingText && !ing.isGroupHeader) continue
        validIngredients.push({ ing, i })
      }

      if (validIngredients.length > 0) {
        // Try batch insert — single round-trip
        const valueTuples = validIngredients.map(({ ing, i }) => {
          return `(
              ${sqlVal(ing.id || uuidv4(), "uuid")},
              ${sqlVal(recipeId, "uuid")},
              ${sqlVal(truncate(ing.name || ing.text || ing.description || "", 500))},
              ${sqlVal(truncate(ing.description, 500))},
              ${sqlVal(safePositiveNumber(ing.quantity), "number")},
              ${sqlVal(safePositiveNumber(ing.quantity2), "number")},
              ${sqlVal(truncate(ing.unitOfMeasure, 200))},
              ${sqlVal(truncate(ing.unitOfMeasureID, 200))},
              ${sqlVal(ing.isGroupHeader || false, "boolean")},
              ${mapIngredientCategory(ing.category_id) ? sqlVal(mapIngredientCategory(ing.category_id), "enum") : "NULL"},
              ${sqlVal(i, "number")}
            )`
        })

        const batchSql = `
            INSERT INTO public.recipe_ingredients (
              id, recipe_id, text, description, quantity, quantity2,
              unit_of_measure, unit_of_measure_id, is_group_header,
              category_id, sort_order
            ) VALUES ${valueTuples.join(",\n")}
            ON CONFLICT (id) DO NOTHING
          `

        try {
          await client.query(batchSql)
          counters.recipeIngredients.success += validIngredients.length
        } catch (_batchErr) {
          // Fall back to individual inserts
          for (const { ing, i } of validIngredients) {
            try {
              await client.query(`
                  INSERT INTO public.recipe_ingredients (
                    id, recipe_id, text, description, quantity, quantity2,
                    unit_of_measure, unit_of_measure_id, is_group_header,
                    category_id, sort_order
                  ) VALUES (
                    ${sqlVal(ing.id || uuidv4(), "uuid")},
                    ${sqlVal(recipeId, "uuid")},
                    ${sqlVal(truncate(ing.name || ing.text || ing.description || "", 500))},
                    ${sqlVal(truncate(ing.description, 500))},
                    ${sqlVal(safePositiveNumber(ing.quantity), "number")},
                    ${sqlVal(safePositiveNumber(ing.quantity2), "number")},
                    ${sqlVal(truncate(ing.unitOfMeasure, 200))},
                    ${sqlVal(truncate(ing.unitOfMeasureID, 200))},
                    ${sqlVal(ing.isGroupHeader || false, "boolean")},
                    ${mapIngredientCategory(ing.category_id) ? sqlVal(mapIngredientCategory(ing.category_id), "enum") : "NULL"},
                    ${sqlVal(i, "number")}
                  )
                  ON CONFLICT (id) DO NOTHING
                `)
              counters.recipeIngredients.success++
            } catch (err: any) {
              counters.recipeIngredients.failed++
              counters.recipeIngredients.errors.push({
                id: `${recipeId}:ing-${i}`,
                error: err.message,
              })
            }
          }
        }
      }

      // --- Insert instructions (multi-row batch with individual fallback) ---
      const instructions: any[] = data.instructions || []

      // Filter to valid instructions (non-empty text required by NOT NULL constraint)
      const validInstructions: { inst: any; i: number }[] = []
      for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i]
        if (!truncate(inst.text || "", 5000)) continue
        validInstructions.push({ inst, i })
      }

      if (validInstructions.length > 0) {
        // Build multi-row INSERT — single round-trip
        const valueTuples = validInstructions.map(({ inst, i }) => {
          const instText = truncate(inst.text || "", 5000)
          // Handle image field: could be string or array of strings
          let imageUrl: string | null = null
          if (inst.image) {
            imageUrl = Array.isArray(inst.image) ? inst.image[0] || null : inst.image
          }
          return `(
              ${sqlVal(inst.id || uuidv4(), "uuid")},
              ${sqlVal(recipeId, "uuid")},
              ${sqlVal(instText)},
              ${sqlVal(inst.isGroupHeader || false, "boolean")},
              ${sqlVal(truncate(inst.url, 2000))},
              ${sqlVal(truncate(imageUrl, 2000))},
              ${sqlVal(i, "number")}
            )`
        })

        const batchSql = `
            INSERT INTO public.recipe_instructions (
              id, recipe_id, text, is_group_header, url, image_url, sort_order
            ) VALUES ${valueTuples.join(",\n")}
            ON CONFLICT (id) DO NOTHING
          `

        try {
          await client.query(batchSql)
          counters.recipeInstructions.success += validInstructions.length
        } catch (_batchErr) {
          // Fall back to individual inserts — isolates the problematic row(s)
          for (const { inst, i } of validInstructions) {
            try {
              const instText = truncate(inst.text || "", 5000)
              let imageUrl: string | null = null
              if (inst.image) {
                imageUrl = Array.isArray(inst.image) ? inst.image[0] || null : inst.image
              }
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
                  ON CONFLICT (id) DO NOTHING
                `)
              counters.recipeInstructions.success++
            } catch (err: any) {
              counters.recipeInstructions.failed++
              counters.recipeInstructions.errors.push({
                id: `${recipeId}:inst-${i}`,
                error: err.message,
              })
            }
          }
        }
      }
    } catch (err: any) {
      counters.recipes.failed++
      counters.recipes.errors.push({ id: recipeId, error: err.message })
    } finally {
      client.release()
    }
  })

  console.log(
    `Recipes:       ✓ ${counters.recipes.success - before.recipes} | ✗ ${counters.recipes.failed - before.recipesFailed}`
  )
  console.log(
    `Ingredients:   ✓ ${counters.recipeIngredients.success - before.ingredients} | ✗ ${counters.recipeIngredients.failed - before.ingredientsFailed}`
  )
  console.log(
    `Instructions:  ✓ ${counters.recipeInstructions.success - before.instructions} | ✗ ${counters.recipeInstructions.failed - before.instructionsFailed}`
  )
}

async function migrateCollections(): Promise<void> {
  console.log("\n--- Migrating Collections ---")

  const snapshot = await db
    .collection(COLLECTIONS.collections)
    .where("userId", "==", FIREBASE_UID)
    .get()
  const docs = snapshot.docs

  if (docs.length === 0) {
    console.log("  No collections found for this user.")
    return
  }

  console.log(`  Found ${docs.length} collections`)

  const before = {
    collections: counters.collections.success,
    collectionsFailed: counters.collections.failed,
    shares: counters.collectionShares.success,
    sharesFailed: counters.collectionShares.failed,
  }

  await asyncPool(CONCURRENCY, docs, async (doc) => {
    const data = doc.data()
    const collectionId = doc.id || data.id

    const client = await pool.connect()

    try {
      const createdAt = firestoreTimestampToISO(data._created) || new Date().toISOString()
      const updatedAt = firestoreTimestampToISO(data._updated) || createdAt

      await client.query(`
        INSERT INTO public.collections (id, created_at, updated_at, user_id, title)
        VALUES (
          ${sqlVal(collectionId, "uuid")},
          ${sqlVal(createdAt, "timestamptz")},
          ${sqlVal(updatedAt, "timestamptz")},
          ${sqlVal(SUPABASE_UUID, "uuid")},
          ${sqlVal(truncate(data.title || "Collection", 500))}
        )
        ON CONFLICT (id) DO NOTHING
      `)
      counters.collections.success++

      // --- Migrate sharedWith subcollection ---
      try {
        const shareDocs = await fetchSubcollection(COLLECTIONS.collections, doc.id, "sharedWith")
        for (const shareDoc of shareDocs) {
          const shareData = shareDoc.data()
          const sharedWithFirebaseUid = shareData.id || shareDoc.id

          if (!sharedWithFirebaseUid) {
            // skip this share
            continue
          }

          const sharedWithSupabaseId = firebaseUidToUuid(sharedWithFirebaseUid)

          try {
            await client.query(`
              INSERT INTO public.collection_shares (
                collection_id, shared_with_user_id, shared_with_email,
                created_at, updated_at, permission, nickname
              ) VALUES (
                ${sqlVal(collectionId, "uuid")},
                ${sqlVal(sharedWithSupabaseId, "uuid")},
                ${sqlVal(shareData.email)},
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._created), "timestamptz")}, NOW()),
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._updated), "timestamptz")}, NOW()),
                ${sqlVal(mapSharePermission(shareData.permission), "enum")},
                ${sqlVal(truncate(shareData.nickname, 500))}
              )
              ON CONFLICT (collection_id, shared_with_user_id) DO NOTHING
            `)
            counters.collectionShares.success++
          } catch (err: any) {
            // Likely FK violation if shared user wasn't migrated
            counters.collectionShares.failed++
            counters.collectionShares.errors.push({
              id: `${collectionId}:${sharedWithFirebaseUid}`,
              error: err.message,
            })
          }
        }
      } catch (_subErr) {
        // Subcollection might not exist
      }
    } catch (err: any) {
      counters.collections.failed++
      counters.collections.errors.push({ id: collectionId, error: err.message })
    } finally {
      client.release()
    }
  })

  console.log(
    `Collections:  ✓ ${counters.collections.success - before.collections} | ✗ ${counters.collections.failed - before.collectionsFailed}`
  )
  console.log(
    `Shares:       ✓ ${counters.collectionShares.success - before.shares} | ✗ ${counters.collectionShares.failed - before.sharesFailed}`
  )

  // --- Migrate collection_recipes from junction collection ---
  console.log("  Migrating collection_recipes from junction collection...")

  const beforeCR = {
    collectionRecipes: counters.collectionRecipes.success,
    collectionRecipesFailed: counters.collectionRecipes.failed,
    collectionRecipesSkipped: counters.collectionRecipes.skipped,
  }

  try {
    const junctionSnapshot = await db
      .collection(COLLECTIONS.junctionCollectionRecipes)
      .where("userId", "==", FIREBASE_UID)
      .get()

    const jDocs = junctionSnapshot.docs
    console.log(`  Found ${jDocs.length} collection_recipe junctions`)

    await asyncPool(CONCURRENCY, jDocs, async (jDoc) => {
      const jData = jDoc.data()
      const collectionId = jData.collectionId
      const recipeId = jData.recipeId

      if (!collectionId || !recipeId) {
        counters.collectionRecipes.skipped++
        return
      }

      // Only insert if the recipe was successfully migrated
      if (!migratedRecipeIds.has(recipeId)) {
        counters.collectionRecipes.skipped++
        return
      }

      const client = await pool.connect()
      try {
        const createdAt = firestoreTimestampToISO(jData._created) || new Date().toISOString()
        await client.query(`
          INSERT INTO public.collection_recipes (collection_id, recipe_id, created_at)
          VALUES (
            ${sqlVal(collectionId, "uuid")},
            ${sqlVal(recipeId, "uuid")},
            ${sqlVal(createdAt, "timestamptz")}
          )
          ON CONFLICT (collection_id, recipe_id) DO NOTHING
        `)
        counters.collectionRecipes.success++
      } catch (err: any) {
        counters.collectionRecipes.failed++
        counters.collectionRecipes.errors.push({ id: `${collectionId}:${recipeId}`, error: err.message })
      } finally {
        client.release()
      }
    })
  } catch (err: any) {
    console.log(`  ⚠ Could not fetch junction collection: ${err.message}`)
  }

  console.log(
    `Collection recipes:  ✓ ${counters.collectionRecipes.success - beforeCR.collectionRecipes} | ✗ ${counters.collectionRecipes.failed - beforeCR.collectionRecipesFailed}`
  )

  console.log("Collection migration complete!")
  console.log(`  Collections:       ✓ ${counters.collections.success} | ✗ ${counters.collections.failed}`)
  console.log(
    `  Collection Recipes: ✓ ${counters.collectionRecipes.success} | ⊘ ${counters.collectionRecipes.skipped} | ✗ ${counters.collectionRecipes.failed}`
  )
  console.log(
    `  Collection Shares:  ✓ ${counters.collectionShares.success} | ⊘ ${counters.collectionShares.skipped} | ✗ ${counters.collectionShares.failed}`
  )
}

async function migrateLists(): Promise<void> {
  console.log("\n--- Migrating Lists ---")

  const snapshot = await db
    .collection(COLLECTIONS.lists)
    .where("userId", "==", FIREBASE_UID)
    .get()
  const docs = snapshot.docs

  if (docs.length === 0) {
    console.log("  No lists found for this user.")
    return
  }

  console.log(`  Found ${docs.length} lists`)

  const before = {
    lists: counters.lists.success,
    listsFailed: counters.lists.failed,
    items: counters.listItems.success,
    itemsFailed: counters.listItems.failed,
    shares: counters.listShares.success,
    sharesFailed: counters.listShares.failed,
  }

  await asyncPool(CONCURRENCY, docs, async (doc) => {
    const data = doc.data()
    const listId = doc.id || data.id

    const client = await pool.connect()

    try {
      const createdAt = firestoreTimestampToISO(data._created) || new Date().toISOString()
      const updatedAt = firestoreTimestampToISO(data._updated) || createdAt

      // Insert list
      await client.query(`
        INSERT INTO public.lists (id, created_at, updated_at, user_id, title)
        VALUES (
          ${sqlVal(listId, "uuid")},
          ${sqlVal(createdAt, "timestamptz")},
          ${sqlVal(updatedAt, "timestamptz")},
          ${sqlVal(SUPABASE_UUID, "uuid")},
          ${sqlVal(truncate(data.title || "Shopping list", 500))}
        )
        ON CONFLICT (id) DO NOTHING
      `)
      counters.lists.success++

      // --- Insert list items (multi-row batch with individual fallback) ---
      const items: any[] = data.items || []
      const validItems: { item: any; i: number }[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const itemText = truncate(item.name || item.text || "", 500)
        // Skip items with no meaningful text and not a group header
        if (!itemText && !item.isGroupHeader) continue
        validItems.push({ item, i })
      }

      if (validItems.length > 0) {
        const valueTuples = validItems.map(({ item, i }) => {
          // Resolve recipe_id FK — only set if recipe was migrated
          let recipeId: string | null = item.recipe?.id || null
          if (recipeId && !migratedRecipeIds.has(recipeId)) {
            recipeId = null
          }
          return `(
            ${sqlVal(item.id, "uuid")},
            ${sqlVal(listId, "uuid")},
            ${sqlVal(truncate(item.name || item.text || item.description || "", 500))},
            ${sqlVal(truncate(item.description, 500))},
            ${sqlVal(safePositiveNumber(item.quantity), "number")},
            ${sqlVal(safePositiveNumber(item.quantity2), "number")},
            ${sqlVal(truncate(item.unitOfMeasure, 200))},
            ${sqlVal(truncate(item.unitOfMeasureID, 200))},
            ${sqlVal(item.isGroupHeader || false, "boolean")},
            ${sqlVal(item.checked || false, "boolean")},
            ${mapIngredientCategory(item.category_id) ? sqlVal(mapIngredientCategory(item.category_id), "enum") : "NULL"},
            ${sqlVal(truncate(item.notes, 5000))},
            ${recipeId ? sqlVal(recipeId, "uuid") : "NULL"},
            ${sqlVal(i, "number")}
          )`
        })

        const batchSql = `
          INSERT INTO public.list_items (
            id, list_id, text, description,
            quantity, quantity2,
            unit_of_measure, unit_of_measure_id,
            is_group_header, checked, category_id,
            notes, recipe_id, sort_order
          ) VALUES ${valueTuples.join(",\n")}
          ON CONFLICT (id) DO NOTHING
        `

        try {
          await client.query(batchSql)
          counters.listItems.success += validItems.length
        } catch (_batchErr) {
          // Fall back to individual inserts
          for (const { item, i } of validItems) {
            try {
              let recipeId: string | null = item.recipe?.id || null
              if (recipeId && !migratedRecipeIds.has(recipeId)) {
                recipeId = null
              }
              await client.query(`
                INSERT INTO public.list_items (
                  id, list_id, text, description,
                  quantity, quantity2,
                  unit_of_measure, unit_of_measure_id,
                  is_group_header, checked, category_id,
                  notes, recipe_id, sort_order
                ) VALUES (
                  ${sqlVal(item.id, "uuid")},
                  ${sqlVal(listId, "uuid")},
                  ${sqlVal(truncate(item.name || item.text || item.description || "", 500))},
                  ${sqlVal(truncate(item.description, 500))},
                  ${sqlVal(safePositiveNumber(item.quantity), "number")},
                  ${sqlVal(safePositiveNumber(item.quantity2), "number")},
                  ${sqlVal(truncate(item.unitOfMeasure, 200))},
                  ${sqlVal(truncate(item.unitOfMeasureID, 200))},
                  ${sqlVal(item.isGroupHeader || false, "boolean")},
                  ${sqlVal(item.checked || false, "boolean")},
                  ${mapIngredientCategory(item.category_id) ? sqlVal(mapIngredientCategory(item.category_id), "enum") : "NULL"},
                  ${sqlVal(truncate(item.notes, 5000))},
                  ${recipeId ? sqlVal(recipeId, "uuid") : "NULL"},
                  ${sqlVal(i, "number")}
                )
                ON CONFLICT (id) DO NOTHING
              `)
              counters.listItems.success++
            } catch (err: any) {
              counters.listItems.failed++
              counters.listItems.errors.push({
                id: `${listId}:item-${i}`,
                error: err.message,
              })
            }
          }
        }
      }

      // --- Migrate sharedWith subcollection ---
      try {
        const shareDocs = await fetchSubcollection(COLLECTIONS.lists, doc.id, "sharedWith")
        for (const shareDoc of shareDocs) {
          const shareData = shareDoc.data()
          const sharedWithFirebaseUid = shareData.id || shareDoc.id

          if (!sharedWithFirebaseUid) {
            continue
          }

          const sharedWithSupabaseId = firebaseUidToUuid(sharedWithFirebaseUid)

          try {
            await client.query(`
              INSERT INTO public.list_shares (
                list_id, shared_with_user_id, shared_with_email,
                created_at, updated_at, permission, nickname
              ) VALUES (
                ${sqlVal(listId, "uuid")},
                ${sqlVal(sharedWithSupabaseId, "uuid")},
                ${sqlVal(shareData.email)},
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._created), "timestamptz")}, NOW()),
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._updated), "timestamptz")}, NOW()),
                ${sqlVal(mapSharePermission(shareData.permission), "enum")},
                ${sqlVal(truncate(shareData.nickname, 500))}
              )
              ON CONFLICT (list_id, shared_with_user_id) DO NOTHING
            `)
            counters.listShares.success++
          } catch (err: any) {
            counters.listShares.failed++
            counters.listShares.errors.push({
              id: `${listId}:${sharedWithFirebaseUid}`,
              error: err.message,
            })
          }
        }
      } catch (_subErr) {
        // Subcollection might not exist
      }
    } catch (err: any) {
      counters.lists.failed++
      counters.lists.errors.push({ id: listId, error: err.message })
    } finally {
      client.release()
    }
  })

  console.log(`Lists:   ✓ ${counters.lists.success - before.lists} | ✗ ${counters.lists.failed - before.listsFailed}`)
  console.log(
    `Items:   ✓ ${counters.listItems.success - before.items} | ✗ ${counters.listItems.failed - before.itemsFailed}`
  )
  console.log(
    `Shares:  ✓ ${counters.listShares.success - before.shares} | ✗ ${counters.listShares.failed - before.sharesFailed}`
  )

  console.log("List migration complete!")
  console.log(`  Lists:       ✓ ${counters.lists.success} | ✗ ${counters.lists.failed}`)
  console.log(`  List Items:  ✓ ${counters.listItems.success} | ✗ ${counters.listItems.failed}`)
  console.log(
    `  List Shares: ✓ ${counters.listShares.success} | ⊘ ${counters.listShares.skipped} | ✗ ${counters.listShares.failed}`
  )
}

async function migrateMealPlans(): Promise<void> {
  console.log("\n--- Migrating Meal Plans ---")

  const snapshot = await db
    .collection(COLLECTIONS.mealPlans)
    .where("userId", "==", FIREBASE_UID)
    .get()
  const docs = snapshot.docs

  if (docs.length === 0) {
    console.log("  No meal plans found for this user.")
    return
  }

  console.log(`  Found ${docs.length} meal plans`)

  const before = {
    mealPlans: counters.mealPlans.success,
    mealPlansFailed: counters.mealPlans.failed,
    recipes: counters.mealPlanRecipes.success,
    recipesFailed: counters.mealPlanRecipes.failed,
    shares: counters.mealPlanShares.success,
    sharesFailed: counters.mealPlanShares.failed,
  }

  await asyncPool(CONCURRENCY, docs, async (doc) => {
    const data = doc.data()
    const mealPlanId = doc.id || data.id

    const client = await pool.connect()

    try {
      const createdAt = firestoreTimestampToISO(data._created) || new Date().toISOString()
      const updatedAt = firestoreTimestampToISO(data._updated) || createdAt

      await client.query(`
        INSERT INTO public.meal_plans (id, created_at, updated_at, user_id, title)
        VALUES (
          ${sqlVal(mealPlanId, "uuid")},
          ${sqlVal(createdAt, "timestamptz")},
          ${sqlVal(updatedAt, "timestamptz")},
          ${sqlVal(SUPABASE_UUID, "uuid")},
          ${sqlVal(truncate(data.title || "Meal plan", 500))}
        )
        ON CONFLICT (id) DO NOTHING
      `)
      counters.mealPlans.success++

      // --- Migrate items subcollection → meal_plan_recipes ---
      try {
        const itemDocs = await fetchSubcollection(COLLECTIONS.mealPlans, doc.id, "items")

        const validItems: { itemData: any; itemId: string }[] = []
        for (const itemDoc of itemDocs) {
          const itemData = itemDoc.data()
          const recipeId = itemData.recipe?.recipeId

          if (!recipeId) {
            counters.mealPlanRecipes.skipped++
            continue
          }

          if (!migratedRecipeIds.has(recipeId)) {
            counters.mealPlanRecipes.skipped++
            continue
          }

          const itemId = itemData.id || itemDoc.id
          const dateVal = firestoreTimestampToDate(itemData.date)

          if (!dateVal) {
            counters.mealPlanRecipes.skipped++
            continue
          }

          validItems.push({ itemData, itemId })
        }

        if (validItems.length > 0) {
          const valueTuples = validItems.map(({ itemData, itemId }) => {
            const recipeId = itemData.recipe?.recipeId
            const dateVal = firestoreTimestampToDate(itemData.date)
            return `(
              ${sqlVal(itemId, "uuid")},
              COALESCE(${sqlVal(firestoreTimestampToISO(itemData._created), "timestamptz")}, NOW()),
              COALESCE(${sqlVal(firestoreTimestampToISO(itemData._updated), "timestamptz")}, NOW()),
              ${sqlVal(mealPlanId, "uuid")},
              ${sqlVal(recipeId, "uuid")},
              ${sqlVal(dateVal, "date")},
              ${mapMealType(itemData.mealType) ? sqlVal(mapMealType(itemData.mealType), "enum") : "NULL"},
              ${sqlVal(truncate(itemData.note, 5000))}
            )`
          })

          const batchSql = `
            INSERT INTO public.meal_plan_recipes (
              id, created_at, updated_at,
              meal_plan_id, recipe_id, date, meal_type, notes
            ) VALUES ${valueTuples.join(",\n")}
            ON CONFLICT (id) DO NOTHING
          `

          try {
            await client.query(batchSql)
            counters.mealPlanRecipes.success += validItems.length
          } catch (_batchErr) {
            for (const { itemData, itemId } of validItems) {
              try {
                const recipeId = itemData.recipe?.recipeId
                const dateVal = firestoreTimestampToDate(itemData.date)
                await client.query(`
                  INSERT INTO public.meal_plan_recipes (
                    id, created_at, updated_at,
                    meal_plan_id, recipe_id, date, meal_type, notes
                  ) VALUES (
                    ${sqlVal(itemId, "uuid")},
                    COALESCE(${sqlVal(firestoreTimestampToISO(itemData._created), "timestamptz")}, NOW()),
                    COALESCE(${sqlVal(firestoreTimestampToISO(itemData._updated), "timestamptz")}, NOW()),
                    ${sqlVal(mealPlanId, "uuid")},
                    ${sqlVal(recipeId, "uuid")},
                    ${sqlVal(dateVal, "date")},
                    ${mapMealType(itemData.mealType) ? sqlVal(mapMealType(itemData.mealType), "enum") : "NULL"},
                    ${sqlVal(truncate(itemData.note, 5000))}
                  )
                  ON CONFLICT (id) DO NOTHING
                `)
                counters.mealPlanRecipes.success++
              } catch (err: any) {
                counters.mealPlanRecipes.failed++
                counters.mealPlanRecipes.errors.push({
                  id: `${mealPlanId}:${itemId}`,
                  error: err.message,
                })
              }
            }
          }
        }
      } catch (_subErr) {
        // Subcollection might not exist
      }

      // --- Migrate sharedWith subcollection ---
      try {
        const shareDocs = await fetchSubcollection(COLLECTIONS.mealPlans, doc.id, "sharedWith")
        for (const shareDoc of shareDocs) {
          const shareData = shareDoc.data()
          const sharedWithFirebaseUid = shareData.id || shareDoc.id

          if (!sharedWithFirebaseUid) {
            continue
          }

          const sharedWithSupabaseId = firebaseUidToUuid(sharedWithFirebaseUid)

          try {
            await client.query(`
              INSERT INTO public.meal_plan_shares (
                meal_plan_id, shared_with_user_id, shared_with_email,
                created_at, updated_at, permission, nickname
              ) VALUES (
                ${sqlVal(mealPlanId, "uuid")},
                ${sqlVal(sharedWithSupabaseId, "uuid")},
                ${sqlVal(shareData.email)},
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._created), "timestamptz")}, NOW()),
                COALESCE(${sqlVal(firestoreTimestampToISO(shareData._updated), "timestamptz")}, NOW()),
                ${sqlVal(mapSharePermission(shareData.permission), "enum")},
                ${sqlVal(truncate(shareData.nickname, 500))}
              )
              ON CONFLICT (meal_plan_id, shared_with_user_id) DO NOTHING
            `)
            counters.mealPlanShares.success++
          } catch (err: any) {
            counters.mealPlanShares.failed++
            counters.mealPlanShares.errors.push({
              id: `${mealPlanId}:${sharedWithFirebaseUid}`,
              error: err.message,
            })
          }
        }
      } catch (_subErr) {
        // Subcollection might not exist
      }
    } catch (err: any) {
      counters.mealPlans.failed++
      counters.mealPlans.errors.push({ id: mealPlanId, error: err.message })
    } finally {
      client.release()
    }
  })

  console.log(
    `Meal Plans:  ✓ ${counters.mealPlans.success - before.mealPlans} | ✗ ${counters.mealPlans.failed - before.mealPlansFailed}`
  )
  console.log(
    `Recipes:     ✓ ${counters.mealPlanRecipes.success - before.recipes} | ✗ ${counters.mealPlanRecipes.failed - before.recipesFailed}`
  )
  console.log(
    `Shares:      ✓ ${counters.mealPlanShares.success - before.shares} | ✗ ${counters.mealPlanShares.failed - before.sharesFailed}`
  )

  console.log("Meal plan migration complete!")
  console.log(`  Meal Plans:        ✓ ${counters.mealPlans.success} | ✗ ${counters.mealPlans.failed}`)
  console.log(
    `  Meal Plan Recipes: ✓ ${counters.mealPlanRecipes.success} | ⊘ ${counters.mealPlanRecipes.skipped} | ✗ ${counters.mealPlanRecipes.failed}`
  )
  console.log(
    `  Meal Plan Shares:  ✓ ${counters.mealPlanShares.success} | ⊘ ${counters.mealPlanShares.skipped} | ✗ ${counters.mealPlanShares.failed}`
  )
}

// =========================================
// Main
// =========================================

async function main() {
  console.log("========================================")
  console.log(" Firebase → Supabase Single User Migration")
  console.log("========================================")
  console.log(`Firebase UID:       ${FIREBASE_UID}`)
  console.log(`Supabase UUID:      ${SUPABASE_UUID}`)
  console.log(`Concurrency:        ${CONCURRENCY}`)
  console.log(`Pool max:           ${(pool as any).options.max} connections`)
  console.log(`Database:           ${SUPABASE_DB_URL.replace(/:[^:@]+@/, ":***@")}`)
  console.log("")

  const setupClient = await pool.connect()
  console.log("✓ Connected to Supabase Postgres")

  const startTime = Date.now()

  try {
    // Disable the paywall trigger so recipe inserts aren't blocked/counted
    console.log("\nDisabling paywall trigger...")
    await setupClient.query(`ALTER TABLE public.recipes DISABLE TRIGGER recipes_paywall_insert`)

    // Disable updated_at triggers so we can preserve original timestamps
    console.log("Disabling updated_at triggers...")
    // await setupClient.query(`ALTER TABLE public.recipes DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.collections DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.lists DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plans DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plan_recipes DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.list_shares DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.collection_shares DISABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plan_shares DISABLE TRIGGER set_updated_at`)

    // Run migrations in order (respecting FK dependencies)
    await migrateRecipes()
    await migrateCollections()
    await migrateLists()
    await migrateMealPlans()
  } finally {
    // Re-enable triggers
    console.log("\n--- Re-enabling triggers ---")
    await setupClient.query(`ALTER TABLE public.recipes ENABLE TRIGGER recipes_paywall_insert`)
    // await setupClient.query(`ALTER TABLE public.recipes ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.collections ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.lists ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plans ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plan_recipes ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.list_shares ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.collection_shares ENABLE TRIGGER set_updated_at`)
    // await setupClient.query(`ALTER TABLE public.meal_plan_shares ENABLE TRIGGER set_updated_at`)
    console.log("✓ Triggers re-enabled")

    setupClient.release()
  }

  // Drain the pool
  await pool.end()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // --- Final Report ---
  console.log("")
  console.log("========================================")
  console.log(" Migration Complete")
  console.log("========================================")
  console.log(`Time elapsed: ${elapsed}s`)
  console.log("")
  console.log("Results:")
  console.log(`  Recipes:           ✓ ${counters.recipes.success} | ✗ ${counters.recipes.failed}`)
  console.log(`  Ingredients:       ✓ ${counters.recipeIngredients.success} | ✗ ${counters.recipeIngredients.failed}`)
  console.log(`  Instructions:      ✓ ${counters.recipeInstructions.success} | ✗ ${counters.recipeInstructions.failed}`)
  console.log(`  Collections:       ✓ ${counters.collections.success} | ✗ ${counters.collections.failed}`)
  console.log(
    `  Collection Recipes: ✓ ${counters.collectionRecipes.success} | ⊘ ${counters.collectionRecipes.skipped} | ✗ ${counters.collectionRecipes.failed}`
  )
  console.log(
    `  Collection Shares: ✓ ${counters.collectionShares.success} | ⊘ ${counters.collectionShares.skipped} | ✗ ${counters.collectionShares.failed}`
  )
  console.log(`  Lists:             ✓ ${counters.lists.success} | ✗ ${counters.lists.failed}`)
  console.log(`  List Items:        ✓ ${counters.listItems.success} | ✗ ${counters.listItems.failed}`)
  console.log(
    `  List Shares:       ✓ ${counters.listShares.success} | ⊘ ${counters.listShares.skipped} | ✗ ${counters.listShares.failed}`
  )
  console.log(`  Meal Plans:        ✓ ${counters.mealPlans.success} | ✗ ${counters.mealPlans.failed}`)
  console.log(
    `  Meal Plan Recipes: ✓ ${counters.mealPlanRecipes.success} | ⊘ ${counters.mealPlanRecipes.skipped} | ✗ ${counters.mealPlanRecipes.failed}`
  )
  console.log(
    `  Meal Plan Shares:  ✓ ${counters.mealPlanShares.success} | ⊘ ${counters.mealPlanShares.skipped} | ✗ ${counters.mealPlanShares.failed}`
  )

  // Write errors to file
  const allErrors = [
    ...counters.recipes.errors.map((e) => ({ table: "recipes", ...e })),
    ...counters.recipeIngredients.errors.map((e) => ({ table: "recipe_ingredients", ...e })),
    ...counters.recipeInstructions.errors.map((e) => ({ table: "recipe_instructions", ...e })),
    ...counters.collections.errors.map((e) => ({ table: "collections", ...e })),
    ...counters.collectionRecipes.errors.map((e) => ({ table: "collection_recipes", ...e })),
    ...counters.collectionShares.errors.map((e) => ({ table: "collection_shares", ...e })),
    ...counters.lists.errors.map((e) => ({ table: "lists", ...e })),
    ...counters.listItems.errors.map((e) => ({ table: "list_items", ...e })),
    ...counters.listShares.errors.map((e) => ({ table: "list_shares", ...e })),
    ...counters.mealPlans.errors.map((e) => ({ table: "meal_plans", ...e })),
    ...counters.mealPlanRecipes.errors.map((e) => ({ table: "meal_plan_recipes", ...e })),
    ...counters.mealPlanShares.errors.map((e) => ({ table: "meal_plan_shares", ...e })),
  ]

  if (allErrors.length > 0) {
    const errorFile = path.join(__dirname, "migration_errors.json")
    fs.writeFileSync(errorFile, JSON.stringify(allErrors, null, 2))
    console.log("")
    console.log(`Errors written to: ${errorFile}`)
    console.log("")
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
