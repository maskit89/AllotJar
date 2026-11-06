using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Api.Services;

/// <summary>
/// Sends the emails that carry a credential-setting link: a password reset, a direct-invite login's
/// "choose your password", and an invite link. Links are built from configuration only, never from
/// the request's Host header. Forgot-password sends detached, so its response never waits on (or
/// can be timed against) the provider; an invite and a signed-in login asking for its own link
/// wait for the send, so the screen can say truthfully whether the email went out (#298 R2-P2-1).
/// </summary>
public sealed class AccountEmails
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly EmailSettings _settings;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<AccountEmails> _logger;
    private readonly PasswordLinkAllowance _passwordLinks;

    public AccountEmails(
        IServiceScopeFactory scopeFactory, IOptions<EmailSettings> settings, IHostEnvironment environment,
        ILogger<AccountEmails> logger, PasswordLinkAllowance passwordLinks)
    {
        _scopeFactory = scopeFactory;
        _settings = settings.Value;
        _environment = environment;
        _logger = logger;
        _passwordLinks = passwordLinks;
    }

    private string Link(string path) => $"{_settings.AppBaseUrl.TrimEnd('/')}{path}";

    /// <summary>
    /// Whether an email sent now can reach anyone. Outside Development, the logging fallback (no
    /// provider configured) delivers nothing, so an invite that depends on email must not start.
    /// In Development it feeds the local mailbox the tests and journeys read.
    /// </summary>
    public bool CanDeliver()
    {
        if (_environment.IsDevelopment())
        {
            return true;
        }
        using var scope = _scopeFactory.CreateScope();
        return scope.ServiceProvider.GetRequiredService<IEmailSender>() is not LoggingEmailSender;
    }

    /// <summary>
    /// Emails a link to set the login's password, if (and only if) an account exists for the
    /// address, without waiting (forgot-password). A login still on an owner-set temporary password
    /// gets the "choose your password" wording; everyone else the reset wording. Past the login's
    /// <see cref="PasswordLinkAllowance"/> nothing is sent, silently, like an unknown address.
    /// </summary>
    public void SendPasswordLink(string email)
    {
        _ = Task.Run(async () =>
        {
            using var scope = _scopeFactory.CreateScope();
            await SendPasswordLinkAsync(scope, email, CancellationToken.None);
        });
    }

    /// <summary>
    /// Emails the password link to the address and waits: Sent once the provider accepted it,
    /// TooSoon past the login's <see cref="PasswordLinkAllowance"/>, NotSent when there is no such
    /// login, nothing can deliver it, or the provider failed (logged).
    /// </summary>
    public async Task<PasswordLinkResult> TrySendPasswordLinkAsync(string email, CancellationToken ct)
    {
        if (!CanDeliver())
        {
            return PasswordLinkResult.NotSent;
        }
        using var scope = _scopeFactory.CreateScope();
        return await SendPasswordLinkAsync(scope, email, ct);
    }

    private async Task<PasswordLinkResult> SendPasswordLinkAsync(IServiceScope scope, string email, CancellationToken ct)
    {
        string? claimed = null;
        var tooSoon = false;
        var sent = await TrySendAsync(scope, "a password link", async () =>
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var user = await users.FindByEmailAsync(email);
            if (user is null)
            {
                return null; // unknown address: nothing to send, and never revealed to the caller
            }
            if (!_passwordLinks.TryClaim(user.Id))
            {
                tooSoon = true;
                _logger.LogWarning("Password link for login {UserId} not sent: too many in the last few minutes.", user.Id);
                return null;
            }
            claimed = user.Id;
            return await PasswordLinkAsync(users, user);
        }, ct);

        if (!sent && claimed is not null)
        {
            _passwordLinks.Release(claimed); // nothing went out, so it doesn't count
        }
        return sent ? PasswordLinkResult.Sent : tooSoon ? PasswordLinkResult.TooSoon : PasswordLinkResult.NotSent;
    }

    /// <summary>Emails a one-time invite link to the invited address and waits; the inviter never sees the link.</summary>
    public async Task<bool> TrySendInviteLinkAsync(string email, string inviterName, string rawToken, CancellationToken ct)
    {
        if (!CanDeliver())
        {
            return false;
        }
        using var scope = _scopeFactory.CreateScope();
        return await TrySendAsync(scope, "an invite link", () => Task.FromResult<EmailMessage?>(InvitationEmails.InviteLink(
            email, inviterName, Link($"/accept-invite?code={Uri.EscapeDataString(rawToken)}"))), ct);
    }

    /// <summary>Tells the login its passkeys or recovery codes changed, without waiting (best effort, logged on failure).</summary>
    public void SendPasskeyNotice(string email, PasskeyNotice notice, string? device)
    {
        _ = Task.Run(async () =>
        {
            using var scope = _scopeFactory.CreateScope();
            await TrySendAsync(scope, "a passkey notice",
                () => Task.FromResult<EmailMessage?>(PasskeyNoticeEmail.Build(email, notice, device)), CancellationToken.None);
        });
    }

    private async Task<EmailMessage?> PasswordLinkAsync(UserManager<ApplicationUser> users, ApplicationUser user)
    {
        var token = await users.GeneratePasswordResetTokenAsync(user);
        var link = Link($"/reset-password?email={Uri.EscapeDataString(user.Email!)}&token={Uri.EscapeDataString(token)}");
        return user.MustChangePassword
            ? InvitationEmails.ChooseYourPassword(user.Email!, link)
            : PasswordResetEmail.Build(user.Email!, link);
    }

    private async Task<bool> TrySendAsync(IServiceScope scope, string what, Func<Task<EmailMessage?>> build, CancellationToken ct)
    {
        try
        {
            var message = await build();
            if (message is null)
            {
                return false;
            }
            await scope.ServiceProvider.GetRequiredService<IEmailSender>().SendAsync(message, ct);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send {What} email.", what);
            return false;
        }
    }
}
