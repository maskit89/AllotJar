namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Bound from the "Email" configuration section. With no <see cref="ApiKey"/> the app falls back
/// to <see cref="LoggingEmailSender"/> (dev/CI-friendly: no credentials, emails land in the log +
/// in-memory sink). Set the key via user-secrets or the Email__ApiKey environment variable —
/// never commit it.
/// </summary>
public class EmailSettings
{
    public const string SectionName = "Email";

    /// <summary>Provider names understood by <c>AddInfrastructure</c>.</summary>
    public const string ProviderCloudflare = "cloudflare";
    public const string ProviderResend = "resend";

    /// <summary>
    /// Which sending provider to use: <c>cloudflare</c> (Cloudflare Email Service, needs
    /// <see cref="AccountId"/>) or <c>resend</c>. Blank defaults to <c>resend</c> so existing
    /// key-only configurations keep working. Ignored entirely when <see cref="ApiKey"/> is absent —
    /// then the logging fallback is used regardless.
    /// </summary>
    public string? Provider { get; set; }

    /// <summary>
    /// The provider API key/token. Absent ⇒ the logging fallback sender is used (dev/CI need no
    /// credentials). For Cloudflare this is an API token with the "Email Sending: Edit" permission.
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Cloudflare account id — required by the Email Service send endpoint, which is scoped per
    /// account (<c>/client/v4/accounts/{account_id}/email/sending/send</c>). Cloudflare only.
    /// </summary>
    public string? AccountId { get; set; }

    /// <summary>
    /// The From header, "Name &lt;address&gt;" form. The address's domain must be verified with
    /// the provider (DNS DKIM/SPF records) or sends are rejected.
    /// </summary>
    public string FromAddress { get; set; } = "AllotJar <no-reply@allotjar.com>";

    /// <summary>
    /// Absolute origin used to build links in emails (e.g. the password-reset URL). Deliberately
    /// config-only — deriving it from the request's Host header would let a spoofed header inject
    /// an attacker-controlled link into a legitimate reset email.
    /// </summary>
    public string AppBaseUrl { get; set; } = ProductionOrigin;

    /// <summary>The production site's origin: the built-in <see cref="AppBaseUrl"/>.</summary>
    public const string ProductionOrigin = "https://www.allotjar.com";

    /// <summary>Production is public at the apex as well as www, so either origin fits it.</summary>
    public static readonly string[] ProductionOrigins = [ProductionOrigin, "https://allotjar.com"];

    /// <summary>The staging site's origin; its settings file must set <see cref="AppBaseUrl"/> to it.</summary>
    public const string StagingOrigin = "https://staging.allotjar.com";

    /// <summary>
    /// Log full message bodies from the fallback sender. Development-only convenience (the reset
    /// link is in the body); keep OFF elsewhere so tokens never reach persisted logs.
    /// </summary>
    public bool LogBodies { get; set; }

    /// <summary>
    /// The provider actually in effect: blank defaults to <see cref="ProviderResend"/> (back-compat
    /// with key-only configurations), otherwise the trimmed lowercase name. Single source of truth
    /// so the composition root and the diagnostics can never disagree about what is running.
    /// </summary>
    public string ResolvedProvider =>
        string.IsNullOrWhiteSpace(Provider) ? ProviderResend : Provider.Trim().ToLowerInvariant();

    /// <summary>
    /// A configuration smell worth warning about even though a real sender DID resolve — or
    /// <c>null</c> when nothing looks wrong.
    ///
    /// Today that means a Cloudflare account id which isn't the documented 32-character hex form.
    /// A truncated or ellipsis-bearing copy/paste (e.g. pasting the "49033e69c8021025…" shown in a
    /// dashboard or a doc) passes the not-empty check, so startup reports a healthy provider — and
    /// then EVERY send 404s with "could not route … perhaps your object identifier is invalid?",
    /// off-request and invisible to the user. Warning at startup turns that into an immediate,
    /// named signal. Deliberately NOT fatal and NOT part of sender selection: if Cloudflare ever
    /// changes the id format, an over-strict check must not disable email.
    /// </summary>
    public string? DescribeSuspiciousConfiguration()
    {
        if (ResolvedProvider != ProviderCloudflare || string.IsNullOrWhiteSpace(AccountId))
        {
            return null;
        }

        var id = AccountId.Trim();
        if (id.Length == 32 && id.All(Uri.IsHexDigit))
        {
            return null;
        }

        return $"Email:AccountId does not look like a Cloudflare account id (expected 32 hex " +
               $"characters, got {id.Length}) — sends will fail with a 404 routing error. Copy the " +
               "FULL id from the dashboard URL or the account home sidebar, with no ellipsis.";
    }

    /// <summary>
    /// Why every emailed link would open the WRONG site for the host this API runs on — or
    /// <c>null</c> when <see cref="AppBaseUrl"/> fits the environment.
    ///
    /// The built-in default is the production origin, so a staging settings file that simply
    /// omits <c>Email:AppBaseUrl</c> emails password-reset and invite links that open
    /// www.allotjar.com, where the token (signed with staging's own DataProtection keys) is not
    /// valid (12 October 2026). Deploy.ps1 refuses such a file before a deploy; this is the
    /// matching check for an API that is already running (a pool recycle after a hand edit),
    /// logged as an Error at startup so it reaches the error alerts. Only the two named
    /// environments are judged: Development and the test hosts may point anywhere.
    /// </summary>
    public string? DescribeEnvironmentMismatch(string environmentName)
    {
        var isStaging = string.Equals(environmentName, "Staging", StringComparison.OrdinalIgnoreCase);
        var isProduction = string.Equals(environmentName, "Production", StringComparison.OrdinalIgnoreCase);
        if (!isStaging && !isProduction)
        {
            return null;
        }

        if (!Uri.TryCreate(AppBaseUrl?.Trim(), UriKind.Absolute, out var url)
            || (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps))
        {
            return $"Email:AppBaseUrl '{AppBaseUrl}' is not an absolute http(s) URL, so links in emails are broken.";
        }

        var origin = url.GetLeftPart(UriPartial.Authority);
        var expected = isStaging ? [StagingOrigin] : ProductionOrigins;
        if (expected.Contains(origin, StringComparer.OrdinalIgnoreCase))
        {
            return null;
        }

        var expectedFile = isStaging ? "appsettings.Staging.json" : "appsettings.Production.json";
        return $"Email:AppBaseUrl is {AppBaseUrl}, so every emailed link (password reset, invite) opens {origin} " +
               $"instead of this {environmentName} site. Set Email:AppBaseUrl to {string.Join(" or ", expected)} in {expectedFile} " +
               "and recycle the API app pool.";
    }

    /// <summary>
    /// Why no real provider resolved, phrased as actionable remediation — or <c>null</c> when the
    /// configuration IS complete. Shared by the startup report and the fallback sender so both
    /// name the ACTUAL problem: telling an operator to "set Email:ApiKey" when they already have
    /// one (they typo'd the provider, or omitted AccountId) sends them looking in the wrong place.
    /// </summary>
    public string? DescribeMisconfiguration()
    {
        if (string.IsNullOrWhiteSpace(ApiKey))
        {
            return "no Email:ApiKey is configured — set it (plus Email:AccountId for Cloudflare) to enable sending";
        }

        var provider = ResolvedProvider;

        if (provider == ProviderCloudflare)
        {
            return string.IsNullOrWhiteSpace(AccountId)
                ? "Email:Provider is 'cloudflare' but Email:AccountId is missing — Cloudflare's send endpoint is account-scoped"
                : null;
        }

        if (provider == ProviderResend)
        {
            return null;
        }

        return $"Email:Provider '{Provider}' is not recognised — use '{ProviderCloudflare}' or '{ProviderResend}' " +
               "(or leave it blank for resend)";
    }
}
