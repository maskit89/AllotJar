using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace AllotJar.Api.Services;

/// <summary>
/// Recovers the visitor's own address for the sign-in rate limit (S-P2-4). In production a request
/// reaches the API through two proxies: Cloudflare, then IIS/ARR on the same machine, which
/// forwards to Kestrel on loopback. Without this every request looks like it came from 127.0.0.1,
/// so the "per visitor" limit is one bucket for the whole site and one anonymous client sending
/// 20 sign-ins a minute locks everybody out.
///
/// Both proxies append to <c>X-Forwarded-For</c>: Cloudflare adds the visitor, ARR adds the
/// address that connected to IIS. The header is read from the right and only through proxies we
/// trust: loopback (ARR) first, then a Cloudflare address. Anything further left was written by
/// the client and is never believed. A request that reaches IIS directly, not via Cloudflare, is
/// keyed on its own address, because that address is not a trusted proxy.
/// </summary>
public static class ClientAddress
{
    /// <summary>
    /// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). Override with
    /// <c>ForwardedHeaders:TrustedProxyNetworks</c> if they change before this list does.
    /// </summary>
    public static readonly string[] CloudflareNetworks =
    {
        "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
        "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
        "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
        "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
        "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
        "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
    };

    public static void Configure(ForwardedHeadersOptions options, IConfiguration configuration)
    {
        // Only the client address: the scheme and host stay as Kestrel sees them, so nothing else
        // about the request changes.
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor;

        // ARR on loopback, then Cloudflare: at most two hops are ours.
        options.ForwardLimit = 2;

        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
        options.KnownProxies.Add(IPAddress.Loopback);
        options.KnownProxies.Add(IPAddress.IPv6Loopback);

        var networks = configuration.GetSection("ForwardedHeaders:TrustedProxyNetworks").Get<string[]>();
        foreach (var network in networks is { Length: > 0 } ? networks : CloudflareNetworks)
        {
            options.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
        }
    }

    /// <summary>The rate-limit partition for a request: the visitor's address once the proxies are unwound.</summary>
    public static string PartitionKey(HttpContext context) =>
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
