/* ============================================================================
   Passkey reset: a login that lost every passkey AND every recovery code
   ============================================================================
   Context: once a login has a passkey, signing in (password, Google or a
   password reset link) also asks for the passkey or a recovery code. A person
   who lost both writes to privacy@allotjar.com. There is no self-service way
   round the step, by design: an inbox alone must not be enough.

   Before running this, be sure it is really them. Reply only to the account's
   own email address, and ask for something only the owner would know (for
   example roughly when they signed up, a jar name, or the last amount they
   recorded). If in doubt, don't.

   This script removes the login's passkeys and recovery codes, so signing in
   goes back to the password (or Google) alone. They can add a new passkey in
   Account settings straight after.

   Usage (SSMS on the box, production database ZeroBudgetProd):
     1. Set @Email to the login's email address.
     2. Run STEP 1: one user row, its passkeys and whether it has codes.
     3. If (and only if) that is the right login, run STEP 2. It deletes inside
        a transaction that ROLLS BACK by default: switch the final line to
        COMMIT once the counts match what STEP 1 showed.
     4. Tell them they can sign in with their password or Google again, and
        should add a new passkey and save the new recovery codes.
   ============================================================================ */

DECLARE @Email nvarchar(256) = N'';   -- e.g. N'someone@example.com'

DECLARE @UserId nvarchar(450) =
    (SELECT Id FROM AspNetUsers WHERE NormalizedEmail = UPPER(@Email));

/* ---- STEP 1: look -------------------------------------------------------- */

SELECT Id, Email, EmailConfirmed
FROM AspNetUsers
WHERE Id = @UserId;                                    -- must be exactly 1 row

SELECT UserId, JSON_VALUE(Data, '$.Name') AS AddedOnDevice,
       JSON_VALUE(Data, '$.CreatedAt') AS AddedUtc
FROM AspNetUserPasskeys
WHERE UserId = @UserId;                                -- the passkeys to remove

SELECT UserId, LoginProvider, Name
FROM AspNetUserTokens
WHERE UserId = @UserId AND LoginProvider = N'AllotJar' AND Name = N'RecoveryCodeHashes';
                                                       -- 0 or 1 row

/* ---- STEP 2: remove (rolls back unless you change the last line) ---------- */

IF @UserId IS NULL
    THROW 50000, 'No login has that email address.', 1;

BEGIN TRANSACTION;

DELETE FROM AspNetUserPasskeys WHERE UserId = @UserId;
SELECT @@ROWCOUNT AS PasskeysRemoved;

DELETE FROM AspNetUserTokens
WHERE UserId = @UserId AND LoginProvider = N'AllotJar' AND Name = N'RecoveryCodeHashes';
SELECT @@ROWCOUNT AS RecoveryCodeRowsRemoved;

ROLLBACK TRANSACTION;   -- change to COMMIT TRANSACTION once the counts match STEP 1
