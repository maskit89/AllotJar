/* ============================================================================
   Passkey reset: a login that lost every passkey AND every recovery code
   ============================================================================
   Context: once a login has a passkey, signing in (password, Google or a
   password reset link) also asks for the passkey or a recovery code. A person
   who lost both writes to privacy@allotjar.com. There is no self-service way
   round the step, by design: an inbox alone must not be enough.

   Before running this, be sure it is really them. Anyone in the same
   household knows the jar names and amounts, so those prove nothing. Instead:
     a. Reply only to the account's own email address (never to an address
        the request came from, if different), saying the passkeys will be
        removed in 48 hours unless they reply that it wasn't them.
     b. Wait the 48 hours. The owner, if it wasn't them, has time to say so.
     c. If anything looks off, don't.

   This script removes the login's passkeys and recovery codes, so signing in
   goes back to the password (or Google) alone. They can add a new passkey in
   Account settings straight after.

   Usage (SSMS on the box; the USE line below picks the production database,
   change it to ZeroBudgetStaging only for a staging login):
     1. Set @Email to the login's email address.
     2. Run the whole script. STEP 1 shows one user row, its passkeys and
        whether it has codes; STEP 2 deletes inside a transaction that ROLLS
        BACK, so this run changes nothing and only shows the counts.
     3. If (and only if) that is the right login and the counts match STEP 1,
        change the last line to COMMIT TRANSACTION and run the whole script
        again.
     4. Tell them they can sign in with their password or Google again, and
        should add a new passkey and save the new recovery codes.
   ============================================================================ */

USE ZeroBudgetProd;
SET XACT_ABORT ON;   -- an error part-way rolls the whole of STEP 2 back

DECLARE @Email nvarchar(256) = N'';   -- e.g. N'someone@example.com'

DECLARE @UserId nvarchar(450) =
    (SELECT Id FROM AspNetUsers WHERE NormalizedEmail = UPPER(LTRIM(RTRIM(@Email))));

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
