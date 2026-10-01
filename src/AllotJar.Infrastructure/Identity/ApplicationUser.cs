using Microsoft.AspNetCore.Identity;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// The application's identity user. Extends <see cref="IdentityUser"/> (string GUID key)
/// so we get the full ASP.NET Core Identity stack — password hashing, lockout,
/// security stamps — for free. Budget entities reference this user via OwnerId.
/// </summary>
public class ApplicationUser : IdentityUser
{
    /// <summary>Friendly name shown in the UI; derived from <see cref="FirstName"/> + <see cref="LastName"/>.</summary>
    public string? DisplayName { get; set; }

    /// <summary>Given name, captured at registration.</summary>
    public string? FirstName { get; set; }

    /// <summary>Family name, captured at registration.</summary>
    public string? LastName { get; set; }

    /// <summary>
    /// The user's home currency (ISO 4217). Drives the app-wide default + display label;
    /// individual accounts may still hold their own currency. Defaults to EUR.
    /// </summary>
    public string PreferredCurrency { get; set; } = UserPreferences.DefaultCurrency;

    /// <summary>
    /// How money values are grouped/decimal-separated for this user (a stable key the
    /// client maps to a locale, e.g. "dot-comma"). Independent of <see cref="PreferredCurrency"/>.
    /// </summary>
    public string NumberFormat { get; set; } = UserPreferences.DefaultNumberFormat;

    /// <summary>When the user accepted the terms/privacy policy at registration; null for legacy logins.</summary>
    public DateTime? ConsentedUtc { get; set; }

    /// <summary>
    /// Which household this login is currently viewing, when it can access more than one. Null means
    /// its own household (OwnerId == this user's id). Set by the household switcher.
    /// </summary>
    public string? ActiveOwnerId { get; set; }

    /// <summary>
    /// The password was set by someone else (an owner's direct invite with a temporary password),
    /// so the login must choose its own before it can do anything else (S-P2-3, P59). Cleared by
    /// change-password, a password reset, or Google removing the password.
    /// </summary>
    public bool MustChangePassword { get; set; }
}
