import { admin } from "./admin"
import * as functions from "firebase-functions/v1"
import { onCall, CallableRequest } from "firebase-functions/v2/https"

const db = admin.firestore()

import { auth, firestore } from "firebase-admin"
import UserRecord = auth.UserRecord
import QuerySnapshot = firestore.QuerySnapshot

import { getSupabase } from "./helpers/supabase"
import { firebaseUidToUuid } from "./helpers/firebaseUidToUuid"

// ---------------------------------------------------------------------------
// Firebase SCRYPT hash config (must match your migration script's values)
// ---------------------------------------------------------------------------
const FIREBASE_HASH_CONFIG = {
  mem_cost: process.env.FB_MEM_COST || "14",
  rounds: process.env.FB_ROUNDS || "8",
  salt_separator: process.env.FB_SALT_SEPARATOR || "",
  signer_key: process.env.FB_SIGNER_KEY || "",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Normalize Firebase provider IDs → Supabase provider names.
 *
 * Firebase:  "google.com", "apple.com", "password"
 * Supabase:  "google",     "apple",     "email"
 */
function mapProvider(providerId: string): string {
  const normalized = providerId.toLowerCase().replace(".com", "")
  return normalized === "password" ? "email" : normalized
}

function getProviders(providerData: Array<{ providerId: string }> | undefined): string[] {
  if (!providerData || providerData.length === 0) return ["email"]
  return providerData.map((p) => mapProvider(p.providerId))
}

/**
 * Build the Supabase user payload from a Firebase user record / event.
 */
function buildSupabaseUserPayload(params: {
  firebaseUid: string
  email?: string
  emailVerified?: boolean
  displayName?: string
  photoURL?: string
  providerData?: Array<{ providerId: string }>
  passwordHash?: string
}) {
  const providers = getProviders(params.providerData)
  const supabaseUuid = firebaseUidToUuid(params.firebaseUid)

  const payload: Record<string, any> = {
    id: supabaseUuid,
    email: params.email,
    email_confirm: true,
    user_metadata: {
      // Standard Supabase fields (present on native sign-ups)
      sub: supabaseUuid,
      email: params.email,
      email_verified: true,
      phone_verified: false,
      // Custom fields from Firebase
      ...(params.displayName && { full_name: params.displayName }),
      ...(params.photoURL && { avatar_url: params.photoURL }),
      firebase_uid: params.firebaseUid,
    },
    app_metadata: {
      provider: providers[0] || "email",
      providers,
    },
  }

  if (params.passwordHash) {
    payload.password_hash = params.passwordHash
  }

  return payload
}

/**
 * Write last_sign_in_at directly to auth.users.
 *
 * GoTrue does NOT allow setting this field through the admin API — we must
 * bypass it with a Postgres function that has SECURITY DEFINER privileges.
 */
async function setLastSignInAt(supabaseUuid: string, lastSignInTime: string): Promise<void> {
  // Firebase metadata.lastSignInTime is in RFC 1123 format:
  //   "Wed, 01 Oct 2020 00:00:00 GMT"
  // Convert to ISO 8601 so Postgres timestamptz parses it correctly.
  const isoTimestamp = new Date(lastSignInTime).toISOString()

  const { error } = await getSupabase().rpc("set_last_sign_in_at", {
    user_id: supabaseUuid,
    last_sign_in: isoTimestamp,
  })

  if (error) {
    console.error(`[setLastSignInAt] Failed to update last_sign_in_at for ${supabaseUuid}:`, error.message)
  } else {
    console.log(`[setLastSignInAt] ✓ Set last_sign_in_at = ${isoTimestamp} for ${supabaseUuid}`)
  }
}

/**
 * Firebase only exposes passwordHash/passwordSalt via listUsers().
 * This searches for a newly-created user by paginating through the user list.
 *
 * ONLY call this during the transition period. Remove it after migration is complete.
 */
// NOTE: This is the only way we can get the users passwordHash/passwordSalt.
// In prod this is taking sometimes 10-20s to run, longest run was ~52 seconds.
async function getPasswordHashFromListUsers(firebaseUid: string): Promise<string | undefined> {
  const BATCH_SIZE = 1000
  let pageToken: string | undefined

  do {
    const result = await admin.auth().listUsers(BATCH_SIZE, pageToken)
    const user = result.users.find((u) => u.uid === firebaseUid)

    if (user?.passwordHash && user?.passwordSalt) {
      return formatFbScryptHash(user.passwordHash, user.passwordSalt)
    }

    pageToken = result.pageToken
  } while (pageToken)

  return undefined
}

// ---------------------------------------------------------------------------
// 1. onUserCreate — New Firebase user → Create in Supabase
// ---------------------------------------------------------------------------
export const onUserCreate = functions.runWith({ timeoutSeconds: 540 }).auth.user().onCreate(async (userRecord: UserRecord) => {
  const firebaseUid = userRecord.uid
  const supabaseUuid = firebaseUidToUuid(firebaseUid)

  // Skip users without an email
  if (!userRecord.email) {
    console.log(`[onUserCreate] Skipping user ${firebaseUid} — no email address`)
    return
  }

  console.log(
    `[onUserCreate] Creating Supabase user ${supabaseUuid} ` + `(Firebase: ${firebaseUid}, email: ${userRecord.email})`
  )

  try {
    // Only listUsers for password-based sign-ups
    const isPasswordUser = userRecord.providerData?.some((p) => p.providerId === "password")

    let passwordHash: string | undefined
    if (isPasswordUser) {
      passwordHash = await getPasswordHashFromListUsers(firebaseUid)
    }

    const payload = buildSupabaseUserPayload({
      firebaseUid,
      email: userRecord.email,
      emailVerified: userRecord.emailVerified,
      displayName: userRecord.displayName,
      photoURL: userRecord.photoURL,
      providerData: userRecord.providerData,
      passwordHash,
    })

    const { data, error } = await getSupabase().auth.admin.createUser(payload)

    if (error) {
      // User may already exist from migration → update instead
      if (
        error.message?.includes("already been registered") ||
        error.message?.includes("already exists") ||
        error.message?.includes("duplicate")
      ) {
        console.log(`[onUserCreate] User ${supabaseUuid} already exists — updating instead`)

        const updatePayload: Record<string, any> = {
          email: payload.email,
          email_confirm: payload.email_confirm,
          user_metadata: payload.user_metadata,
          app_metadata: payload.app_metadata,
        }

        // Also update password hash on existing users (e.g. if they were
        // created by an older version of this trigger that didn't include it)
        if (passwordHash) {
          updatePayload.password_hash = passwordHash
        }

        const { error: updateError } = await getSupabase().auth.admin.updateUserById(supabaseUuid, updatePayload)

        if (updateError) {
          console.error(`[onUserCreate] Failed to update existing user ${supabaseUuid}:`, updateError.message)
        } else {
          console.log(`[onUserCreate] Updated existing user ${supabaseUuid}`)

          // Set last_sign_in_at via Postgres function (GoTrue won't accept it)
          if (userRecord.metadata.lastSignInTime) {
            await setLastSignInAt(supabaseUuid, userRecord.metadata.lastSignInTime)
          }
        }
        return
      }

      console.error(`[onUserCreate] Failed to create user ${supabaseUuid}:`, error.message)
      return
    }

    console.log(`[onUserCreate] ✓ Created Supabase user ${data.user?.id}`)

    // Set last_sign_in_at via Postgres function (GoTrue won't accept it)
    if (userRecord.metadata.lastSignInTime) {
      await setLastSignInAt(supabaseUuid, userRecord.metadata.lastSignInTime)
    }
  } catch (err: any) {
    console.error(`[onUserCreate] Unexpected error for ${firebaseUid}:`, err.message || err)
  }
})

// ---------------------------------------------------------------------------
// 2. onUserDelete — Firebase user deleted → Delete from Supabase
// ---------------------------------------------------------------------------
export const onUserDelete = functions.auth.user().onDelete(async (userRecord: UserRecord) => {
  const firebaseUid = userRecord.uid
  const supabaseUuid = firebaseUidToUuid(firebaseUid)

  console.log(`[onUserDelete] Deleting Supabase user ${supabaseUuid} ` + `(Firebase: ${firebaseUid})`)

  try {
    const { error } = await getSupabase().auth.admin.deleteUser(supabaseUuid)

    if (error) {
      // Not found is acceptable — user was already deleted or never existed
      if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
        console.log(`[onUserDelete] User ${supabaseUuid} not found in Supabase ` + `(already deleted or never existed)`)
        return
      }

      console.error(`[onUserDelete] Failed to delete user ${supabaseUuid}:`, error.message)
      return
    }

    console.log(`[onUserDelete] ✓ Deleted Supabase user ${supabaseUuid}`)
  } catch (err: any) {
    console.error(`[onUserDelete] Unexpected error for ${supabaseUuid}:`, err.message || err)
  }
})

// ---------------------------------------------------------------------------
// 3. changeUserEmail
//   This is an update to the live function that handles email changes, so no functionality can be removed!
//   Just sync the change to supabase
// ---------------------------------------------------------------------------
export const changeUserEmail = onCall(async (request: CallableRequest) => {
  const { newEmail } = request.data

  // 1. Security Check: Ensure the user is authenticated.
  if (!request.auth) {
    throw new functions.https.HttpsError("unauthenticated", "You must be logged in to update your email.")
  }

  // 2. Input Validation: Ensure the new email was passed in the call.
  if (!newEmail || typeof newEmail !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Please provide a valid new email address.")
  }

  // 3. Update the user's email.
  try {
    // Update the user's auth email
    await admin.auth().updateUser(request.auth.uid, { email: newEmail })

    // Create a batch for all Firestore updates
    const batch = db.batch()

    // Update email in the firestore user doc
    const userDocRef = db.collection("users").doc(request.auth.uid)
    batch.update(userDocRef, { email: newEmail })

    // Search for the current user in all sharedWith subcollections
    const sharedWithQuery: QuerySnapshot = await db
      .collectionGroup("sharedWith")
      .where("id", "==", request.auth.uid)
      .get()

    // Update the email in each sharedWith doc for this user
    sharedWithQuery.forEach((doc) => {
      if (doc.exists) {
        batch.update(doc.ref, {
          _updated: admin.firestore.FieldValue.serverTimestamp(),
          email: newEmail,
        })
      }
    })

    // Commit all updates in a single batch
    await batch.commit()

    // Sync email change to Supabase (best-effort, don't block the response)
    try {
      const supabaseUuid = firebaseUidToUuid(request.auth.uid)
      const { error } = await getSupabase().auth.admin.updateUserById(supabaseUuid, {
        email: newEmail,
      })

      if (error) {
        // User may not exist in Supabase yet (not yet migrated) — that's fine
        if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
          console.log(`[changeUserEmail] User ${supabaseUuid} not found in Supabase — skipping sync`)
        } else {
          console.error(`[changeUserEmail] Failed to sync email to Supabase for ${supabaseUuid}:`, error.message)
        }
      } else {
        console.log(`[changeUserEmail] ✓ Synced email change to Supabase for ${supabaseUuid}`)
      }
    } catch (syncErr: any) {
      console.error(`[changeUserEmail] Unexpected Supabase sync error:`, syncErr.message || syncErr)
    }

    return {
      status: "success",
      message: `Email successfully updated to ${newEmail}.`,
    }
  } catch (error: any) {
    console.error("Error updating email for UID:", request.auth.uid, error)

    // Re-throw specific errors to the client for better UX.
    if (error.code === "auth/email-already-exists") {
      throw new functions.https.HttpsError("already-exists", "The email address is already in use by another account.")
    } else if (error.code === "auth/invalid-email") {
      throw new functions.https.HttpsError("invalid-argument", "The new email address is not valid.")
    }

    // For any other unexpected errors, throw a generic internal error.
    // This uses the HttpsError class for structured client-side errors.
    // See: https://firebase.google.com/docs/reference/functions/firebase-functions.https
    throw new functions.https.HttpsError("internal", "An unexpected error occurred. Please try again later.")
  }
})
