// TODO: This whole file!

/**
 * Validate and transform agree_to_terms from Firebase to Supabase format.
 * Firebase: { version: number, agreed: boolean, timestamp: number (ms) }[]
 * Supabase: { version: number, agreed: boolean, timestamp: string (ISO) }[]
 */
function validateAgreeToTerms(val: any): any[] | null {
  if (!Array.isArray(val) || val.length === 0) return null

  const result: any[] = []
  for (const item of val) {
    if (typeof item !== "object" || item === null) continue

    const entry: Record<string, any> = {}

    if (typeof item.version === "number") entry.version = item.version
    else continue // version is required

    if (typeof item.agreed === "boolean") entry.agreed = item.agreed
    else continue // agreed is required

    // Convert numeric timestamp (ms) to ISO string, or keep string as-is
    if (typeof item.timestamp === "number") {
      entry.timestamp = new Date(item.timestamp).toISOString()
    } else if (typeof item.timestamp === "string") {
      entry.timestamp = item.timestamp
    } else {
      entry.timestamp = new Date().toISOString()
    }

    result.push(entry)
  }

  return result.length > 0 ? result : null
}
