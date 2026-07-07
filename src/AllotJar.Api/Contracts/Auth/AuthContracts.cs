using System.ComponentModel.DataAnnotations;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Contracts.Auth;

public record RegisterRequest(
    [Required, EmailAddress] string Email,
    [Required, MinLength(8)] string Password,
    [Required] string FirstName,
    [Required] string LastName,
    string? PreferredCurrency,
    string? NumberFormat,
    bool AcceptedTerms);

public record LoginRequest(
    [Required, EmailAddress] string Email,
    [Required] string Password);

public record AuthResponse(
    string Token,
    DateTime ExpiresAtUtc,
    string UserId,
    string Email,
    HouseholdRole Role,
    string? DisplayName);

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
    bool NeedsConsent);

/// <summary>One household the login can act in, for the household switcher. The active one has <see cref="IsActive"/>.</summary>
public record HouseholdSummary(string OwnerId, string Label, HouseholdRole Role, bool IsActive, bool IsOwn);

/// <summary>Switches which household the login is acting in (must have access). <c>OwnerId</c> = the target household key.</summary>
public record SwitchHouseholdRequest(string OwnerId);

/// <summary>Leaves a household the login joined. <c>OwnerId</c> = the household to leave (not the caller's own).</summary>
public record LeaveHouseholdRequest([Required] string OwnerId);
