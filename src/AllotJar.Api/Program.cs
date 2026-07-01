using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.OpenApi.Models;
using AllotJar.Api.Features;
using AllotJar.Api.Middleware;
using AllotJar.Api.Services;
using AllotJar.Application;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure;
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
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(AuthRateLimitPolicy, httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 20,
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

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
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

// Exposed so the integration/unit test host can reference the entry point if needed.
public partial class Program { }
