using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Infrastructure;

/// <summary>
/// Composition root for the Infrastructure layer: persistence (EF Core + SQL Server),
/// ASP.NET Core Identity, JWT bearer authentication and the token generator.
/// </summary>
public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        // --- Persistence -------------------------------------------------------
        var connectionString = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("Connection string 'DefaultConnection' is not configured.");

        services.AddDbContext<ApplicationDbContext>(options =>
            options.UseSqlServer(connectionString,
                sql => sql.MigrationsAssembly(typeof(ApplicationDbContext).Assembly.FullName)));

        // Expose the context to the Application layer through its abstraction.
        services.AddScoped<IApplicationDbContext>(sp => sp.GetRequiredService<ApplicationDbContext>());

        // Statement import format adapters. The handler resolves them all and selects by
        // StatementFormat, so each new bank format is just another registration here.
        services.AddScoped<IStatementParser, Camt053StatementParser>();
        services.AddScoped<IStatementParser, HsbcCsvStatementParser>();

        // FX rates via the free, key-less Frankfurter (ECB) API.
        services.AddHttpClient<IExchangeRateProvider, FrankfurterExchangeRateProvider>(client =>
        {
            client.BaseAddress = new Uri("https://api.frankfurter.app/");
            client.Timeout = TimeSpan.FromSeconds(5);
        });

        // Have I Been Pwned "Pwned Passwords" range API for the breached-password check
        // (k-anonymity; see BreachedPasswordValidator). A short timeout keeps register/change-password
        // snappy, and the validator fails open if this call doesn't come back.
        services.AddHttpClient(BreachedPasswordValidator.HttpClientName, client =>
        {
            client.BaseAddress = new Uri("https://api.pwnedpasswords.com/");
            client.Timeout = TimeSpan.FromSeconds(5);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("AllotJar-Security/1.0");
        });

        // --- Identity ----------------------------------------------------------
        services
            .AddIdentityCore<ApplicationUser>(options =>
            {
                options.User.RequireUniqueEmail = true;
                options.Password.RequiredLength = 8;
                options.Password.RequireNonAlphanumeric = false;

                // Brute-force protection: lock a login for 15 minutes after 5 consecutive failures.
                // Enforced in IdentityService.CheckCredentialsAsync via the UserManager lockout APIs.
                options.Lockout.MaxFailedAccessAttempts = 5;
                options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                options.Lockout.AllowedForNewUsers = true;
            })
            .AddEntityFrameworkStores<ApplicationDbContext>()
            .AddDefaultTokenProviders()
            // Screen new passwords against the Have I Been Pwned breach corpus.
            .AddPasswordValidator<BreachedPasswordValidator>();

        // Application-facing wrapper over UserManager (create logins, change passwords).
        services.AddScoped<IIdentityService, IdentityService>();

        // Refresh tokens backing the HttpOnly-cookie session (issue / rotate / revoke).
        services.AddScoped<IRefreshTokenService, RefreshTokenService>();

        // --- JWT authentication ------------------------------------------------
        var jwtSection = configuration.GetSection(JwtSettings.SectionName);
        services.Configure<JwtSettings>(jwtSection);
        var jwt = jwtSection.Get<JwtSettings>()
            ?? throw new InvalidOperationException("Missing 'Jwt' configuration section.");

        // Fail fast on a missing/weak signing key. The key is intentionally NOT
        // committed — supply it via user-secrets or the Jwt__Key environment variable.
        // HS256 needs a key of at least 256 bits (32 bytes).
        if (string.IsNullOrWhiteSpace(jwt.Key) || Encoding.UTF8.GetByteCount(jwt.Key) < 32)
        {
            throw new InvalidOperationException(
                "Jwt:Key is not configured or is shorter than 32 bytes. Set it with " +
                "`dotnet user-secrets set \"Jwt:Key\" \"<a long random secret>\" " +
                "--project src/AllotJar.Api` or the Jwt__Key environment variable.");
        }

        services.AddScoped<IJwtTokenGenerator, JwtTokenGenerator>();

        services
            .AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
            })
            .AddJwtBearer(options =>
            {
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidateAudience = true,
                    ValidateLifetime = true,
                    ValidateIssuerSigningKey = true,
                    ValidIssuer = jwt.Issuer,
                    ValidAudience = jwt.Audience,
                    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Key)),
                    // Pin the accepted signing algorithm so a token can only be HS256 — defence in
                    // depth against algorithm-substitution attacks.
                    ValidAlgorithms = new[] { SecurityAlgorithms.HmacSha256 },
                    ClockSkew = TimeSpan.FromSeconds(30)
                };

                // Make the otherwise-stateless JWT revocable: every authenticated request re-checks
                // the token's security-stamp claim against the user's current stamp. Rotating the
                // stamp (on password change, or a future sign-out-everywhere) invalidates all tokens
                // issued before it. Tokens minted before this shipped carry no stamp claim and stay
                // valid until they expire, so existing sessions aren't dropped on rollout.
                options.Events = new JwtBearerEvents
                {
                    OnTokenValidated = async context =>
                    {
                        var tokenStamp = context.Principal?.FindFirstValue(JwtTokenGenerator.SecurityStampClaimType);
                        if (string.IsNullOrEmpty(tokenStamp))
                        {
                            return; // legacy token — nothing to compare
                        }

                        var userId = context.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
                        if (string.IsNullOrEmpty(userId))
                        {
                            context.Fail("Token has no subject.");
                            return;
                        }

                        try
                        {
                            var db = context.HttpContext.RequestServices
                                .GetRequiredService<ApplicationDbContext>();
                            var currentStamp = await db.Users
                                .Where(u => u.Id == userId)
                                .Select(u => u.SecurityStamp)
                                .FirstOrDefaultAsync(context.HttpContext.RequestAborted);

                            if (!SecurityStampValidation.IsValid(tokenStamp, currentStamp))
                            {
                                context.Fail("This session has been revoked.");
                            }
                        }
                        catch (Exception)
                        {
                            // Fail OPEN on a transient datastore error — a DB blip must not log
                            // every signed-in user out. Only a definite stamp mismatch revokes.
                        }
                    }
                };
            });

        return services;
    }
}
