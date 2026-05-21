import { v5 as uuidv5 } from 'uuid';

// Use a fixed namespace UUID (generate one and keep it forever — this is YOUR app's namespace)
// You can generate one at https://www.uuidgenerator.net/version4
const FB_UID_NAMESPACE = process.env.FB_UID_NAMESPACE!;

/**
 * Deterministically convert a Firebase UID to a UUID v5.
 * Same input always produces the same output.
 */
export function firebaseUidToUuid(firebaseUid: string): string {
  return uuidv5(firebaseUid, FB_UID_NAMESPACE);
}