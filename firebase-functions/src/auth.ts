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
// Helpers
// ---------------------------------------------------------------------------

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
}) {
  const providers = getProviders(params.providerData)

  return {
    id: firebaseUidToUuid(params.firebaseUid),
    email: params.email,
    email_confirm: params.emailVerified || false,
    user_metadata: {
      full_name: params.displayName || undefined,
      avatar_url: params.photoURL || undefined,
      firebase_uid: params.firebaseUid,
    },
    app_metadata: {
      provider: providers[0] || "email",
      providers,
    },
  }
}

// ---------------------------------------------------------------------------
// 1. onUserCreate — New Firebase user → Create in Supabase
// ---------------------------------------------------------------------------
export const onUserCreate = functions.auth.user().onCreate(async (userRecord: UserRecord) => {
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
    const payload = buildSupabaseUserPayload({
      firebaseUid,
      email: userRecord.email,
      emailVerified: userRecord.emailVerified,
      displayName: userRecord.displayName,
      photoURL: userRecord.photoURL,
      providerData: userRecord.providerData,
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

        const { error: updateError } = await getSupabase().auth.admin.updateUserById(supabaseUuid, {
          email: payload.email,
          email_confirm: payload.email_confirm,
          user_metadata: payload.user_metadata,
          app_metadata: payload.app_metadata,
        })

        if (updateError) {
          console.error(`[onUserCreate] Failed to update existing user ${supabaseUuid}:`, updateError.message)
        } else {
          console.log(`[onUserCreate] Updated existing user ${supabaseUuid}`)
        }
        return
      }

      console.error(`[onUserCreate] Failed to create user ${supabaseUuid}:`, error.message)
      return
    }

    console.log(`[onUserCreate] ✓ Created Supabase user ${data.user?.id}`)
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
