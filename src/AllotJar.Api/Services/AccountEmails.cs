using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Api.Services;

/// <summary>
/// Sends the emails that carry a credential-setting link: a password reset, a direct-invite login's
/// "choose your password", and an invite link. Each send is detached, best-effort work in its own
/// scope, so a response never waits on (or can be timed against) the provider, and links are built
/// from configuration only, never from the request's Host header.
/// </summary>
public sealed class AccountEmails
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly EmailSettings _settings;
    private readonly ILogger<AccountEmails> _logger;

    public AccountEmails(IServiceScopeFactory scopeFactory, IOptions<EmailSettings> settings, ILogger<AccountEmails> logger)
    {
        _scopeFactory = scopeFactory;
        _settings = settings.Value;
        _logger = logger;
    }

    private string Link(string path) => $"{_settings.AppBaseUrl.TrimEnd('/')}{path}";

    /// <summary>
    /// Emails a link to set the login's password, if (and only if) an account exists for the
    /// address. A login still on an owner-set temporary password gets the "choose your password"
    /// wording; everyone else the reset wording.
    /// </summary>
    public void SendPasswordLink(string email) => Dispatch("a password link", async scope =>
    {
        var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
        var user = await users.FindByEmailAsync(email);
        if (user is null)
        {
            return null; // unknown address: nothing to send, and never revealed to the caller
        }

        var token = await users.GeneratePasswordResetTokenAsync(user);
        var link = Link($"/reset-password?email={Uri.EscapeDataString(user.Email!)}&token={Uri.EscapeDataString(token)}");
        return user.MustChangePassword
            ? InvitationEmails.ChooseYourPassword(user.Email!, link)
            : PasswordResetEmail.Build(user.Email!, link);
    });

    /// <summary>Emails a one-time invite link to the invited address; the inviter never sees the link.</summary>
    public void SendInviteLink(string email, string inviterName, string rawToken) => Dispatch("an invite link", _ =>
        Task.FromResult<EmailMessage?>(InvitationEmails.InviteLink(
            email, inviterName, Link($"/accept-invite?code={Uri.EscapeDataString(rawToken)}"))));

    private void Dispatch(string what, Func<IServiceScope, Task<EmailMessage?>> build)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var message = await build(scope);
                if (message is not null)
                {
                    await scope.ServiceProvider.GetRequiredService<IEmailSender>().SendAsync(message);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send {What} email.", what);
            }
        });
    }
}
