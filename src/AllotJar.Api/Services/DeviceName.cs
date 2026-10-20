namespace AllotJar.Api.Services;

/// <summary>
/// Names the device a sign-in is made on, as "Safari on iPhone", for Account settings' list of
/// signed-in devices. Read from the browser's user agent, so it is a label, not proof: only the
/// browser family and the kind of device are kept, never the version or the full string. The
/// client sends <see cref="AppHeader"/> when it runs as the installed app.
/// </summary>
public static class DeviceName
{
    /// <summary>Request header the client sets to "1" when it runs installed (from the home screen).</summary>
    public const string AppHeader = "X-AllotJar-App";

    public static string? From(string? userAgent, bool installedApp)
    {
        if (string.IsNullOrWhiteSpace(userAgent))
        {
            return null;
        }

        var platform = Platform(userAgent);
        var browser = installedApp ? "AllotJar app" : Browser(userAgent);
        return (browser, platform) switch
        {
            (null, null) => null,
            (null, _) => platform,
            (_, null) => browser,
            _ => $"{browser} on {platform}",
        };
    }

    private static string? Platform(string ua)
    {
        // iPadOS reports itself as a Mac; the Mac has no touch, so "Mobile" tells the iPad apart.
        if (Has(ua, "iPhone")) return "iPhone";
        if (Has(ua, "iPad") || (Has(ua, "Macintosh") && Has(ua, "Mobile/"))) return "iPad";
        if (Has(ua, "Android")) return "Android";
        if (Has(ua, "Windows")) return "Windows";
        if (Has(ua, "Macintosh") || Has(ua, "Mac OS X")) return "Mac";
        if (Has(ua, "CrOS")) return "Chromebook";
        if (Has(ua, "Linux")) return "Linux";
        return null;
    }

    private static string? Browser(string ua)
    {
        // Order matters: Edge, Opera and Samsung say "Chrome" too, and Chrome says "Safari".
        if (Has(ua, "Edg/") || Has(ua, "EdgA/") || Has(ua, "EdgiOS/")) return "Edge";
        if (Has(ua, "OPR/") || Has(ua, "OPiOS/")) return "Opera";
        if (Has(ua, "SamsungBrowser/")) return "Samsung Internet";
        if (Has(ua, "Firefox/") || Has(ua, "FxiOS/")) return "Firefox";
        if (Has(ua, "Chrome/") || Has(ua, "CriOS/")) return "Chrome";
        if (Has(ua, "Safari/")) return "Safari";
        return null;
    }

    private static bool Has(string ua, string token) => ua.Contains(token, StringComparison.Ordinal);
}
