using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi;
using AllotJar.Api.Features;
using AllotJar.Api.Middleware;
using AllotJar.Api.Services;
using AllotJar.Application;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure;
using AllotJar.Infrastructure.Alerts;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Logging;
using AllotJar.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

const string SpaCorsPolicy = "SpaCors";
const string AuthRateLimitPolicy = "auth";
const string RefreshRateLimitPolicy = "auth-refresh";

// --- Layer composition ------------------------------------------------------
builder.Services.AddApplication();
builder.Services.AddInfrastructure(builder.Configuration);

// Error alerts: with ErrorAlerts:Recipient set, every Error-level log entry (an unhandled exception
// answered as a 500, a rejected email send, a startup step that failed and let the API go on) is
// emailed there through the outbound email provider, batched per incident and capped per hour. The
// Event Log on the VPS records the same entries, but nobody reads it unprompted; this is what tells
// Christopher something broke. Off (nothing registered) when no recipient is configured.
builder.Services.AddErrorAlerts(builder.Configuration);

// Email addresses are masked in every log line (c***@example.com), whoever writes it: our own
// lines, a provider's rejection text, a SQL error quoting a duplicate key. The Event Log, the
// console and the error alert emails then never hold a user's address.
builder.Services.MaskEmailAddressesInLogs();

// HTTP-context-backed implementation of the Application's ICurrentUser. The per-request
// HouseholdContext is populated by HouseholdResolutionMiddleware and read back by CurrentUser.
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<HouseholdContext>();
builder.Services.AddScoped<ICurrentUser, CurrentUser>();
builder.Services.AddSingleton<AccountEmails>();
builder.Services.AddSingleton<ResendCooldown>();

builder.Services.AddControllers();
builder.Services.AddAuthorization();

// Liveness probe (no DB dependency) consumed by the deploy pipeline's smoke test, plus a readiness
// check tagged "ready" that asks SQL Server whether it answers, for the health ping task below.

builder.Services.AddHealthChecks()
    .AddCheck<DatabaseHealthCheck>("database", tags: [DatabaseHealthCheck.Tag]);

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
// to blunt credential-stuffing and password-guessing floods. This is the coarse, per-visitor layer;
// the precise, IP-independent defence is the per-account Identity lockout in CheckCredentialsAsync.
// In production the API sits behind Cloudflare and the IIS/ARR reverse proxy, so the visitor's
// address comes from X-Forwarded-For, read only through those trusted proxies (ClientAddress).
// The per-visitor cap. Configurable so a serial end-to-end test run (many register/login/refresh
// calls from one IP inside a minute) can raise it via RateLimiting__AuthPermitLimit without
// weakening the production default of 20.
var authPermitLimit = builder.Configuration.GetValue("RateLimiting:AuthPermitLimit", 20);
// Silent refresh has its own, larger bucket, so a burst of sign-in attempts from a visitor never
// ends the sessions already open there (the SPA renews every few minutes per tab).
var refreshPermitLimit = builder.Configuration.GetValue("RateLimiting:RefreshPermitLimit", authPermitLimit * 3);
builder.Services.Configure<ForwardedHeadersOptions>(options => ClientAddress.Configure(options, builder.Configuration));
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(AuthRateLimitPolicy, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ClientAddress.PartitionKey(httpContext),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = authPermitLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
    // "Download my data" reads the whole household: a few a minute per visitor is plenty.
    options.AddPolicy("export", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ClientAddress.PartitionKey(httpContext),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
    // A statement preview reads the whole file (a PDF takes up to a second); each column
    // change on the review sends it again. A few a second is far more than a person makes.
    options.AddPolicy("import", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ClientAddress.PartitionKey(httpContext),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
    options.AddPolicy(RefreshRateLimitPolicy, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ClientAddress.PartitionKey(httpContext),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = refreshPermitLimit,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
});

// --- Swagger with JWT bearer support ----------------------------------------
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo { Title = "AllotJar API", Version = "v1" });

    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Name = "Authorization",
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        In = ParameterLocation.Header,
        Description = "Paste the JWT returned by /api/auth/login (no 'Bearer ' prefix needed)."
    });
    options.AddSecurityRequirement(document => new OpenApiSecurityRequirement
    {
        [new OpenApiSecuritySchemeReference("Bearer", document)] = []
    });
});

var app = builder.Build();

// --- HTTP pipeline ----------------------------------------------------------
// First, so everything after it (the rate limiter in particular) sees the visitor's address.
app.UseForwardedHeaders();
app.UseMiddleware<ExceptionHandlingMiddleware>();
// Answers 503 while SQL Server keeps the startup migrations waiting.
app.UseMiddleware<DatabaseStartupGateMiddleware>();

// Apply any pending EF Core migrations on startup so the configured SQL Server
// schema is always current — in Development against LocalDB, and in Production
// against the SQL Server service on the VPS right after a deploy. Migrations are
// additive and idempotent: they never drop existing data. If SQL Server still doesn't
// answer after the first retries, the API starts anyway with its gate closed and keeps
// retrying in the background, rather than failing to start.
if (await ApplyMigrationsAsync(app))
{
    await RunStartupBackfillsAsync(app);
}
else
{
    var gate = app.Services.GetRequiredService<DatabaseStartupGate>();
    gate.Close();
    _ = FinishDatabaseStartupAsync(app, gate);
}

// Repair pre-#142 starter budgets whose "Savings" group defaulted to Expense (idempotent).

// State plainly, once, which outbound-email provider actually resolved. Without this, "is email
// live?" is only answerable by triggering a reset and waiting to see if one arrives — and a
// misconfigured provider silently degrades to log-only (see AddInfrastructure).
LogEmailProvider(app);

// Likewise for error alerts: say where they go, or that they are off, and fire the test alert when
// asked (ErrorAlerts:TestOnStartup), so the whole path is checked from the inbox after a config change.
LogErrorAlerts(app);

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
// [EnableRateLimiting("auth")] or ("auth-refresh") policy are limited; everything else is unaffected.
app.UseRateLimiter();

app.UseAuthentication();
app.UseAuthorization();

// A login whose password someone else chose can do nothing else until it picks its own (S-P2-3).
app.UseMiddleware<PasswordChangeGateMiddleware>();

// After authentication, resolve which household (and at what role) the caller belongs to.
app.UseMiddleware<HouseholdResolutionMiddleware>();

app.MapControllers();

// Liveness endpoint: returns 200 once the app is up. The deploy script polls
// http://localhost:5000/health to verify a new build before completing. No checks run here on
// purpose: a database that is down must not read as a failed deploy of a build that started fine.
app.MapHealthChecks("/health", new HealthCheckOptions { Predicate = _ => false });

// Readiness: 200 only while the database answers too. deploy/Ping-Health.ps1 asks this one, so
// SQL Server being down while the API is up reaches the health check's email (review P3-3).
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains(DatabaseHealthCheck.Tag),
});

app.Run();

// Applies any pending EF Core migrations on startup. Retries for DatabaseStartupGate.ForegroundBudget
// so the API doesn't fail to boot while the SQL Server service is still coming up (e.g. right
// after a VPS reboot). Migrations are additive and never drop existing data.
// Returns false when every attempt failed; the caller then finishes in the background.
static async Task<bool> ApplyMigrationsAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();

    // Bounded by time, not by count: each failed attempt can take a whole Connect Timeout, and IIS
    // gives up on a start that runs past its startupTimeLimit (see ForegroundBudget).
    var elapsed = System.Diagnostics.Stopwatch.StartNew();
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            await db.Database.MigrateAsync();
            logger.LogInformation("Database migrations applied (attempt {Attempt}).", attempt);
            return true;
        }
        catch (Exception ex) when (elapsed.Elapsed + TimeSpan.FromSeconds(3) < DatabaseStartupGate.ForegroundBudget)
        {
            logger.LogWarning(ex,
                "Migration attempt {Attempt} failed; SQL Server may still be starting. Retrying in 3s...",
                attempt);
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
        catch (Exception ex)
        {
            // An Error, so it reaches the error alert email. Each failed background attempt also makes
            // EF log a connection Error, so the alert repeats (within its cooldown) until the database answers.
            logger.LogError(ex,
                "Migrations failed {Attempts} time(s) in {Seconds:0}s at startup. The API starts anyway and " +
                "answers 503 until the database answers; it keeps retrying in the background.",
                attempt, elapsed.Elapsed.TotalSeconds);
            return false;
        }
    }
}

// Retries the startup migrations until they apply (or the API stops), then runs the backfills and
// opens the gate. Waits DatabaseStartupGate.RetryInterval between attempts, then SlowRetryInterval
// after SlowAfter. Logs a Warning every 20 failed attempts so the event log shows it is still
// waiting, and a Warning once it opens.
static async Task FinishDatabaseStartupAsync(WebApplication app, DatabaseStartupGate gate)
{
    var stopping = app.Lifetime.ApplicationStopping;
    var logger = app.Services.GetRequiredService<ILogger<Program>>();
    var waiting = System.Diagnostics.Stopwatch.StartNew();
    for (var attempt = 1; ; attempt++)
    {
        try
        {
            var wait = waiting.Elapsed < DatabaseStartupGate.SlowAfter
                ? DatabaseStartupGate.RetryInterval
                : DatabaseStartupGate.SlowRetryInterval;
            await Task.Delay(wait, stopping);
            using (var scope = app.Services.CreateScope())
            {
                await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().Database.MigrateAsync(stopping);
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            return;
        }
        catch (Exception ex)
        {
            if (attempt % 20 == 0)
            {
                logger.LogWarning(ex, "Migrations still failing after {Attempts} background attempt(s); the API keeps answering 503.", attempt);
            }
            continue;
        }

        // Every backfill is non-fatal on the normal path, so the API serves whatever happens here too.
        try
        {
            await RunStartupBackfillsAsync(app);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Startup backfills failed after the background migrations; the API serves anyway.");
        }
        finally
        {
            gate.Open();
        }
        logger.LogWarning("Migrations applied after {Attempts} background attempt(s); the API now serves requests.", attempt);
        return;
    }
}

// The startup work that needs the migrated schema, in order. Each step is non-fatal.
static async Task RunStartupBackfillsAsync(WebApplication app)
{
    // Ensure every existing login owns an Owner membership for their household (idempotent).
    await BackfillMembershipsAsync(app);

    // Ensure every household has the owner as member #1, so a household is never "0 members".
    await BackfillOwnerMembersAsync(app);

    // Settles jar moves made before departures were recorded (P3-8).
    await BackfillJarDeparturesAsync(app);

    // Reports card numbers stored before every save masked them (compliance fix 12); changes nothing.
    await CheckCardNumbersAsync(app);
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

// Reports the rows that hold a card number saved before fix 12, by id, never the text. Read-only
// and non-fatal. Logged at Warning (see LogEmailProvider) so the Event Log shows it; silent when
// there is none.
static async Task CheckCardNumbersAsync(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        foreach (var (table, ids) in await CardNumberCheck.FindAsync(db))
        {
            logger.LogWarning(
                "Card-number check: {Count} row(s) in {Table} hold what looks like a card number, saved before masking: {Ids}.",
                ids.Count, table, string.Join(", ", ids));
        }
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Card-number check failed; nothing was changed. Continuing startup.");
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

        // Where the links inside those emails open. An Error (not a Warning) when it is the other
        // site's origin: that email is sent to a real person and its link does not work, and the
        // Error level is what reaches the error alerts. Staging's file must set it explicitly,
        // since the built-in default is the production origin.
        var mismatch = settings.DescribeEnvironmentMismatch(app.Environment.EnvironmentName);
        if (mismatch is not null)
        {
            logger.LogError("Links in emails open the wrong site: {Problem}", mismatch);
        }
        else
        {
            logger.LogWarning("Links in emails open {AppBaseUrl}.", settings.AppBaseUrl);
        }
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "Could not resolve the outbound email provider; continuing startup.");
    }
}

// Reports where error alerts go. Warning for the same reason as LogEmailProvider: on the production
// host it is the only level that reaches the Event Log. "Off" is a Warning outside Development only,
// since a laptop or the test host is not expected to email anyone.
static void LogErrorAlerts(WebApplication app)
{
    using var scope = app.Services.CreateScope();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    var settings = scope.ServiceProvider.GetRequiredService<IOptions<ErrorAlertSettings>>().Value;
    if (!settings.Enabled)
    {
        if (!app.Environment.IsDevelopment())
        {
            logger.LogWarning("Error alerts are OFF: set ErrorAlerts:Recipient to be emailed about errors.");
        }
        return;
    }

    var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
    if (sender is LoggingEmailSender)
    {
        logger.LogWarning(
            "Error alerts are configured for {Recipient} but outbound email is not, so they are only logged.",
            settings.Recipient);
    }
    else
    {
        logger.LogWarning(
            "Error alerts: emailing {Recipient} about Error-level log entries ({Environment}; one email per distinct error every {Cooldown} min, at most {Max} an hour).",
            settings.Recipient, app.Environment.EnvironmentName, settings.CooldownMinutes, settings.MaxEmailsPerHour);
    }

    if (settings.TestOnStartup)
    {
        // Deliberately an Error: it must travel the same path a real one does.
        logger.LogError(
            "Error alerts test: this email means alerts from {Environment} reach {Recipient}. Remove ErrorAlerts:TestOnStartup now, or every start sends one.",
            app.Environment.EnvironmentName, settings.Recipient);
    }
}

// Exposed so the integration/unit test host can reference the entry point if needed.
public partial class Program { }
