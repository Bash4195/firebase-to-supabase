// ============================================================================
// Helpers  (mirrored from the migration script so both paths produce identical
//           Postgres rows — keep in sync if you change one)
// ============================================================================

/**
 * Convert a Firestore Timestamp or { seconds, nanoseconds } to ISO string
 */
export function firestoreTimestampToISO(ts: any): string | null {
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
export function firestoreTimestampToDate(ts: any): string | null {
  const iso = firestoreTimestampToISO(ts)
  if (!iso) return null
  return iso.split("T")[0]
}

/**
 * Parse a date value from various formats into an ISO 8601 string suitable for timestamptz.
 * Handles Firestore Timestamps, ISO strings, date-only strings, unix timestamps, etc.
 * Returns null if the value cannot be parsed into a valid date.
 */
export function parseDateToISO(val: any): string | null {
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
 * Truncate string to max length
 */
export function truncate(str: string | null | undefined, maxLen: number): string | null {
  if (!str) return null
  return str.length > maxLen ? str.substring(0, maxLen) : str
}

/**
 * Returns a positive number, or null
 */
export function safePositiveNumber(val: any): number | null {
  if (val === null || val === undefined) return null
  const num = Number(val)
  if (isNaN(num) || !isFinite(num)) return null
  return Math.abs(num)
}

/**
 * Map Firebase ingredient category_id to Supabase enum value
 */
export function mapIngredientCategory(val: string | null | undefined): string | null {
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
export function mapSharePermission(val: string | null | undefined): string {
  if (val === "editor") return "editor"
  return "viewer"
}

/**
 * Map Firebase meal type to Supabase enum
 */
export function mapMealType(val: string | null | undefined): string | null {
  if (!val) return null
  const valid = ["breakfast", "lunch", "dinner", "snack"]
  return valid.includes(val) ? val : null
}