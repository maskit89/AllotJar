using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Sends via the Resend REST API (https://resend.com/docs/api-reference/emails/send-email).
/// Resend has no official .NET SDK; the API is a single JSON POST, so a typed HttpClient keeps
/// this dependency-free. Registered only when Email:ApiKey is configured.
/// </summary>
public class ResendEmailSender : IEmailSender
{
    private readonly HttpClient _http;
    private readonly EmailSettings _settings;
    private readonly ILogger<ResendEmailSender> _logger;

    public ResendEmailSender(HttpClient http, IOptions<EmailSettings> settings, ILogger<ResendEmailSender> logger)
    {
        _http = http;
        _settings = settings.Value;
        _logger = logger;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        using var response = await _http.PostAsJsonAsync("emails", new
        {
            from = _settings.FromAddress,
            to = new[] { message.ToEmail },
            subject = message.Subject,
            text = message.TextBody,
            html = message.HtmlBody,
        }, ct);

        if (!response.IsSuccessStatusCode)
        {
            // The body carries Resend's error name/message (never the recipient's mail content).
            var detail = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError("Resend rejected an email ({Status}): {Detail}", (int)response.StatusCode, detail);
            throw new HttpRequestException($"Resend send failed with status {(int)response.StatusCode}.");
        }
    }
}
