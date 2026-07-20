using System.ComponentModel.DataAnnotations;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Contracts.Auth;

/// <summary>
/// <see cref="IncludeSampleData"/> opts the new account into a pre-filled sample budget to
/// explore; omitted/false (the default) starts the account empty.
/// </summary>
public record RegisterRequest(
    [Required, EmailAddress] string Email,
    [Required, MinLength(8)] string Password,
    [Required] string FirstName,
    [Required] string LastName,
    string? PreferredCurrency,
    string? NumberFormat,
    bool AcceptedTerms,
    bool IncludeSampleData);

public record LoginRequest(
    [Required, EmailAddress] string Email,
    [Required] string Password);

/// <summary><see cref="IsNewAccount"/> is set only by Google sign-in (true = this call created the
/// account), so the client can report sign_up vs login; every other endpoint leaves it null.</summary>
public record AuthResponse(
    string Token,
    DateTime ExpiresAtUtc,
    string UserId,
    string Email,
    HouseholdRole Role,
    string? DisplayName,
    bool? IsNewAccount = null);

/// <summary>
/// Exchanges a Google Identity Services ID token (the button's `credential`) for an AllotJar
/// session. The optional currency/format are the CLIENT's locale-detected defaults, applied only
/// when this sign-in creates the account (mirrors the register form's pre-selection).
/// </summary>
public record GoogleLoginRequest(
    [Required] string Credential,
    string? PreferredCurrency,
    string? NumberFormat);

/// <summary>
/// Registration outcome when the email already belongs to an UNVERIFIED account: no session is
/// issued (it isn't yet proven to be the registrant's), and a claim/reset link is emailed to the
/// address so its true owner can take it over. The client shows a neutral "check your email".
/// </summary>
public record RegistrationPendingResponse(bool VerificationPending, string Email);

/// <summary>Confirms an emailed address-verification token.</summary>
public record ConfirmEmailRequest(
    [Required, EmailAddress] string Email,
    [Required] string Token);

/// <summary>
/// Redeems a one-time invite link. A new user sets <see cref="Password"/> and must accept the terms
/// (<see cref="AcceptedTerms"/>); a signed-in user joining with their existing login omits both
/// (and sends their bearer token instead).
/// </summary>
public record AcceptInviteRequest(
    [Required] string Token,
    string? Password,
    string? DisplayName,
    bool AcceptedTerms);

/// <summary>Self-service password change for the authenticated login.</summary>
public record ChangePasswordRequest(
    [Required] string CurrentPassword,
    [Required, MinLength(8)] string NewPassword);

/// <summary>Requests a password-reset email. The response is always 204 — no account enumeration.</summary>
public record ForgotPasswordRequest(
    [Required, EmailAddress] string Email);

/// <summary>Redeems an emailed reset token and sets a new password.</summary>
public record ResetPasswordRequest(
    [Required, EmailAddress] string Email,
    [Required] string Token,
    [Required, MinLength(8)] string NewPassword);

/// <summary>Self-service profile + money-display preferences for the authenticated login.</summary>
public record UpdatePreferencesRequest(
    string? FirstName,
    string? LastName,
    string? PreferredCurrency,
    string? NumberFormat);

/// <summary>The login's current name + money-display preferences.</summary>
public record PreferencesResponse(
    string? FirstName,
    string? LastName,
    string? DisplayName,
    string PreferredCurrency,
    string NumberFormat);

/// <summary>The authenticated login's identity, active household, access level and preferences.
/// <see cref="NeedsConsent"/> flags invite-created logins that haven't accepted the terms yet.</summary>
public record MeResponse(
    string UserId,
    string Email,
    string? DisplayName,
    HouseholdRole Role,
    string OwnerId,
    Guid? MemberId,
    string? FirstName,
    string? LastName,
    string PreferredCurrency,
    string NumberFormat,
    IReadOnlyList<HouseholdSummary> Households,
    bool NeedsConsent,
    bool HasPassword,
    bool HasGoogle,
    bool EmailConfirmed);

/// <summary>One household the login can act in, for the household switcher. The active one has <see cref="IsActive"/>.</summary>
public record HouseholdSummary(string OwnerId, string Label, HouseholdRole Role, bool IsActive, bool IsOwn);

/// <summary>Switches which household the login is acting in (must have access). <c>OwnerId</c> = the target household key.</summary>
public record SwitchHouseholdRequest(string OwnerId);

/// <summary>Leaves a household the login joined. <c>OwnerId</c> = the household to leave (not the caller's own).</summary>
public record LeaveHouseholdRequest([Required] string OwnerId);
