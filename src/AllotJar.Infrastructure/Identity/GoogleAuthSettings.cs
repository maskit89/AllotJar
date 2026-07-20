namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Bound from the "Google" configuration section. With no <see cref="ClientId"/> Google sign-in is
/// effectively OFF: the server rejects every credential (nothing can pass an audience check
/// against no audience) and the client hides the button (it needs VITE_GOOGLE_CLIENT_ID). The
/// client id is public — it also ships in the SPA bundle — so unlike Jwt:Key it may live in
/// committed config; the same OAuth client serves every environment via its authorized origins.
/// </summary>
public class GoogleAuthSettings
{
    public const string SectionName = "Google";

    /// <summary>The OAuth 2.0 Web client id ("….apps.googleusercontent.com").</summary>
    public string? ClientId { get; set; }

    /// <summary>
    /// Substitute the Development-only fake validator so test harnesses can drive the sign-in flow
    /// without Google credentials. DOUBLE-gated: this flag AND IHostEnvironment.IsDevelopment()
    /// must both hold — production can never enable the fake through configuration alone.
    /// </summary>
    public bool UseFakeValidator { get; set; }
}
