using FluentAssertions;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Pins the production CSP that the front IIS site serves (deploy/web/web.config). The header is
/// deploy infrastructure, not compiled code, so nothing else in the suites would catch a directive
/// being dropped — and both the auth map and the deploy runbook tell operators NOT to strip the
/// Google Identity Services allowances. A regression there silently breaks the "Sign in with
/// Google" button (blocked script/iframe) with no failing test.
/// </summary>
public class ContentSecurityPolicyTests
{
    private static string WebConfig()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "deploy", "web", "web.config");
            if (File.Exists(candidate))
            {
                return File.ReadAllText(candidate);
            }
            dir = dir.Parent;
        }

        throw new FileNotFoundException("Could not locate deploy/web/web.config by walking up from the test output.");
    }

    [Fact]
    public void Csp_allows_google_identity_services_for_sign_in_with_google()
    {
        var config = WebConfig();

        // The single Content-Security-Policy header line must carry every GIS allowance Google's
        // guidance requires; without any one of them the button or its FedCM iframe is blocked.
        var cspLine = config
            .Split('\n')
            .Single(l => l.Contains("Content-Security-Policy") && l.Contains("value="));

        cspLine.Should().Contain("script-src")
            .And.Contain("https://accounts.google.com/gsi/client");
        cspLine.Should().Contain("frame-src https://accounts.google.com/gsi/");
        cspLine.Should().Contain("connect-src")
            .And.Contain("https://accounts.google.com/gsi/");
        cspLine.Should().Contain("style-src")
            .And.Contain("https://accounts.google.com/gsi/style");
    }

    [Fact]
    public void Csp_keeps_its_baseline_hardening()
    {
        // Guard against a careless edit loosening the policy while adding the Google allowances.
        var cspLine = WebConfig()
            .Split('\n')
            .Single(l => l.Contains("Content-Security-Policy") && l.Contains("value="));

        cspLine.Should().Contain("default-src 'self'")
            .And.Contain("object-src 'none'")
            .And.Contain("frame-ancestors 'none'")
            .And.NotContain("unsafe-eval");
    }
}
