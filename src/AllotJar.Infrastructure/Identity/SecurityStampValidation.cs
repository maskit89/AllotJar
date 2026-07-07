namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Decides whether a JWT is still valid given the security stamp baked into it versus the user's
/// current stamp. Rotating the stamp (on password change, or an explicit "sign out everywhere")
/// invalidates every token issued beforehand — that's how an otherwise-stateless JWT becomes
/// revocable. Pure and side-effect free so the rule can be unit-tested directly.
/// </summary>
public static class SecurityStampValidation
{
    /// <returns>
    /// True if the request should be allowed: either the token predates revocation support (no
    /// stamp claim — valid until it expires naturally) or its stamp matches the current one.
    /// </returns>
    public static bool IsValid(string? tokenStamp, string? currentStamp)
    {
        if (string.IsNullOrEmpty(tokenStamp))
        {
            // Legacy token issued before this feature shipped — don't mass-log-out on rollout.
            return true;
        }

        return !string.IsNullOrEmpty(currentStamp)
            && string.Equals(tokenStamp, currentStamp, StringComparison.Ordinal);
    }
}
