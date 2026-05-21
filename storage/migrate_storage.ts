// Migrates recipe images from Firebase Storage to Supabase Storage.
// Run this AFTER migrate_auth.ts and migrate_database.ts have been executed.

import * as admin from "firebase-admin"
import * as fs from "fs"
import * as path from "path"
import { Client } from "pg"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

// --- Configuration ---
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!
const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET! // e.g. "my-app.appspot.com"

const SUPABASE_STORAGE_BUCKET = "recipe-images"
const MAX_FILE_SIZE = 10485760 // 10 MB – matches bucket file_size_limit

// --- Validate config ---
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
  process.exit(1)
}
if (!SUPABASE_DB_URL) {
  console.error("ERROR: SUPABASE_DB_URL must be set in .env")
  process.exit(1)
}
if (!FIREBASE_STORAGE_BUCKET) {
  console.error("ERROR: FIREBASE_STORAGE_BUCKET must be set in .env")
  process.exit(1)
}
if (!process.env.FB_UID_NAMESPACE) {
  console.error("ERROR: FB_UID_NAMESPACE must be set in .env")
  process.exit(1)
}

// --- CLI Args ---
const args = process.argv.slice(2)
const BATCH_SIZE = parseInt(args[0], 10) || 20
const CONCURRENCY = parseInt(args[1], 10) || 5

// --- Initialize Firebase Admin ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: FIREBASE_STORAGE_BUCKET,
  })
}
const firebaseBucket = admin.storage().bucket()

// --- Supabase Client (service role bypasses RLS) ---
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// --- Postgres Client ---
let pgClient: Client

// --- Counters ---
interface MigrationCounters {
  success: number
  failed: number
  skipped: number
  errors: { id: string; error: string }[]
}

const counters: MigrationCounters = { success: 0, failed: 0, skipped: 0, errors: [] }

// --- Supported formats ---

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
}

// --- Helpers ---

/**
 * Extract the file path within a Firebase Storage bucket from a download URL.
 * Supports firebasestorage.googleapis.com and storage.googleapis.com formats.
 */
function extractFirebaseStoragePath(url: string): string | null {
  // https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded_path}?...
  const match1 = url.match(/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/)
  if (match1) return decodeURIComponent(match1[1])

  // https://storage.googleapis.com/{bucket}/{path}
  const match2 = url.match(/storage\.googleapis\.com\/[^/]+\/(.+?)(?:\?|$)/)
  if (match2) return decodeURIComponent(match2[1])

  return null
}

/**
 * Check whether a URL points to Firebase Storage (vs. an external host).
 * Only Firebase-hosted images need to be migrated.
 */
function isFirebaseStorageUrl(url: string): boolean {
  return (
    url.includes("firebasestorage.googleapis.com") ||
    url.includes(`storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}`) ||
    url.startsWith("gs://")
  )
}

/**
 * Derive file extension from a URL's pathname (e.g. ".jpg" → "jpg")
 */
function getExtFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname).toLowerCase().replace(".", "")
    return ext && EXT_TO_MIME[ext] ? ext : null
  } catch {
    return null
  }
}

/**
 * Derive file extension from a Content-Type header
 */
function getExtFromContentType(contentType: string | undefined): string {
  if (contentType) {
    const baseMime = contentType.split(";")[0].trim().toLowerCase()
    if (MIME_TO_EXT[baseMime]) return MIME_TO_EXT[baseMime]
  }
  return "jpg" // safe default
}

/**
 * Escape a string for use in a SQL literal
 */
function escSql(val: string | null | undefined): string {
  if (val === null || val === undefined) return "NULL"
  const str = typeof val === "string" ? val : String(val)
  return `'${str.replace(/'/g, "''")}'`
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run async work over an array with a concurrency cap.
 */
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item !== undefined) await fn(item)
    }
  })
  await Promise.all(workers)
}

// --- Download / Upload ---

/**
 * Download an image.
 * 1. For gs:// URLs or recognised Firebase Storage URLs → use Admin SDK (no token needed).
 * 2. Fallback → HTTP fetch (handles URLs with embedded download tokens).
 */
async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  // gs:// reference
  if (url.startsWith("gs://")) {
    const gsPath = url.replace(/^gs:\/\/[^/]+\//, "")
    const file = firebaseBucket.file(gsPath)
    const [metadata] = await file.getMetadata()
    const [contents] = await file.download()
    return { buffer: Buffer.from(contents), contentType: (metadata.contentType as string) || "image/jpeg" }
  }

  // Firebase Storage HTTPS URL → try Admin SDK first (more reliable than token URLs)
  const storagePath = extractFirebaseStoragePath(url)
  if (storagePath) {
    try {
      const file = firebaseBucket.file(storagePath)
      const [metadata] = await file.getMetadata()
      const [contents] = await file.download()
      return { buffer: Buffer.from(contents), contentType: (metadata.contentType as string) || "image/jpeg" }
    } catch {
      // Admin SDK failed (file missing, permissions, etc.) — fall through to HTTP
    }
  }

  // HTTP fallback
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    const contentType = response.headers.get("content-type") || "image/jpeg"
    const arrayBuffer = await response.arrayBuffer()
    return { buffer: Buffer.from(arrayBuffer), contentType }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Upload an image buffer to Supabase Storage and return its public URL.
 */
async function uploadToSupabase(buffer: Buffer, storagePath: string, contentType: string): Promise<string> {
  const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: true, // idempotent on re-runs
  })

  if (error) throw new Error(`Supabase upload failed: ${error.message}`)

  const {
    data: { publicUrl },
  } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(storagePath)

  return publicUrl
}

// --- Job type ---

interface RecipeImageJob {
  recipeId: string
  userId: string // Supabase UUID (already converted)
  imageUrl: string
}

// =========================================
// Migration
// =========================================

// --- Constants for scanning ---
const SCAN_BATCH_SIZE = 1000 // rows per DB query when scanning for Firebase URLs

async function migrateImages(): Promise<void> {
  // --------------------------------------------------
  // 1. Scan Supabase recipes table for Firebase Storage image URLs
  // --------------------------------------------------
  console.log("\n--- Scanning Supabase recipes for Firebase Storage URLs ---")

  // Use a WHERE filter + cursor-based pagination to avoid loading 2M+ rows at once.
  // We filter for URLs that look like Firebase Storage at the DB level for efficiency.
  const jobs: RecipeImageJob[] = []
  let lastId: string | null = null
  let totalScanned = 0

  while (true) {
    const whereClause: string = lastId
      ? `WHERE image_url IS NOT NULL
           AND (image_url LIKE '%firebasestorage.googleapis.com%'
                OR image_url LIKE '%storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}%'
                OR image_url LIKE 'gs://%')
           AND id > '${lastId}'`
      : `WHERE image_url IS NOT NULL
           AND (image_url LIKE '%firebasestorage.googleapis.com%'
                OR image_url LIKE '%storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}%'
                OR image_url LIKE 'gs://%')`

    const sql: string = `
      SELECT id, user_id, image_url
      FROM public.recipes
      ${whereClause}
      ORDER BY id ASC
      LIMIT ${SCAN_BATCH_SIZE}
    `

    const result = await pgClient.query<{ id: string; user_id: string; image_url: string }>(sql)
    const rows = result.rows

    if (rows.length === 0) break

    for (const row of rows) {
      jobs.push({
        recipeId: row.id,
        userId: row.user_id,
        imageUrl: row.image_url,
      })
    }

    lastId = rows[rows.length - 1].id
    totalScanned += rows.length
    console.log(`  Scanned ${totalScanned} matching recipes so far...`)
  }

  console.log(`  Firebase-hosted images to migrate: ${jobs.length}`)
  console.log(`  (Non-Firebase URLs are left as-is)`)

  if (jobs.length === 0) {
    console.log("  Nothing to migrate.")
    return
  }

  // --------------------------------------------------
  // 2. Migrate recipe images
  // --------------------------------------------------
  console.log("\n--- Migrating Recipe Images ---")

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(jobs.length / BATCH_SIZE)
    console.log(`  Batch ${batchNum}/${totalBatches} (${i + 1}-${i + batch.length})...`)

    const before = { success: counters.success, failed: counters.failed, skipped: counters.skipped }

    await processWithConcurrency(batch, CONCURRENCY, async (job) => {
      try {
        // Download
        const { buffer, contentType } = await downloadImage(job.imageUrl)

        // Enforce bucket size limit
        if (buffer.length > MAX_FILE_SIZE) {
          counters.skipped++
          counters.errors.push({
            id: job.recipeId,
            error: `File too large: ${(buffer.length / 1048576).toFixed(1)}MB (limit ${MAX_FILE_SIZE / 1048576}MB)`,
          })
          return
        }

        // Build storage path: {user_uuid}/{recipe_id}.{ext}
        const ext = getExtFromUrl(job.imageUrl) || getExtFromContentType(contentType)
        const storagePath = `${job.userId}/${job.recipeId}.${ext}`

        // Upload → Supabase Storage
        const publicUrl = await uploadToSupabase(buffer, storagePath, contentType)

        // Update the recipe row in Postgres
        await pgClient.query(
          `UPDATE public.recipes SET image_url = ${escSql(publicUrl)} WHERE id = ${escSql(job.recipeId)}::uuid`
        )

        counters.success++
      } catch (err: any) {
        counters.failed++
        counters.errors.push({ id: job.recipeId, error: err.message })
      }
    })

    console.log(
      `    ✓ ${counters.success - before.success} | ⊘ ${counters.skipped - before.skipped} | ✗ ${counters.failed - before.failed}`
    )

    // Brief pause between batches
    await sleep(200)
  }

  console.log(`  Done: ✓ ${counters.success} | ⊘ ${counters.skipped} | ✗ ${counters.failed}`)
}

// =========================================
// Main
// =========================================

async function main() {
  console.log("========================================")
  console.log(" Firebase → Supabase Storage Migration")
  console.log("========================================")
  console.log(`Batch size:   ${BATCH_SIZE}`)
  console.log(`Concurrency:  ${CONCURRENCY}`)
  console.log(`Supabase:     ${SUPABASE_URL}`)
  console.log(`Firebase:     ${FIREBASE_STORAGE_BUCKET}`)
  console.log(`Database:     ${SUPABASE_DB_URL.replace(/:[^:@]+@/, ":***@")}`)
  console.log("")

  // --- Connect to Postgres ---
  pgClient = new Client({
    connectionString: SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  })
  await pgClient.connect()
  console.log("✓ Connected to Supabase Postgres")

  // --- Verify the storage bucket exists ---
  const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets()
  if (bucketsError) {
    console.error("ERROR: Could not list storage buckets:", bucketsError.message)
    process.exit(1)
  }
  const bucketExists = buckets?.some((b) => b.id === SUPABASE_STORAGE_BUCKET)
  if (!bucketExists) {
    console.error(`ERROR: Storage bucket '${SUPABASE_STORAGE_BUCKET}' does not exist.`)
    console.error("Run the storage schema SQL first: supabase/schemas/recipe_images_storage.sql")
    process.exit(1)
  }
  console.log(`✓ Storage bucket '${SUPABASE_STORAGE_BUCKET}' exists`)

  const startTime = Date.now()

  try {
    // Disable updated_at trigger so the image_url UPDATE doesn't alter timestamps
    console.log("\nDisabling updated_at trigger...")
    await pgClient.query(`ALTER TABLE public.recipes DISABLE TRIGGER set_updated_at`)

    await migrateImages()
  } finally {
    // Re-enable trigger
    console.log("\n--- Re-enabling triggers ---")
    await pgClient.query(`ALTER TABLE public.recipes ENABLE TRIGGER set_updated_at`)
    console.log("✓ Triggers re-enabled")
  }

  // Cleanup
  await pgClient.end()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // --- Final Report ---
  console.log("")
  console.log("========================================")
  console.log(" Migration Complete")
  console.log("========================================")
  console.log(`Time elapsed: ${elapsed}s`)
  console.log("")
  console.log("Results:")
  console.log(`  ✓ Migrated:  ${counters.success}`)
  console.log(`  ⊘ Skipped:   ${counters.skipped}`)
  console.log(`  ✗ Failed:    ${counters.failed}`)

  // Write errors to file
  if (counters.errors.length > 0) {
    const errorFile = path.join(__dirname, "storage_migration_errors.json")
    fs.writeFileSync(errorFile, JSON.stringify(counters.errors, null, 2))
    console.log("")
    console.log(`Errors written to: ${errorFile}`)

    // Show first few errors
    console.log("")
    console.log("First 5 errors:")
    counters.errors.slice(0, 5).forEach((e) => {
      console.log(`  ${e.id}: ${e.error}`)
    })
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
