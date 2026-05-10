# Auth

## Backfill

1. Download users from Firebase
    - `npm run firebase:auth:export:<dev|staging|production>`
2. Run the backfill script
    - `npm run backfill:auth:<dev|staging|production>`
3. After Full Migration: Verify
   ```
   -- Count total migrated users
   SELECT COUNT(*) FROM auth.users;
   
   -- Count users with fbscrypt passwords
   SELECT COUNT(*) FROM auth.users WHERE encrypted_password LIKE '$fbscrypt$%';
   
   -- Count users with identities (required for login)
   SELECT COUNT(DISTINCT user_id) FROM auth.identities;
   All three numbers should be close to your total user count (minus any that were skipped).
   ```