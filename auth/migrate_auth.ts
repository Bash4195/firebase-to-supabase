// Migrates all Firebase Auth users to Supabase Auth.

import * as fs from "fs"
import * as path from "path"
import { Pool } from "pg"
import { createClient, SupabaseClient } from "@supabase/supabase-js"

import { firebaseUidToUuid } from "../helpers/firebaseUidToUuid"

// --- Configuration ---
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL!

const FIREBASE_HASH_CONFIG = {
  mem_cost: process.env.FB_MEM_COST || "14",
  rounds: process.env.FB_ROUNDS || "8",
  salt_separator: process.env.FB_SALT_SEPARATOR || "",
  signer_key: process.env.FB_SIGNER_KEY || "",
}

// --- Validate config ---
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
  process.exit(1)
}
if (!FIREBASE_HASH_CONFIG.salt_separator || !FIREBASE_HASH_CONFIG.signer_key) {
  console.error("ERROR: FB_SALT_SEPARATOR and FB_SIGNER_KEY must be set in .env")
  process.exit(1)
}
if (!SUPABASE_DB_URL) {
  console.error("ERROR: SUPABASE_DB_URL must be set in .env")
  process.exit(1)
}

// --- CLI Args ---
const args = process.argv.slice(2)
const INPUT_FILE = args[0]
const BATCH_SIZE = parseInt(args[1], 10) || 20
const CONCURRENCY = parseInt(args[2], 10) || 12

if (!INPUT_FILE) {
  console.log("Usage: npx ts-node migrate_auth.ts <path_to_json_file> [<batch_size>] [<concurrency>]")
  console.log("")
  console.log("  path_to_json_file  Path to the firebase auth:export JSON file")
  console.log("  batch_size         Users per batch (default: 20)")
  console.log("  concurrency        Concurrent user migrations per batch (default: 12)")
  process.exit(1)
}

// --- Supabase Client ---
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// --- Postgres Pool ---
const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 15,
})

// --- Types ---
interface FirebaseUser {
  localId: string
  email?: string
  emailVerified?: boolean
  displayName?: string
  photoUrl?: string
  phoneNumber?: string
  passwordHash?: string
  salt?: string
  createdAt?: string // milliseconds timestamp as string
  lastSignedInAt?: string // milliseconds timestamp as string
  providerUserInfo?: {
    providerId: string
    federatedId?: string
    email?: string
    rawId?: string
  }[]
}

interface MigrationResult {
  total: number
  success: number
  skipped: number
  failed: number
  errors: { localId: string; email: string; error: string }[]
}

// --- Helpers ---

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

/**
 * Convert URL-safe base64 to standard base64.
 * Firebase may use - and _ instead of + and /
 */
function urlSafeBase64ToStandard(str: string): string {
  return str.replace(/-/g, "+").replace(/_/g, "/")
}

/**
 * Constructs the $fbscrypt$ hash string for Supabase's encrypted_password field.
 *
 * Format: $fbscrypt$v=1,n=<mem_cost>,r=<rounds>,p=1,ss=<salt_separator>,sk=<signer_key>$<salt>$<hash>
 */
function formatFbScryptHash(passwordHash: string, salt: string): string {
  const standardHash = urlSafeBase64ToStandard(passwordHash)
  const standardSalt = urlSafeBase64ToStandard(salt)

  const params = [
    `v=1`,
    `n=${FIREBASE_HASH_CONFIG.mem_cost}`,
    `r=${FIREBASE_HASH_CONFIG.rounds}`,
    `p=1`,
    `ss=${FIREBASE_HASH_CONFIG.salt_separator}`,
    `sk=${FIREBASE_HASH_CONFIG.signer_key}`,
  ].join(",")

  return `$fbscrypt$${params}$${standardSalt}$${standardHash}`
}

/**
 * Determine the provider(s) for a Firebase user based on providerUserInfo
 */
function getProviders(user: FirebaseUser): string[] {
  const providers: string[] = []
  const providerData = user.providerUserInfo || []

  for (const p of providerData) {
    const providerId = p.providerId?.toLowerCase().replace(".com", "")
    switch (providerId) {
      case "password":
        providers.push("email")
        break
      case "google":
        providers.push("google")
        break
      case "apple":
        providers.push("apple")
        break
      default:
        if (providerId) providers.push(providerId)
    }
  }

  // If providerUserInfo is empty but user has a passwordHash, they're an email/password user
  if (providers.length === 0 && user.passwordHash) {
    providers.push("email")
  }

  // Fallback
  if (providers.length === 0) {
    providers.push("email")
  }

  return providers
}

/**
 * Check if user has an email/password-based account
 */
function hasPasswordAuth(user: FirebaseUser): boolean {
  // Has a password hash = has password auth
  if (user.passwordHash && user.salt) return true

  // Explicit password provider in providerUserInfo
  const providerData = user.providerUserInfo || []
  return providerData.some((p) => p.providerId === "password")
}

/**
 * Convert millisecond timestamp string to ISO date string
 */
function msToISOString(ms?: string): string | null {
  if (!ms) return null
  const num = parseInt(ms, 10)
  if (isNaN(num)) return null
  return new Date(num).toISOString()
}

// --- Migration Logic ---

async function migrateUser(
  user: FirebaseUser
): Promise<{ success: boolean; skipped: boolean; supabaseId?: string; error?: string }> {
  if (!user.email) {
    console.log("Skipped (no email): ", user.localId)
    return { success: false, skipped: true, error: "No email address" }
  }

  // Build the password hash if user has password auth
  let passwordHash: string | undefined
  if (hasPasswordAuth(user) && user.passwordHash && user.salt) {
    passwordHash = formatFbScryptHash(user.passwordHash, user.salt)
  }

  const providers = getProviders(user)

  try {
    const createParams: any = {
      id: firebaseUidToUuid(user.localId),
      email: user.email,
      email_confirm: true,
      user_metadata: {
        // Standard Supabase fields
        sub: firebaseUidToUuid(user.localId),
        email: user.email,
        email_verified: true,
        phone_verified: !!user.phoneNumber,
        // Firebase custom fields
        ...(user.displayName && { full_name: user.displayName }),
        ...(user.photoUrl && { avatar_url: user.photoUrl }),
        firebase_uid: user.localId, // Keep original for reference
      },
      app_metadata: {
        provider: providers[0],
        providers: providers,
      },
    }

    // Include the password hash if available
    if (passwordHash) {
      createParams.password_hash = passwordHash
    }

    // Include phone if available
    if (user.phoneNumber) {
      createParams.phone = user.phoneNumber
      createParams.phone_confirm = true
    }

    const { data, error } = await supabase.auth.admin.createUser(createParams)

    if (error) {
      if (
        error.message?.includes("already been registered") ||
        error.message?.includes("already exists") ||
        error.message?.includes("duplicate")
      ) {
        return { success: false, skipped: true, error: "Already exists in Supabase" }
      }
      return { success: false, skipped: false, error: error.message }
    }

    return { success: true, skipped: false, supabaseId: data.user?.id }
  } catch (err: any) {
    return { success: false, skipped: false, error: err.message || String(err) }
  }
}

/**
 * Batch-update created_at and last_sign_in_at for migrated users via direct SQL.
 * Uses a connection from the pool instead of a single shared client.
 */
async function updateTimestamps(
  updates: { supabaseId: string; createdAt: string | null; lastSignedInAt: string | null }[]
): Promise<void> {
  if (updates.length === 0) return

  // Build a single UPDATE using a VALUES list
  const valuesClauses = updates.map((u) => {
    const id = u.supabaseId
    const created = u.createdAt ? `'${u.createdAt}'::timestamptz` : "NULL"
    const lastSignIn = u.lastSignedInAt ? `'${u.lastSignedInAt}'::timestamptz` : "NULL"
    return `('${id}'::uuid, ${created}, ${lastSignIn})`
  })

  const sql = `
    UPDATE auth.users AS u
    SET
      created_at = COALESCE(v.created_at, u.created_at),
      last_sign_in_at = v.last_sign_in_at
    FROM (VALUES ${valuesClauses.join(",\n")}) AS v(id, created_at, last_sign_in_at)
    WHERE u.id = v.id;
  `

  const client = await pool.connect()
  try {
    await client.query(sql)
  } catch (err: any) {
    console.error("  ⚠ Failed to update timestamps:", err.message)
  } finally {
    client.release()
  }
}

async function main() {
  console.log("========================================")
  console.log(" Firebase → Supabase Auth Migration")
  console.log("========================================")
  console.log(`Input file:   ${INPUT_FILE}`)
  console.log(`Batch size:   ${BATCH_SIZE}`)
  console.log(`Concurrency:  ${CONCURRENCY}`)
  console.log(`Pool max:     ${(pool as any).options.max} connections`)
  console.log(`Supabase:     ${SUPABASE_URL}`)
  console.log("")

  // Read and parse the file
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`ERROR: File not found: ${INPUT_FILE}`)
    process.exit(1)
  }

  const raw = fs.readFileSync(INPUT_FILE, "utf8")
  const parsed = JSON.parse(raw)

  // Handle both { "users": [...] } and plain array [...]
  const users: FirebaseUser[] = Array.isArray(parsed) ? parsed : parsed.users

  if (!users || !Array.isArray(users)) {
    console.error("ERROR: Could not find users array in JSON file.")
    console.error('Expected format: { "users": [...] } or [...]')
    process.exit(1)
  }

  // Verify pool connectivity
  const testClient = await pool.connect()
  console.log("✓ Connected to Supabase Postgres")
  testClient.release()
  console.log("")

  console.log(`Found ${users.length} users to process`)
  console.log("")

  const totals: MigrationResult = {
    total: users.length,
    success: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }

  const startTime = Date.now()

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(users.length / BATCH_SIZE)

    console.log(`Batch ${batchNum}/${totalBatches} (users ${i + 1}-${i + batch.length})... `)

    let batchSuccess = 0
    let batchSkipped = 0
    let batchFailed = 0
    const timestampUpdates: { supabaseId: string; createdAt: string | null; lastSignedInAt: string | null }[] = []

    // --- Process users concurrently within each batch ---
    await asyncPool(CONCURRENCY, batch, async (user) => {
      const result = await migrateUser(user)

      if (result.success) {
        totals.success++
        batchSuccess++

        // Collect timestamp data for this user
        if (result.supabaseId) {
          timestampUpdates.push({
            supabaseId: result.supabaseId,
            createdAt: msToISOString(user.createdAt),
            lastSignedInAt: msToISOString(user.lastSignedInAt),
          })
        }
      } else if (result.skipped) {
        totals.skipped++
        batchSkipped++
      } else {
        totals.failed++
        batchFailed++
        totals.errors.push({
          localId: user.localId,
          email: user.email || "unknown",
          error: result.error || "Unknown error",
        })
      }
    })

    // Batch-update timestamps for all successfully created users
    await updateTimestamps(timestampUpdates)

    console.log(`✓ ${batchSuccess} | ⊘ ${batchSkipped} | ✗ ${batchFailed}`)
  }

  // Drain the pool
  await pool.end()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log("")
  console.log("========================================")
  console.log(" Migration Complete")
  console.log("========================================")
  console.log(`Total processed: ${totals.total}`)
  console.log(`  ✓ Migrated:   ${totals.success}`)
  console.log(`  ⊘ Skipped:    ${totals.skipped}`)
  console.log(`  ✗ Failed:     ${totals.failed}`)
  console.log(`Time elapsed:   ${elapsed}s`)
  console.log("")

  if (totals.errors.length > 0) {
    const errorFile = path.join(path.dirname(INPUT_FILE), "migration_errors.json")
    fs.writeFileSync(errorFile, JSON.stringify(totals.errors, null, 2))
    console.log(`Errors written to: ${errorFile}`)

    // Show first few errors
    console.log("")
    console.log("First 5 errors:")
    totals.errors.slice(0, 5).forEach((e) => {
      console.log(`  ${e.email} (${e.localId}): ${e.error}`)
    })
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
