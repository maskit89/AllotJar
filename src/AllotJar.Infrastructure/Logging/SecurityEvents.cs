using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace AllotJar.Infrastructure.Logging;

/// <summary>The sign-in and account events kept in the security log (audit A09-001).</summary>
public enum SecurityEvent
{
    /// <summary>A wrong password at sign-in (the login is named when the address is a real one).</summary>
    SignInFailed,

    /// <summary>A sign-in, or a password re-check, refused because the login is locked out.</summary>
    SignInWhileLocked,

    /// <summary>The wrong password that locked the login.</summary>
    LockedOut,

    /// <summary>A wrong password where a signed-in login was asked for it again (delete, change, proof).</summary>
    PasswordCheckFailed,

    /// <summary>A passkey answer refused (sign-in, second step or proof).</summary>
    PasskeyRefused,

    /// <summary>A wrong or used recovery code.</summary>
    RecoveryCodeRefused,

    /// <summary>A recovery code used up to get in or to prove it is the owner.</summary>
    RecoveryCodeUsed,

    /// <summary>An old refresh token came back: treated as stolen, so every sign-in of the login was ended.</summary>
    RefreshTokenReplayed,

    PasswordChanged,
    PasswordReset,
    SignedOutEverywhere,
    DeviceSignedOut,
    PasskeyAdded,
    PasskeyRemoved,
    RecoveryCodesReplaced,
    GoogleUnlinked,
    AccountDeleted,
    InviteSent,

    /// <summary>An invite or "Send again" refused: inviter's email unconfirmed, the daily allowance used, or too soon.</summary>
    InviteRefused,

    /// <summary>An invite accepted: a new login made with its own password, or an existing login joining.</summary>
    InviteAccepted,

    /// <summary>A Google identity linked to an existing account at sign-in (which may remove its password).</summary>
    GoogleLinked,

    RoleChanged,
    AccessRemoved,

    /// <summary>A request turned away by a rate limit.</summary>
    RateLimited,
}

/// <summary>
/// Writes security events at Warning, under their own category, so they survive production's
/// Warning floor in the event log (audit A09-001: before this, failed sign-ins, lockouts and a
/// stolen refresh token left no trace). Each line names the event, the login's id and the visitor's
/// address; never an email address or a credential (the masking logger factory would hide an
/// address anyway). Warning, not Error, so none of these trigger an error-alert email.
/// </summary>
public sealed class SecurityEvents
{
    public const string Category = "AllotJar.Security";

    /// <summary>At most one rate-limit line in this long, so a flood can't flood the log too.</summary>
    public static readonly TimeSpan RateLimitedLogInterval = TimeSpan.FromSeconds(10);

    private readonly ILogger _logger;
    private readonly IHttpContextAccessor _http;
    private readonly TimeProvider _clock;
    private long _refusedSinceLastLine;
    private long _nextRateLimitedLineTimestamp;

    public SecurityEvents(ILoggerFactory loggers, IHttpContextAccessor http, TimeProvider? clock = null)
    {
        _logger = loggers.CreateLogger(Category);
        _http = http;
        _clock = clock ?? TimeProvider.System;
    }

    /// <summary>
    /// A request turned away by a rate limit. Logged at most once every
    /// <see cref="RateLimitedLogInterval"/>, naming the address that tripped it and how many were
    /// turned away since the last line. Two counters, no per-address state, so memory stays flat.
    /// </summary>
    public void WriteRateLimited()
    {
        var refused = Interlocked.Increment(ref _refusedSinceLastLine);
        // The monotonic timestamp, not the wall clock, so a clock stepped backwards can't silence the line.
        var now = _clock.GetTimestamp();
        var due = Interlocked.Read(ref _nextRateLimitedLineTimestamp);
        var interval = (long)(RateLimitedLogInterval.TotalSeconds * _clock.TimestampFrequency);
        if ((due != 0 && now < due)
            || Interlocked.CompareExchange(ref _nextRateLimitedLineTimestamp, now + interval, due) != due)
        {
            return;
        }
        Interlocked.Add(ref _refusedSinceLastLine, -refused);
        // The count covers every address; the address on the line is only the request that wrote it.
        Write(SecurityEvent.RateLimited, null, $"{refused} turned away from all addresses since the last line");
    }

    /// <param name="userId">The login's id, when it is known; never its email.</param>
    /// <param name="detail">A short fixed phrase or an id (a membership, a role); never free text a visitor typed.</param>
    public void Write(SecurityEvent securityEvent, string? userId, string? detail = null)
    {
        var context = _http.HttpContext;
        var address = context?.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        // The route's pattern, not the visitor's decoded path: no visitor text (or control
        // characters) reaches the log through it.
        var path = context is null
            ? "-"
            : (context.GetEndpoint() as Microsoft.AspNetCore.Routing.RouteEndpoint)?.RoutePattern.RawText ?? "(no route)";
        _logger.LogWarning(
            "Security event {SecurityEvent} for login {UserId} from {ClientAddress} on {Path}{Detail}",
            securityEvent, userId ?? "unknown", address, path, detail is null ? "" : $" ({detail})");
    }
}
