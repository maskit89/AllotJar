namespace AllotJar.Application.Common.Interfaces;

/// <summary>A transactional email ready to send (recipient + subject + both body flavours).</summary>
public sealed record EmailMessage(string ToEmail, string Subject, string TextBody, string HtmlBody);

/// <summary>
/// Outbound transactional email (password resets today; billing/dunning later). Implementations:
/// a real provider (Resend) when an API key is configured, otherwise a logging fallback so
/// development and CI never need credentials. Callers must treat sending as best-effort — a
/// provider outage is logged, never surfaced to the requester (see forgot-password's
/// no-enumeration contract).
/// </summary>
public interface IEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}
