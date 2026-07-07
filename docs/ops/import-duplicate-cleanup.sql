/* ============================================================================
   Import duplicate cleanup — cross-format re-imports
   ============================================================================
   Context: before the import-consistency fix, the SAME bank file imported once
   through the HSBC path (BankReference 'hsbc:…', clean payee, purchase date)
   and once through the generic-CSV path (BankReference 'csv:…', raw packed
   payee, posting date) produced TWO copies of every transaction — the two
   paths synthesised different idempotency references.

   This script finds the 'csv:…' copies that duplicate an 'hsbc:…' original
   and (only when you explicitly commit) deletes them. Matching rule:
     - same owner
     - same Amount and same Type (direction)
     - dates within @WindowDays of each other (purchase vs posting drift)
     - the raw csv payee CONTAINS the clean hsbc payee (case-insensitive via
       the default CI collation; CHARINDEX avoids LIKE-wildcard pitfalls)

   Usage (SSMS on the prod box, per docs/ops/user-lookup-queries.sql):
     1. Set @Email to the affected login (or leave NULL to scan every owner).
     2. Run STEP 1 and eyeball every pair — each row shows the duplicate AND
        the original it matches.
     3. If (and only if) the pairs look right, run STEP 2. It deletes inside a
        transaction that ROLLS BACK by default — switch the final line to
        COMMIT once the counts match what STEP 1 showed.
   ============================================================================ */

DECLARE @Email        nvarchar(256) = NULL;   -- e.g. N'someone@example.com'; NULL = all owners
DECLARE @WindowDays   int           = 7;

DECLARE @OwnerId nvarchar(450) = NULL;
IF @Email IS NOT NULL
    SELECT @OwnerId = u.Id FROM dbo.AspNetUsers u WHERE u.NormalizedEmail = UPPER(@Email);

/* ---------------------------------------------------------------------------
   STEP 1 — REVIEW: every 'csv:%' transaction that matches an 'hsbc:%' original.
   Nothing is modified. A duplicate may match several originals; the pairing
   picks the closest-dated original per duplicate.
   --------------------------------------------------------------------------- */
WITH pairs AS (
    SELECT
        dup.Id            AS DuplicateId,
        dup.Date          AS DuplicateDate,
        dup.Payee         AS DuplicatePayee,
        dup.BankReference AS DuplicateRef,
        orig.Id           AS OriginalId,
        orig.Date         AS OriginalDate,
        orig.Payee        AS OriginalPayee,
        orig.BankReference AS OriginalRef,
        dup.Amount,
        dup.Type,
        dup.OwnerId,
        ROW_NUMBER() OVER (
            PARTITION BY dup.Id
            ORDER BY ABS(DATEDIFF(day, dup.Date, orig.Date)), orig.Id
        ) AS rn
    FROM dbo.Transactions dup
    JOIN dbo.Transactions orig
      ON  orig.OwnerId = dup.OwnerId
      AND orig.BankReference LIKE 'hsbc:%'
      AND orig.Amount = dup.Amount
      AND orig.Type   = dup.Type
      AND ABS(DATEDIFF(day, dup.Date, orig.Date)) <= @WindowDays
      AND CHARINDEX(orig.Payee, dup.Payee) > 0     -- raw blob contains the clean payee
    WHERE dup.BankReference LIKE 'csv:%'
      AND (@OwnerId IS NULL OR dup.OwnerId = @OwnerId)
)
SELECT DuplicateId, DuplicateDate, DuplicatePayee, DuplicateRef,
       OriginalId,  OriginalDate,  OriginalPayee,  OriginalRef,
       Amount, Type, OwnerId
FROM pairs
WHERE rn = 1
ORDER BY OwnerId, DuplicateDate, Amount;

/* ---------------------------------------------------------------------------
   STEP 2 — DELETE the duplicates found above. Runs in a transaction that
   ROLLS BACK by default; change the last line to COMMIT after verifying the
   deleted count equals the row count from STEP 1.
   --------------------------------------------------------------------------- */
-- BEGIN TRANSACTION;
--
-- DECLARE @dupes TABLE (Id uniqueidentifier PRIMARY KEY);
--
-- INSERT INTO @dupes (Id)
-- SELECT DISTINCT dup.Id
-- FROM dbo.Transactions dup
-- WHERE dup.BankReference LIKE 'csv:%'
--   AND (@OwnerId IS NULL OR dup.OwnerId = @OwnerId)
--   AND EXISTS (
--       SELECT 1 FROM dbo.Transactions orig
--       WHERE orig.OwnerId = dup.OwnerId
--         AND orig.BankReference LIKE 'hsbc:%'
--         AND orig.Amount = dup.Amount
--         AND orig.Type   = dup.Type
--         AND ABS(DATEDIFF(day, dup.Date, orig.Date)) <= @WindowDays
--         AND CHARINDEX(orig.Payee, dup.Payee) > 0
--   );
--
-- DELETE s FROM dbo.TransactionSplits s JOIN @dupes d ON s.TransactionId = d.Id;
-- DELETE t FROM dbo.Transactions      t JOIN @dupes d ON t.Id            = d.Id;
--
-- SELECT @@ROWCOUNT AS DeletedTransactions;
--
-- ROLLBACK TRANSACTION;   -- change to: COMMIT TRANSACTION;
