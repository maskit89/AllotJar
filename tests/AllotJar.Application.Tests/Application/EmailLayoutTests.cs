using AllotJar.Infrastructure.Email;
using FluentAssertions;
using Xunit;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Pins the shared email chrome so a future consumer (billing/dunning) can't reintroduce
/// trackers, external assets, or Gmail-clipping bloat through the layout itself.
/// </summary>
public class EmailLayoutTests
{
    private const string SampleHref = "https://www.allotjar.com/reset-password?email=a%40b.com&amp;token=x";

    private static string Sample() => EmailLayout.Wrap(
        title: "Test title",
        preheader: "Preview line for the inbox.",
        bodyHtml: "<p>Hello body</p>" + EmailLayout.Button(SampleHref, "Do the thing"),
        footerReasonHtml: "You're receiving this because of a test.");

    [Fact]
    public void Wrap_emits_one_html5_document_with_every_slot_rendered()
    {
        var html = Sample();

        // Exactly one HTML5 doctype, and never the XHTML flavor (its w3.org URL is an http token).
        html.Split("<!DOCTYPE html>").Length.Should().Be(2);
        html.Should().NotContain("xmlns");

        html.Should().Contain("<title>Test title</title>");
        html.Should().Contain("Preview line for the inbox.");
        html.Should().Contain("Hello body");
        html.Should().Contain("You're receiving this because of a test.");

        // The brand chrome: wordmark halves and the schemeless footer domain.
        html.Should().Contain("Allot").And.Contain(">Jar<");
        html.Should().Contain("allotjar.com");

        // Layout tables are decorative for screen readers.
        html.Should().Contain("role=\"presentation\"");
    }

    [Fact]
    public void Wrap_contains_no_external_url_outside_the_callers_link()
    {
        var html = Sample();

        html.Replace(SampleHref, string.Empty).Should().NotContain("http",
            "the caller's link must be the ONLY external URL — no doctype/xmlns URLs, images, fonts or trackers");
        html.Should().NotContain("<img");
        html.Should().NotContain("<link");
        html.Should().NotContain("@import");
        html.Should().NotContain("url(");
    }

    [Fact]
    public void Button_renders_the_href_once_with_the_label()
    {
        var button = EmailLayout.Button(SampleHref, "Do the thing");

        button.Split(SampleHref).Length.Should().Be(2, "no VML/duplicate hrefs — link extraction must stay unambiguous");
        button.Should().Contain(">Do the thing</a>");
    }

    [Fact]
    public void Wrap_stays_far_under_the_gmail_clipping_threshold()
    {
        // Gmail clips messages over ~102KB; the chrome must leave plenty of room for real bodies.
        Sample().Length.Should().BeLessThan(60_000);
    }
}
