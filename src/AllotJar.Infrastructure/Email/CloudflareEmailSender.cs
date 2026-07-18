using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Sends via Cloudflare Email Service's REST API
/// (https://developers.cloudflare.com/email-service/get-started/send-emails/).
///
/// The Workers binding is the provider's headline API, but it only works from code running ON
/// Workers — this API is a .NET app behind IIS, so the REST endpoint is the applicable one. The
/// sending domain must be onboarded in Cloudflare Email Sending (MX/SPF/DKIM/DMARC) and the
/// account must use Cloudflare DNS. Registered only when Email:Provider is "cloudflare".
/// </summary>
public class CloudflareEmailSender : IEmailSender
{
    private readonly HttpClient _http;
    private readonly EmailSettings _settings;
    private readonly ILogger<CloudflareEmailSender> _logger;

    public CloudflareEmailSender(
        HttpClient http, IOptions<EmailSettings> settings, ILogger<CloudflareEmailSender> logger)
    {
        _http = http;
        _settings = settings.Value;
        _logger = logger;
    }

    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var path = $"client/v4/accounts/{_settings.AccountId}/email/sending/send";
        using var response = await _http.PostAsJsonAsync(path, new
        {
            to = message.ToEmail,
            from = _settings.FromAddress,
            subject = message.Subject,
            text = message.TextBody,
            html = message.HtmlBody,
        }, ct);

        // The body carries Cloudflare's error array (never the recipient's mail content).
        var body = await response.Content.ReadAsStringAsync(ct);

        // IMPORTANT: Cloudflare's client/v4 API can answer HTTP 200 with {"success": false, ...}.
        // Checking only the status code would silently swallow a rejected send, leaving the user
        // waiting for an email that was never accepted — so the envelope is checked too.
        if (!response.IsSuccessStatusCode || ReportsFailure(body))
        {
            _logger.LogError(
                "Cloudflare Email Service rejected an email ({Status}): {Detail}",
                (int)response.StatusCode, body);
            throw new HttpRequestException(
                $"Cloudflare Email Service send failed with status {(int)response.StatusCode}.");
        }
    }

    /// <summary>
    /// True when the response envelope explicitly reports failure. Defensive: a body that isn't
    /// JSON, or has no "success" field, is not treated as a failure — the status code already
    /// governs that case, and we must not turn a healthy send into a false alarm.
    /// </summary>
    private static bool ReportsFailure(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("success", out var success)
                && success.ValueKind == JsonValueKind.False;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
