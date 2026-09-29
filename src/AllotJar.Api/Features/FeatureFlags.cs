namespace AllotJar.Api.Features;

/// <summary>
/// Toggles for the features that go beyond core zero-based budgeting. All default ON, so
/// the app ships with everything; turning one OFF (via the "Features" config section)
/// hides it and 404s its endpoints — a stripped-back, core-budgeting mode.
/// </summary>
public class FeatureFlags
{
    public const string SectionName = "Features";

    /// <summary>Accounts &amp; derived balances (YNAB-style register).</summary>
    public bool Accounts { get; set; } = true;

    /// <summary>
    /// Entering a hand-made transaction paid in another currency (its budget-currency amount is
    /// still what counts) and account currency labels. Off hides only that entry option; rows
    /// already waiting for a budget-currency amount can still be confirmed.
    /// </summary>
    public bool MultiCurrency { get; set; } = true;

    /// <summary>CAMT.053 SEPA statement import.</summary>
    public bool CamtImport { get; set; } = true;

    /// <summary>Reports, trends and the annual overview.</summary>
    public bool Reports { get; set; } = true;

    /// <summary>Sinking-fund management: targets, due dates, accrual methods and projections.</summary>
    public bool Jars { get; set; } = true;

    /// <summary>Household members and the rules-based income allocation engine.</summary>
    public bool HouseholdAllocation { get; set; } = true;

    /// <summary>Multi-user access: additional logins for the household with per-role permissions.</summary>
    public bool HouseholdAccess { get; set; } = true;

    /// <summary>
    /// Google Analytics (GA4) usage tracking in the SPA. Defaults OFF so analytics ships
    /// dark and is enabled deliberately (and only ever loads after the user consents and a
    /// build-time measurement ID is present).
    /// </summary>
    public bool Analytics { get; set; } = false;

    public bool IsEnabled(string feature) => feature switch
    {
        nameof(Accounts) => Accounts,
        nameof(MultiCurrency) => MultiCurrency,
        nameof(CamtImport) => CamtImport,
        nameof(Reports) => Reports,
        nameof(Jars) => Jars,
        nameof(HouseholdAllocation) => HouseholdAllocation,
        nameof(HouseholdAccess) => HouseholdAccess,
        nameof(Analytics) => Analytics,
        _ => true,
    };
}
