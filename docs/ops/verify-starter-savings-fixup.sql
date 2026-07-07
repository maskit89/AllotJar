/* ============================================================================
   AllotJar — verify the pre-#142 "Savings" starter fix-up  (READ-ONLY)
   ----------------------------------------------------------------------------
   Run BEFORE (and, if you like, after) deploying StarterSavingsKindSeeder.

   Context: before PR #142 the registration seeder created its starter "Savings"
   group WITHOUT Kind = Savings, so it defaulted to Expense (0). Those users' lone
   "Emergency Fund" line never rolled over, never became a jar, and was excluded
   from savings maths. The startup seeder repairs the *untouched* starter shape.

   These SELECTs mirror the seeder's heuristic EXACTLY, so query 1's "Verdict"
   column tells you precisely which households the seeder will and won't touch.
   Nothing here writes. Run it in SSMS on the VPS over RDP (SQL never on the net).

   Enum codes: CategoryKind 0=Expense 1=Income 2=Savings.

   A "pristine starter Savings group" = Kind=Expense, exactly ONE item, and that
   item is named 'Emergency Fund' with SavingsId IS NULL and DueDay IS NULL.
   A household is REPAIRED only if EVERY one of its 'Savings' groups is pristine
   AND it does not already own a jar named 'Emergency Fund'.
   ============================================================================ */


/* ---------------------------------------------------------------------------
   1. *** The headline: per-household verdict. ***
      "WOULD REPAIR" rows are exactly what the seeder will convert.
   --------------------------------------------------------------------------- */
;WITH SavingsGroups AS (
    SELECT c.Id AS CategoryId, m.OwnerId,
           c.Kind,
           (SELECT COUNT(*) FROM BudgetItems i WHERE i.BudgetCategoryId = c.Id) AS ItemCount
    FROM BudgetCategories c
    JOIN BudgetMonths m ON m.Id = c.BudgetMonthId
    WHERE c.Name = 'Savings'
),
GroupFlags AS (
    SELECT sg.CategoryId, sg.OwnerId,
           CASE WHEN sg.Kind = 0 AND sg.ItemCount = 1
                     AND EXISTS (SELECT 1 FROM BudgetItems i
                                 WHERE i.BudgetCategoryId = sg.CategoryId
                                   AND i.Name = 'Emergency Fund'
                                   AND i.SavingsId IS NULL
                                   AND i.DueDay IS NULL)
                THEN 1 ELSE 0 END AS IsPristine
    FROM SavingsGroups sg
),
OwnerRollup AS (
    SELECT OwnerId,
           COUNT(*)        AS SavingsGroupCount,
           SUM(IsPristine) AS PristineGroupCount,
           MIN(IsPristine) AS AllPristine   -- 1 only when every group is pristine
    FROM GroupFlags
    GROUP BY OwnerId
)
SELECT
    u.Email,
    u.DisplayName,
    o.SavingsGroupCount,      -- how many 'Savings' groups the household has (usually 1 per month)
    o.PristineGroupCount,     -- how many are the untouched starter shape
    CASE
        WHEN ej.OwnerId IS NOT NULL THEN 'SKIP: already owns an Emergency Fund jar'
        WHEN o.AllPristine = 1      THEN 'WOULD REPAIR'
        ELSE 'SKIP: a Savings group deviates from the starter shape'
    END AS Verdict
FROM OwnerRollup o
LEFT JOIN AspNetUsers u ON u.Id = o.OwnerId
LEFT JOIN (SELECT DISTINCT OwnerId FROM Jars WHERE Name = 'Emergency Fund') ej
       ON ej.OwnerId = o.OwnerId
ORDER BY Verdict, u.Email;


/* ---------------------------------------------------------------------------
   2. Line-level detail for the households that WOULD be repaired.
      Each row is a budget-month line the seeder will flip to Savings and link
      to that household's single new "Emergency Fund" jar.
   --------------------------------------------------------------------------- */
;WITH SavingsGroups AS (
    SELECT c.Id AS CategoryId, m.OwnerId, m.Year, m.Month,
           c.Kind,
           (SELECT COUNT(*) FROM BudgetItems i WHERE i.BudgetCategoryId = c.Id) AS ItemCount
    FROM BudgetCategories c
    JOIN BudgetMonths m ON m.Id = c.BudgetMonthId
    WHERE c.Name = 'Savings'
),
GroupFlags AS (
    SELECT sg.*,
           CASE WHEN sg.Kind = 0 AND sg.ItemCount = 1
                     AND EXISTS (SELECT 1 FROM BudgetItems i
                                 WHERE i.BudgetCategoryId = sg.CategoryId
                                   AND i.Name = 'Emergency Fund'
                                   AND i.SavingsId IS NULL
                                   AND i.DueDay IS NULL)
                THEN 1 ELSE 0 END AS IsPristine
    FROM SavingsGroups sg
),
QualifyingOwners AS (
    SELECT OwnerId
    FROM GroupFlags
    GROUP BY OwnerId
    HAVING MIN(IsPristine) = 1
       AND OwnerId NOT IN (SELECT OwnerId FROM Jars WHERE Name = 'Emergency Fund')
)
SELECT
    u.Email,
    g.Year, g.Month,
    i.Name        AS LineName,
    i.PlannedAmount,
    i.SavingsId   AS CurrentSavingsId   -- will be NULL now; the seeder fills it
FROM GroupFlags g
JOIN QualifyingOwners q ON q.OwnerId = g.OwnerId
JOIN BudgetItems i      ON i.BudgetCategoryId = g.CategoryId
LEFT JOIN AspNetUsers u ON u.Id = g.OwnerId
ORDER BY u.Email, g.Year, g.Month;


/* ---------------------------------------------------------------------------
   3. Full transparency: every 'Savings' group in the DB with a reason it is or
      isn't pristine — use this to sanity-check any "SKIP" verdict above.
   --------------------------------------------------------------------------- */
SELECT
    u.Email,
    m.Year, m.Month,
    CASE c.Kind WHEN 0 THEN 'Expense' WHEN 1 THEN 'Income' WHEN 2 THEN 'Savings' END AS GroupKind,
    (SELECT COUNT(*) FROM BudgetItems i WHERE i.BudgetCategoryId = c.Id) AS ItemCount,
    (SELECT TOP 1 i.Name FROM BudgetItems i WHERE i.BudgetCategoryId = c.Id ORDER BY i.DisplayOrder) AS FirstItemName,
    CASE
        WHEN c.Kind <> 0 THEN 'not Expense-kind (already migrated or a real jar group)'
        WHEN (SELECT COUNT(*) FROM BudgetItems i WHERE i.BudgetCategoryId = c.Id) <> 1
             THEN 'group does not hold exactly one line'
        WHEN NOT EXISTS (SELECT 1 FROM BudgetItems i
                         WHERE i.BudgetCategoryId = c.Id
                           AND i.Name = 'Emergency Fund' AND i.SavingsId IS NULL AND i.DueDay IS NULL)
             THEN 'the single line is renamed / already linked / a bill'
        ELSE 'PRISTINE starter shape'
    END AS Assessment
FROM BudgetCategories c
JOIN BudgetMonths m     ON m.Id = c.BudgetMonthId
LEFT JOIN AspNetUsers u ON u.Id = m.OwnerId
WHERE c.Name = 'Savings'
ORDER BY u.Email, m.Year, m.Month;
