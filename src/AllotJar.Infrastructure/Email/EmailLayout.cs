namespace AllotJar.Infrastructure.Email;

/// <summary>
/// Shared chrome for outbound transactional email (password resets today; billing/dunning later).
/// Every design rule here is load-bearing for real mail clients — change with care:
/// <list type="bullet">
/// <item>Inline CSS on every element and table-based layout: Gmail strips &lt;style&gt; in some
/// contexts and classic Outlook ignores most modern CSS. The one &lt;style&gt; block is purely a
/// progressive enhancement (dark-mode overrides).</item>
/// <item>HTML5 doctype and NO xmlns attribute: the XHTML variants carry a w3.org URL, and the
/// security tests pin that the reset link is the ONLY "http" substring in the markup (the
/// anti-tracker tripwire from the PR #188 review). The same pin is why the footer shows a
/// schemeless <c>allotjar.com</c> instead of an anchor.</item>
/// <item>No images at all — remote images are blocked-by-default open trackers, SVG is stripped
/// by Gmail/Outlook, data: URIs die in Gmail and classic Outlook, and the prod provider
/// (Cloudflare Email Service) has no CID-attachment support. The brand is carried by the text
/// wordmark and the gold "jar lid" bar instead.</item>
/// <item>No webfonts: unavailable in the major clients and an external request besides. The
/// Arial/Helvetica stack is the accepted email-only deviation from the Hanken Grotesk wordmark
/// spec in brand/README.md §4-5.</item>
/// <item>Colors survive Gmail's forced dark-mode inversion: ink-on-paper flips cleanly and the
/// white-on-green button stays ≥4.5:1 either way. Explicit dark overrides ride the
/// prefers-color-scheme block for clients that honor it (Apple Mail, Outlook mobile).</item>
/// </list>
/// Callers pass PRE-ENCODED dynamic values (WebUtility.HtmlEncode), matching PasswordResetEmail's
/// existing convention.
/// </summary>
public static class EmailLayout
{
    // Brand tokens — brand/README.md §3/§6 and client/src/index.css. §6 blesses #1F6B4D (the app's
    // brand-600) as the light-mode accent, so email matches the product UI rather than the
    // standalone-asset green #1C6B49.
    public const string Green = "#1F6B4D";
    public const string GreenDark = "#5FC093";
    public const string Gold = "#D7A93E";
    public const string GoldDark = "#E8C36A";
    public const string Ink = "#15201B";
    public const string Paper = "#F4F6F3";
    public const string Muted = "#475569";
    public const string FooterText = "#64748B";
    public const string Border = "#E2E8F0";
    public const string CardDark = "#111714";

    private const string Font = "font-family:Arial,Helvetica,sans-serif";

    /// <summary>
    /// Wraps <paramref name="bodyHtml"/> in the branded document: paper background, gold lid bar,
    /// AllotJar text wordmark, white card, and a muted footer explaining why the recipient got the
    /// email. <paramref name="preheader"/> is the hidden inbox-snippet line; keep it under ~90
    /// chars. All dynamic content inside the slots must already be HTML-encoded by the caller.
    /// </summary>
    public static string Wrap(string title, string preheader, string bodyHtml, string footerReasonHtml)
    {
        return
            "<!DOCTYPE html>" +
            "<html lang=\"en\">" +
            "<head>" +
            "<meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<meta name=\"color-scheme\" content=\"light dark\">" +
            "<meta name=\"supported-color-schemes\" content=\"light dark\">" +
            $"<title>{title}</title>" +
            "<style>" +
            "@media (prefers-color-scheme: dark) {" +
            $" body, .aj-page {{ background: {Ink} !important; }}" +
            $" .aj-card {{ background: {CardDark} !important; border-color: #2b3a32 !important; }}" +
            " .aj-ink { color: #F1F5F9 !important; }" +
            " .aj-muted { color: #94A3B8 !important; }" +
            $" .aj-jar {{ color: {GreenDark} !important; }}" +
            $" .aj-lid {{ background: {GoldDark} !important; }}" +
            "}" +
            "</style>" +
            "</head>" +
            $"<body style=\"margin:0;padding:0;background:{Paper}\" bgcolor=\"{Paper}\" class=\"aj-page\">" +
            // Hidden preheader: shows as the inbox snippet, never in the opened email. The
            // figure-space/zero-width padding stops later body text bleeding into the snippet.
            "<div style=\"display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all\">" +
            preheader + string.Concat(Enumerable.Repeat("&#8199;&#847;", 24)) +
            "</div>" +
            "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">" +
            "<tr><td align=\"center\" style=\"padding:32px 16px\">" +
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"560\" style=\"width:100%;max-width:560px\">" +
            // Gold "jar lid" bar — the brand's second color, no image needed.
            $"<tr><td height=\"5\" bgcolor=\"{Gold}\" class=\"aj-lid\" style=\"height:5px;line-height:5px;font-size:0;border-radius:12px 12px 0 0\">&nbsp;</td></tr>" +
            // Card: wordmark + body slot.
            $"<tr><td bgcolor=\"#FFFFFF\" class=\"aj-card\" style=\"background:#FFFFFF;border:1px solid {Border};border-top:0;border-radius:0 0 12px 12px;padding:28px 32px 32px\">" +
            $"<div style=\"{Font};font-size:24px;font-weight:800;letter-spacing:-0.5px;color:{Ink};margin:0 0 20px\" class=\"aj-ink\">" +
            $"Allot<span style=\"color:{Green}\" class=\"aj-jar\">Jar</span>" +
            "</div>" +
            bodyHtml +
            "</td></tr>" +
            // Footer: outside the card, on the paper background. Schemeless domain by design (see
            // the class doc) — mail clients auto-link it visually anyway.
            "<tr><td style=\"padding:20px 8px 0\">" +
            $"<p style=\"{Font};font-size:12px;line-height:18px;color:{FooterText};margin:0\" class=\"aj-muted\">{footerReasonHtml}</p>" +
            $"<p style=\"{Font};font-size:12px;line-height:18px;color:{FooterText};margin:8px 0 0\" class=\"aj-muted\">AllotJar &middot; Every euro has a job. &middot; allotjar.com</p>" +
            "</td></tr>" +
            "</table>" +
            "</td></tr></table>" +
            "</body></html>";
    }

    /// <summary>
    /// The bulletproof padded-cell button. Renders as a solid green rectangle in classic Outlook
    /// (only the corner radius is lost — accepted; no VML on purpose, its markup doubles the href).
    /// <paramref name="encodedHref"/> must already be HTML-encoded.
    /// </summary>
    public static string Button(string encodedHref, string label)
    {
        return
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:24px auto\">" +
            $"<tr><td bgcolor=\"{Green}\" style=\"border-radius:8px\">" +
            $"<a href=\"{encodedHref}\" style=\"display:inline-block;padding:13px 28px;{Font};font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px\">{label}</a>" +
            "</td></tr></table>";
    }
}
