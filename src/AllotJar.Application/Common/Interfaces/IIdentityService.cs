using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Abstraction over ASP.NET Core Identity's <c>UserManager</c>, so Application handlers can
/// create logins and change passwords without depending on the Infrastructure Identity stack.
/// </summary>
public interface IIdentityService
{
    Task<bool> EmailExistsAsync(string email);

    Task<UserAccount?> FindByEmailAsync(string email);

    Task<UserAccount?> FindByIdAsync(string userId);

    /// <summary>
    /// The login's preferred (home) currency, already validated. Null only for an unknown user
    /// whose default cannot be resolved — callers fall back to EUR.
    /// </summary>
    Task<CurrencyCode?> GetPreferredCurrencyAsync(string userId);

    /// <summary>
    /// Creates a login. <paramref name="consented"/> records terms acceptance and must be true only
    /// when the person themselves accepted (e.g. redeeming an invite link) — never when an owner
    /// creates the login on their behalf; those consent on their first sign-in instead.
    /// <paramref name="mustChangePassword"/> is true when someone else chose the password: the
    /// login then has to replace it before it can do anything else.
    /// </summary>
    Task<CreateUserResult> CreateUserAsync(
        string email, string password, string? displayName, bool consented = false, bool mustChangePassword = false);

    /// <summary>Persists which household the login acts in (null = their own). No-op for unknown users.</summary>
    Task SetActiveHouseholdAsync(string userId, string? ownerId);

    Task<IReadOnlyList<string>> ChangePasswordAsync(string userId, string currentPassword, string newPassword);

    /// <summary>
    /// Validates an email/password pair while tracking failed attempts for brute-force protection:
    /// the implementation locks the account for a cooldown after too many consecutive failures, and
    /// resets the counter on success. Returns a coarse outcome only — never reveals whether the
    /// email exists — and equalises timing between the known- and unknown-email paths.
    /// </summary>
    Task<CredentialCheckResult> CheckCredentialsAsync(string email, string password);
}

/// <summary>A login as seen by the Application layer.</summary>
public record UserAccount(string Id, string Email, string? DisplayName);

/// <summary>Result of creating a login. <see cref="UserId"/> is set only when <see cref="Succeeded"/>.</summary>
public record CreateUserResult(bool Succeeded, string? UserId, IReadOnlyList<string> Errors)
{
    public static CreateUserResult Success(string userId) => new(true, userId, Array.Empty<string>());
    public static CreateUserResult Failure(IEnumerable<string> errors) => new(false, null, errors.ToArray());
}

/// <summary>The coarse outcome of a credential check — deliberately does not distinguish an
/// unknown email from a wrong password, to avoid leaking which accounts exist.</summary>
public enum CredentialCheckOutcome
{
    Success,
    InvalidCredentials,
    LockedOut,
}

/// <summary>Outcome of <see cref="IIdentityService.CheckCredentialsAsync"/>. The login details are
/// populated only on <see cref="CredentialCheckOutcome.Success"/>.</summary>
public record CredentialCheckResult(
    CredentialCheckOutcome Outcome, string? UserId, string? Email, string? DisplayName, string? SecurityStamp)
{
    public static CredentialCheckResult Success(
        string userId, string email, string? displayName, string? securityStamp) =>
        new(CredentialCheckOutcome.Success, userId, email, displayName, securityStamp);

    public static readonly CredentialCheckResult Invalid =
        new(CredentialCheckOutcome.InvalidCredentials, null, null, null, null);

    public static readonly CredentialCheckResult LockedOut =
        new(CredentialCheckOutcome.LockedOut, null, null, null, null);
}
