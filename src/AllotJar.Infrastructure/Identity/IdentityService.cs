using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// <see cref="IIdentityService"/> backed by ASP.NET Core Identity's <see cref="UserManager{TUser}"/>.
/// Keeps the Identity dependency in Infrastructure while Application handlers work against the
/// abstraction.
/// </summary>
public class IdentityService : IIdentityService
{
    // A throwaway hash verified on the unknown-email path so that path costs roughly the same as a
    // real password check (PBKDF2), denying an attacker a timing signal to enumerate accounts.
    private static readonly string DummyPasswordHash =
        new PasswordHasher<ApplicationUser>().HashPassword(new ApplicationUser(), "timing-equalizer");

    private readonly UserManager<ApplicationUser> _userManager;

    public IdentityService(UserManager<ApplicationUser> userManager)
    {
        _userManager = userManager;
    }

    public async Task<bool> EmailExistsAsync(string email) =>
        await _userManager.FindByEmailAsync(email) is not null;

    public async Task<UserAccount?> FindByEmailAsync(string email)
    {
        var user = await _userManager.FindByEmailAsync(email);
        return user is null ? null : ToAccount(user);
    }

    public async Task<UserAccount?> FindByIdAsync(string userId)
    {
        var user = await _userManager.FindByIdAsync(userId);
        return user is null ? null : ToAccount(user);
    }

    public async Task<IReadOnlySet<string>> MustChangePasswordAmongAsync(IReadOnlyCollection<string> userIds)
    {
        if (userIds.Count == 0)
        {
            return new HashSet<string>();
        }
        var ids = userIds.ToList();
        return (await _userManager.Users
                .Where(u => ids.Contains(u.Id) && u.MustChangePassword)
                .Select(u => u.Id)
                .ToListAsync())
            .ToHashSet();
    }

    private static UserAccount ToAccount(ApplicationUser user) =>
        new(user.Id, user.Email!, user.DisplayName, user.EmailConfirmed, user.MustChangePassword);

    public async Task<CurrencyCode?> GetPreferredCurrencyAsync(string userId)
    {
        var user = await _userManager.FindByIdAsync(userId);
        // NormalizeCurrency maps blank to the app default and rejects garbage, so a stored
        // value that predates validation can never leak an invalid code into the domain.
        var normalized = UserPreferences.NormalizeCurrency(user?.PreferredCurrency);
        return normalized is null ? null : CurrencyCode.From(normalized);
    }

    public async Task<CreateUserResult> CreateUserAsync(
        string email, string password, string? displayName, bool consented = false, bool mustChangePassword = false)
    {
        var user = new ApplicationUser
        {
            UserName = email,
            Email = email,
            DisplayName = displayName,
            ConsentedUtc = consented ? DateTime.UtcNow : null,
            MustChangePassword = mustChangePassword,
        };
        var result = await _userManager.CreateAsync(user, password);
        return result.Succeeded
            ? CreateUserResult.Success(user.Id)
            : CreateUserResult.Failure(result.Errors.Select(e => e.Description));
    }

    public async Task SetActiveHouseholdAsync(string userId, string? ownerId)
    {
        var user = await _userManager.FindByIdAsync(userId);
        if (user is null || user.ActiveOwnerId == ownerId)
        {
            return;
        }

        user.ActiveOwnerId = ownerId;
        await _userManager.UpdateAsync(user);
    }

    public async Task<IReadOnlyList<string>> ChangePasswordAsync(
        string userId, string currentPassword, string newPassword)
    {
        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return new[] { "User not found." };
        }

        var result = await _userManager.ChangePasswordAsync(user, currentPassword, newPassword);
        return result.Succeeded ? Array.Empty<string>() : result.Errors.Select(e => e.Description).ToArray();
    }

    public async Task<CredentialCheckResult> CheckCredentialsAsync(string email, string password)
    {
        var user = await _userManager.FindByEmailAsync(email);
        if (user is null)
        {
            // Spend roughly the same time as a real verify so timing can't reveal that the email
            // is unknown, then report the same generic failure as a wrong password.
            _userManager.PasswordHasher.VerifyHashedPassword(new ApplicationUser(), DummyPasswordHash, password);
            return CredentialCheckResult.Invalid;
        }

        // Self-heal: pre-existing logins were created before lockout was enabled. Without this their
        // failed-attempt count would never lock them, so opt every login in on first sign-in.
        if (!await _userManager.GetLockoutEnabledAsync(user))
        {
            await _userManager.SetLockoutEnabledAsync(user, true);
        }

        if (await _userManager.IsLockedOutAsync(user))
        {
            return CredentialCheckResult.LockedOut;
        }

        if (!await _userManager.CheckPasswordAsync(user, password))
        {
            // Count the failure; Identity locks the account once it crosses MaxFailedAccessAttempts.
            await _userManager.AccessFailedAsync(user);
            return await _userManager.IsLockedOutAsync(user)
                ? CredentialCheckResult.LockedOut
                : CredentialCheckResult.Invalid;
        }

        await _userManager.ResetAccessFailedCountAsync(user);
        var stamp = await _userManager.GetSecurityStampAsync(user);
        return CredentialCheckResult.Success(user.Id, user.Email!, user.DisplayName, stamp, user.ActiveOwnerId);
    }
}
