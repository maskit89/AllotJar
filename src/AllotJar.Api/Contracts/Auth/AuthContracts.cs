using System.ComponentModel.DataAnnotations;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Contracts.Auth;

/// <summary>A new login. The household starts empty (rule 81); there is no sample data.</summary>
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
/// session. The optional currency/format are the CLIENT's sign-up defaults (EUR, and the
/// locale-detected number format), applied only when this sign-in creates the account (mirrors
/// the register form's pre-selection).
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
/// <see cref="NeedsConsent"/> flags invite-created logins that haven't accepted the terms yet.
/// <see cref="SharingReviewPending"/> asks the login to review who sees its personal accounts (rule 32).
/// <see cref="BudgetCurrency"/> is the active household's one currency (rule 85), which labels its money;
/// <see cref="CurrencyLocked"/> says the login's own household holds data, so its currency is fixed.</summary>
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
    bool EmailConfirmed,
    bool MustChangePassword = false,
    bool SharingReviewPending = false,
    string BudgetCurrency = "EUR",
    bool CurrencyLocked = false,
    string OwnBudgetCurrency = "EUR");

/// <summary>One household the login can act in, for the household switcher. The active one has <see cref="IsActive"/>.</summary>
public record HouseholdSummary(string OwnerId, string Label, HouseholdRole Role, bool IsActive, bool IsOwn);

/// <summary>Switches which household the login is acting in (must have access). <c>OwnerId</c> = the target household key.</summary>
public record SwitchHouseholdRequest(string OwnerId);

/// <summary>
/// Leaves a household the login joined. <c>OwnerId</c> = the household to leave (not the caller's own).
/// <c>PrivateAccounts</c> = how many of the caller's private accounts there the leaver was warned
/// about (S-P3-7); the leave is refused while it holds more than that.
/// </summary>
public record LeaveHouseholdRequest([Required] string OwnerId, int PrivateAccounts = 0);

/// <summary>What leaving a household would leave behind: the caller's private accounts there.</summary>
public record LeavePreviewResponse(int PrivateAccounts);

/// <summary>
/// What deleting the login takes with it: its own household (<c>OwnsHousehold</c>). While other
/// logins have access to it (<c>OthersInHousehold</c>) the delete is refused. <c>HasPassword</c>:
/// the confirmation asks for the password, else for the email typed.
/// </summary>
public record DeleteAccountPreviewResponse(bool OwnsHousehold, int OthersInHousehold, bool HasPassword);

/// <summary>
/// Deletes the signed-in login and its data. A login with a password confirms with it
/// (<c>Password</c>); a Google-only login types its email (<c>ConfirmEmail</c>).
/// </summary>
public record DeleteAccountRequest(string? ConfirmEmail = null, string? Password = null);

/// <summary>
/// One sign-in still in force, for the list of signed-in devices: the device it was made on (null
/// when unknown), when it began, when the device last refreshed it, and whether it is the caller's.
/// </summary>
public record SessionResponse(Guid Id, string? Device, DateTime StartedUtc, DateTime LastActiveUtc, bool Current);

/// <summary>
/// A login with a passkey signed in with its password, Google or a reset link: no session yet. The
/// client asks the device for the passkey with <paramref name="Options"/> (WebAuthn request options,
/// JSON) and answers with <paramref name="Ticket"/>, or uses a recovery code instead.
/// </summary>
public record SecondStepResponse(bool PasskeyRequired, string Ticket, string Options);

/// <summary>A started passkey ceremony: its id to answer with, and the WebAuthn options (JSON) for the browser.</summary>
public record PasskeyCeremonyResponse(string Ceremony, string Options);

/// <summary>The browser's answer to a ceremony: the PublicKeyCredential as JSON (WebAuthn toJSON shape).</summary>
public record PasskeyAnswerRequest(string Ceremony, string Credential);

public record SecondStepPasskeyRequest(string Ticket, string Credential);

public record SecondStepRecoveryCodeRequest(string Ticket, string Code);

/// <summary>
/// Proof that the person at the keyboard is the login's owner before its passkeys or codes change:
/// its password, one of its passkeys (a Proof ceremony answered), or a recovery code. Not needed
/// within minutes of signing in.
/// </summary>
public record PasskeyProof(string? Password, string? RecoveryCode, string? Ceremony, string? Credential);

public record PasskeyProofRequest(PasskeyProof? Proof);

/// <summary>One of the login's passkeys. <paramref name="Id"/> is its credential id, base64url.</summary>
public record PasskeyResponse(string Id, string? Name, DateTime CreatedUtc);

public record PasskeysResponse(IReadOnlyList<PasskeyResponse> Passkeys, int RecoveryCodesLeft);

/// <summary>A passkey was added. <paramref name="RecoveryCodes"/> come with the first one only, shown once.</summary>
public record AddPasskeyResponse(PasskeyResponse Passkey, IReadOnlyList<string>? RecoveryCodes);

public record RecoveryCodesResponse(IReadOnlyList<string> RecoveryCodes);
