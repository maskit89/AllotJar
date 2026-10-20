using AllotJar.Infrastructure.Email;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Which site a passkey belongs to and which pages may use it, both taken from the configured site
/// (<see cref="EmailSettings.AppBaseUrl"/>), never from the request: behind IIS the API is reached
/// over plain http on 127.0.0.1, so the request names neither the scheme nor the host the browser
/// saw. A passkey made on staging never answers for production, and one answered from another page
/// never counts. Identity's own default trusts the request's Origin header, which a script outside
/// a browser sets to anything.
/// </summary>
public static class PasskeyOrigins
{
    /// <summary>
    /// The passkey's site (WebAuthn RP ID): the configured host without a leading "www.", so a
    /// passkey made on www.allotjar.com also works on allotjar.com, which serves the same app.
    /// </summary>
    public static string ServerDomain(EmailSettings settings)
    {
        var host = SiteUrl(settings).Host;
        return host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? host[4..] : host;
    }

    /// <summary>The pages that may use a passkey: the configured origin, and its bare domain when it is a www site.</summary>
    public static IReadOnlyList<string> AllowedOrigins(EmailSettings settings)
    {
        var site = SiteUrl(settings);
        var origin = site.GetLeftPart(UriPartial.Authority);
        var domain = ServerDomain(settings);
        return string.Equals(domain, site.Host, StringComparison.OrdinalIgnoreCase)
            ? [origin]
            : [origin, new UriBuilder(site) { Host = domain }.Uri.GetLeftPart(UriPartial.Authority)];
    }

    public static ValueTask<bool> Validate(PasskeyOriginValidationContext context)
    {
        if (context.CrossOrigin || !Uri.TryCreate(context.Origin, UriKind.Absolute, out var origin))
        {
            return ValueTask.FromResult(false);
        }

        var services = context.HttpContext.RequestServices;
        var settings = services.GetRequiredService<IOptions<EmailSettings>>().Value;
        var given = origin.GetLeftPart(UriPartial.Authority);
        if (AllowedOrigins(settings).Any(o => string.Equals(o, given, StringComparison.OrdinalIgnoreCase)))
        {
            return ValueTask.FromResult(true);
        }

        // Development: Vite serves the page on a port of its own (5173, or 4173 for the journeys)
        // and proxies /api, so only the host has to match.
        var development = services.GetRequiredService<IHostEnvironment>().IsDevelopment();
        return ValueTask.FromResult(development && string.Equals(origin.Host, SiteUrl(settings).Host, StringComparison.OrdinalIgnoreCase));
    }

    private static Uri SiteUrl(EmailSettings settings) =>
        Uri.TryCreate(settings.AppBaseUrl?.Trim(), UriKind.Absolute, out var url)
            ? url
            : new Uri(EmailSettings.ProductionOrigin);
}
