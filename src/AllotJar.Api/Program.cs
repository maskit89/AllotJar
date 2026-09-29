using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi.Models;
using AllotJar.Api.Features;
using AllotJar.Api.Middleware;
using AllotJar.Api.Services;
using AllotJar.Application;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

const string SpaCorsPolicy = "SpaCors";
const string AuthRateLimitPolicy = "auth";

// --- Layer composition ------------------------------------------------------
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration);

// HTTP-context-backed implementation of the Application's ICurrentUser. The per-request
// HouseholdContext is populated by HouseholdResolutionMiddleware and read back by CurrentUser.
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<HouseholdContext>();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();

builder.Services.AddControllers();
builder.Services.AddAuthorization();

// Liveness probe (no DB dependency) consumed by the deploy pipeline's smoke test.
builder.Services.AddHealthChecks();

// Feature toggles for the features beyond core zero-based budgeting (all default ON).
builder.Services.Configure<FeatureFlags>(builder.Configuration.GetSection(FeatureFlags.SectionName));

// Password-reset tokens are protected with the DataProtection key ring. By default an IIS app
// pool without a loaded user profile keeps that ring IN MEMORY, so every recycle/deploy would
// invalidate any reset link already emailed. Pointing DataProtection:KeysPath at a persistent
// folder (outside the deploy dir — the deploy wipes it) keeps links valid across restarts.
var dataProtectionKeysPath = builder.Configuration["DataProtection:KeysPath"];
if (!string.IsNullOrWhiteSpace(dataProtectionKeysPath))
{
    var dataProtection = builder.Services.AddDataProtection()
        .PersistKeysToFileSystem(new DirectoryInfo(dataProtectionKeysPath));

    // Encrypt the key ring AT REST. The IIS app pool runs without a loaded user profile (the very
    // reason the keys can't stay in-memory), so CurrentUser DPAPI auto-encryption isn't available
    // and the keys would otherwise be written in PLAINTEXT — anyone who can read the folder or a
    // backup of it could forge reset tokens. LocalMachine DPAPI works with no user profile. It's
    // Windows-only, which is exactly where this path is ever set (the production VPS).
    if (OperatingSystem.IsWindows())
    {
        dataProtection.ProtectKeysWithDpapi(protectToLocalMachine: true);
    }
}

// CORS for the Vite dev server (configurable via Cors:AllowedOrigins).
var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>()
    ?? new[] { "http://localhost:5173" };
builder.Services.AddCors(options =>
    options.AddPolicy(SpaCorsPolicy, policy => policy
        .WithOrigins(allowedOrigins)
        .AllowAnyHeader()
        .AllowAnyMethod()));

// Rate limiting for the sensitive auth endpoints (login/register/accept-invite/change-password)
// to blunt credential-stuffing and password-guessing floods. This is the coarse, per-source layer;
// the precise, IP-independent defence is the per-account Identity lockout in CheckCredentialsAsync.
// NOTE: in production the API sits behind the IIS/ARR reverse proxy, so RemoteIpAddress is the
// proxy (loopback) and this effectively becomes a per-site cap until X-Forwarded-For handling is
// added. The limit is set high enough that real household use never trips it.
// The per-source cap. Configurable so a serial end-to-end test run (many register/login/refresh
// calls from one IP inside a minute) can raise it via RateLimiting__AuthPermitLimit without
// weakening the production default of 20.
var authPermitLimit = builder.Configuration.GetValue("RateLimiting:AuthPermitLimit", 20);
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(AuthRateLimitPolicy, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = authPermitLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
});

// --- Swagger with JWT bearer support ----------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo { Title = "AllotJar API", Version = "v1" });

    var scheme = new OpenApiSecurityScheme
    {
        Name = "Authorization",
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        In = ParameterLocation.Header,
        Description = "Paste the JWT returned by /api/auth/login (no 'Bearer ' prefix needed).",
        Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
    };
    options.AddSecurityDefinition("Bearer", scheme);
    options.AddSecurityRequirement(new OpenApiSecurityRequirement { [scheme] = Array.Empty<string>() });
});

var app = builder.Build();

// --- HTTP pipeline ----------------------------------------------------------
app.UseMiddleware<ExceptionHandlingMiddleware>();

// Apply any pending EF Core migrations on startup so the configured SQL Server
// schema is always current — in Development against LocalDB, and in Production
// against the SQL Server service on the VPS right after a deploy. Migrations are
// additive and idempotent: they never drop existing data.
await ApplyMigrationsAsync(app);

// Ensure every existing login owns an Owner membership for their household (idempotent).
await BackfillMembershipsAsync(app);

// Ensure every household has the owner as member #1, so a household is never "0 members".
await BackfillOwnerMembersAsync(app);

// Settles jar moves made before departures were recorded (P3-8).
await BackfillJarDeparturesAsync(app);

// Repair pre-#142 starter budgets whose "Savings" group defaulted to Expense (idempotent).

// State plainly, once, which outbound-email provider actually resolved. Without this, "is email
// live?" is only answerable by triggering a reset and waiting to see if one arrives — and a
// misconfigured provider silently degrades to log-only (see AddInfrastructure).
LogEmailProvider(app);

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();

    // Development-only mailbox: when no email provider is configured, LoggingEmailSender captures
    // outbound mail in DevEmailSink, and this endpoint lets the journey e2e suite read what a real
    // recipient would have received (e.g. the password-reset link). Never mapped outside
    // Development — production email goes through the real provider.
    // `to` is optional (empty list without it) so a query-less probe is a clean 200, not a
    // framework BadHttpRequestException that the exception middleware would surface as a 500.
    app.MapGet("/api/dev/emails", (string? to, DevEmailSink sink) =>
        string.IsNullOrEmpty(to) ? [] : sink.ForRecipient(to));
}

// NOTE: in Production, HTTPS is terminated at the IIS reverse proxy and the API is
// reached over plain HTTP on localhost. Forcing an HTTPS redirect here would break
// those proxied /api calls, so edge HTTPS (and the http->https redirect) is left to
// IIS. In Development the Vite proxy likewise talks to the API over http.

app.UseCors(SpaCorsPolicy);

// Throttle abusive bursts before they reach authentication. Only endpoints tagged with the
// [EnableRateLimiting("auth")] policy are limited; everything else is unaffected.
app.UseRateLimiter();

app.UseAuthentication();
app.UseAuthorization();

// After authentication, resolve which household (and at what role) the caller belongs to.
app.UseMiddleware<HouseholdResolutionMiddleware>();

app.MapControllers();

// Liveness endpoint: returns 200 once the app is up. The deploy script polls
// http://localhost:5000/health to verify a new build before completing.
app.MapHealthChecks("/health");

app.Run();

// Applies any pending EF Core migrations on startup. Retries briefly so the API
// doesn't fail to boot while the SQL Server service is still coming up (e.g. right
// after a VPS reboot). Migrations are additive and never drop existing data.
static async Task ApplyMigrationsAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    const int maxAttempts = 10;
    for (var attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            await db.Database.MigrateAsync();
            logger.LogInformation("Database migrations applied (attempt {Attempt}).", attempt);
            return;
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            logger.LogWarning(ex,
                "Migration attempt {Attempt}/{Max} failed; SQL Server may still be starting. Retrying in 3s...",
                attempt, maxAttempts);
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
    }
}

// Seeds an Owner membership for any existing login that lacks one, so pre-existing single-user
// budgets become an owner-headed household. Idempotent and non-fatal: a failure here must not
// stop the API from serving (the resolution middleware falls back to self-owned households).
static async Task BackfillMembershipsAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        await MembershipSeeder.BackfillOwnerMembershipsAsync(db);
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "Owner-membership backfill failed; continuing startup.");
    }
}

// Seeds an owner member (member #1) for any household that has none, naming it from the owner
// login. Idempotent and non-fatal: a household that already has members is untouched.
static async Task BackfillOwnerMembersAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        await OwnerMemberSeeder.BackfillOwnerMembersAsync(db);
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "Owner-member backfill failed; continuing startup.");
    }
}

// Records the departure a jar move made before #275 lacks, so a residue left in the old account
// no longer blocks the jar's archive (P3-8), and writes down the old account's line payments such
// a move left unrecorded (P2-B). Idempotent and non-fatal: a move with a departure is untouched.
// If the run fails, a legacy move is still settled on the next edit of a kept entry, but without
// that write-down. The counts are logged at Warning (see LogEmailProvider) so the deploy's check of
// the Event Log sees them.
static async Task BackfillJarDeparturesAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        var result = await AllotJar.Application.Jars.JarDepartures.BackfillAsync(db, CancellationToken.None);
        logger.LogWarning(
            "Jar-departure backfill: recorded {Departures} departure(s) and wrote down {Payments} line payment(s).",
            result.Departures, result.PaymentsWrittenDown);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Jar-departure backfill failed; nothing was saved. Continuing startup.");
    }
}

// Converts pre-#142 starter "Savings" groups that defaulted to Expense-kind into real, jar-backed
// savings envelopes. Idempotent and non-fatal: households already on the correct shape are untouched.

// Reports the resolved outbound-email provider at startup. LoggingEmailSender means NOTHING is
// actually delivered (no key, or an incomplete/unrecognised Email:Provider) — that's a warning in
// any environment where real email is expected.
static void LogEmailProvider(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
        var settings = scope.ServiceProvider.GetRequiredService<IOptions<EmailSettings>>().Value;

        if (sender is LoggingEmailSender)
        {
            // Name the ACTUAL problem — "set Email:ApiKey" is misleading advice for the two
            // configurations that already have one (typo'd provider / missing AccountId).
            logger.LogWarning(
                "Outbound email is NOT configured — messages will only be logged, never delivered: {Reason}.",
                settings.DescribeMisconfiguration() ?? "outbound email is not configured");
        }
        else
        {
            // Deliberately Warning, not Information: on the production host the Console provider
            // writes to ANCM stdout (disabled by default, and the deploy re-mirrors the folder), and
            // the EventLog provider filters below Warning — so an Information line has no reachable
            // sink and the runbook's "confirm from the log" step would be unfollowable. This is a
            // once-per-startup operational notice, not a problem.
            logger.LogWarning("Outbound email provider: {Provider}.", sender.GetType().Name);

            // A sender resolved, but the config may still be subtly wrong in a way that only shows
            // up as a failed send much later (e.g. a truncated Cloudflare account id). Say so now.
            var smell = settings.DescribeSuspiciousConfiguration();
            if (smell is not null)
            {
                logger.LogWarning("Outbound email configuration looks wrong: {Problem}", smell);
            }
        }
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "Could not resolve the outbound email provider; continuing startup.");
    }
}

// Exposed so the integration/unit test host can reference the entry point if needed.
public partial class Program { }
