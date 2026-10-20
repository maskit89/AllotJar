using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Which pages may use a passkey: only the site the API itself answers on. The page and the API share
/// one origin (the SPA is served by the same host), so a passkey made on staging never answers for
/// production, and one answered from another page never counts. Identity's own default trusts the
/// request's Origin header, which a script outside a browser sets to anything.
/// </summary>
public static class PasskeyOrigins
{
    public static ValueTask<bool> Validate(PasskeyOriginValidationContext context)
    {
        if (context.CrossOrigin || !Uri.TryCreate(context.Origin, UriKind.Absolute, out var origin))
        {
            return ValueTask.FromResult(false);
        }

        var request = context.HttpContext.Request;
        if (string.Equals(origin.GetLeftPart(UriPartial.Authority), $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase))
        {
            return ValueTask.FromResult(true);
        }

        // Development: Vite serves the page on its own port and proxies /api, so only the host matches.
        var development = context.HttpContext.RequestServices.GetRequiredService<IHostEnvironment>().IsDevelopment();
        return ValueTask.FromResult(development && string.Equals(origin.Host, request.Host.Host, StringComparison.OrdinalIgnoreCase));
    }
}
