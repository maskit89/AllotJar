using System.Net.Http.Json;
using System.Net.Mail;
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
        var payload = new Dictionary<string, object?>
        {
            ["to"] = message.ToEmail,
            ["from"] = BuildFrom(_settings.FromAddress),
            ["subject"] = message.Subject,
            ["text"] = message.TextBody,
            ["html"] = message.HtmlBody,
        };
        using var response = await _http.PostAsJsonAsync(path, payload, ct);

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
    /// Renders <c>FromAddress</c> in a shape Cloudflare's REST API accepts.
    ///
    /// **This is NOT interchangeable with Resend's.** Cloudflare types the field as either a BARE
    /// address string (<c>"no-reply@allotjar.com"</c>) or an object
    /// (<c>{ "address": "…", "name": "…" }</c>) — the RFC5322 display-name string
    /// <c>"AllotJar &lt;no-reply@allotjar.com&gt;"</c> that Resend accepts (and that the shared
    /// <see cref="EmailSettings.FromAddress"/> default uses) is rejected as an invalid request
    /// schema. Because sends are best-effort and dispatched off the request path, that rejection
    /// would be SILENT: the user still gets 204 and simply never receives a reset email. Hence the
    /// split here rather than posting the configured string verbatim.
    /// NOTE the REST key is <c>address</c>; the Workers binding uses <c>email</c> for the same idea.
    /// </summary>
    private static object BuildFrom(string fromAddress)
    {
        try
        {
            var parsed = new MailAddress(fromAddress);
            return string.IsNullOrWhiteSpace(parsed.DisplayName)
                ? parsed.Address
                : new { address = parsed.Address, name = parsed.DisplayName };
        }
        catch (FormatException)
        {
            // Unparseable: send it through and let the provider reject it with a logged error,
            // rather than throwing a different exception from inside the sender.
            return fromAddress;
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
