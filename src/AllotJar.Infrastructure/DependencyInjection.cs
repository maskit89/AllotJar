using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Retention;
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

        // Generic bank-CSV import (user-confirmed column mapping) — see ICsvImporter.
        services.AddScoped<ICsvImporter, GenericCsvImporter>();

        // Reference rates for SUGGESTED conversions only (rule 44), via the free, key-less
        // Frankfurter (ECB) API. Nothing applies a rate without the user confirming the amount.
        // The provider takes a TimeProvider so its failure-cache expiry is testable.
        services.TryAddSingleton(TimeProvider.System);
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

        // --- Outbound email ----------------------------------------------------
        // Resend when an API key is configured; otherwise a logging fallback + in-memory sink so
        // development, CI and the test harnesses run without credentials (and journey tests can
        // read the "sent" reset link back via the Development-only /api/dev/emails endpoint).
        var emailSection = configuration.GetSection(EmailSettings.SectionName);
        services.Configure<EmailSettings>(emailSection);
        services.AddSingleton<DevEmailSink>();
        var emailSettings = emailSection.Get<EmailSettings>() ?? new EmailSettings();
        // Provider is a CONFIG choice so a provider swap (or a fall back off a beta service) is a
        // server-side setting change, not a code change + redeploy. Blank defaults to Resend so
        // pre-existing key-only configurations keep working unchanged.
        var provider = emailSettings.ResolvedProvider;
        var hasKey = !string.IsNullOrWhiteSpace(emailSettings.ApiKey);
        // Cloudflare's send endpoint is account-scoped, so a key alone isn't a usable config.
        var cloudflareReady = hasKey && !string.IsNullOrWhiteSpace(emailSettings.AccountId);

        if (hasKey && provider == EmailSettings.ProviderCloudflare && cloudflareReady)
        {
            services.AddHttpClient<IEmailSender, CloudflareEmailSender>(client =>
            {
                client.BaseAddress = new Uri("https://api.cloudflare.com/");
                client.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", emailSettings.ApiKey);
                client.Timeout = TimeSpan.FromSeconds(10);
            });
        }
        else if (hasKey && provider == EmailSettings.ProviderResend)
        {
            services.AddHttpClient<IEmailSender, ResendEmailSender>(client =>
            {
                client.BaseAddress = new Uri("https://api.resend.com/");
                client.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", emailSettings.ApiKey);
                client.Timeout = TimeSpan.FromSeconds(10);
            });
        }
        else
        {
            // No key, an unknown provider name, or Cloudflare without an AccountId. Deliberately
            // NOT fatal: a bad email config must not take the whole API down (unlike Jwt:Key, the
            // app is fully usable without it) — password reset degrades instead, and both this
            // registration and every attempted send log loudly. Program.cs reports the resolved
            // provider at startup so "is email actually live?" is answerable from the log.
            services.AddSingleton<IEmailSender, LoggingEmailSender>();
        }

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

        // Password-reset links die after 2 hours (default is a whole day). This lifespan applies to
        // every DataProtector-based Identity token; only reset tokens are issued today.
        services.Configure<DataProtectionTokenProviderOptions>(options =>
            options.TokenLifespan = TimeSpan.FromHours(PasswordResetEmail.LinkLifetimeHours));

        // Application-facing wrapper over UserManager (create logins, change passwords).
        services.AddScoped<IIdentityService, IdentityService>();
        services.AddScoped<AccountDeletion>();

        // --- Passkeys (two-factor sign-in, compliance fix 14) -------------------
        // A passkey must be discoverable (so "Sign in with a passkey" needs no email) and must check
        // the person (fingerprint, face or device PIN), which is what lets it count as two factors.
        // The site comes from Email:AppBaseUrl, not the request (see PasskeyOrigins).
        services.AddOptions<IdentityPasskeyOptions>().Configure<IOptions<EmailSettings>>((options, email) =>
        {
            options.ServerDomain = PasskeyOrigins.ServerDomain(email.Value);
            options.ResidentKeyRequirement = "required";
            options.UserVerificationRequirement = "required";
            options.AttestationConveyancePreference = "none";
            options.AuthenticatorTimeout = PasskeyCeremonies.Lifetime;
            options.ValidateOrigin = PasskeyOrigins.Validate;
        });
        services.AddScoped<IPasskeyHandler<ApplicationUser>, PasskeyHandler<ApplicationUser>>();
        services.AddSingleton<PasskeyCeremonies>();
        services.AddScoped<RecoveryCodes>();

        // Refresh tokens backing the HttpOnly-cookie session (issue / rotate / revoke).
        services.AddScoped<IRefreshTokenService, RefreshTokenService>();

        // Compliance fix 9: delete expired sign-in tokens and long-expired invitations once a day,
        // so the privacy policy's retention periods hold for logins that never come back.
        services.AddScoped<ExpiredRecordsPurge>();
        services.AddHostedService<ExpiredRecordsPurgeService>();

        // --- Google sign-in ----------------------------------------------------
        // ID-token validation for POST /auth/google. The fake is DOUBLE-gated: the config flag AND
        // a Development host — so the journey/integration harnesses can drive the flow without
        // Google credentials, while production can never be pointed at the fake via config alone.
        services.Configure<GoogleAuthSettings>(configuration.GetSection(GoogleAuthSettings.SectionName));
        var googleSettings = configuration.GetSection(GoogleAuthSettings.SectionName).Get<GoogleAuthSettings>()
            ?? new GoogleAuthSettings();
        if (googleSettings.UseFakeValidator)
        {
            services.AddScoped<IGoogleIdTokenValidator>(sp =>
                sp.GetRequiredService<IHostEnvironment>().IsDevelopment()
                    ? ActivatorUtilities.CreateInstance<FakeGoogleIdTokenValidator>(sp)
                    : ActivatorUtilities.CreateInstance<GoogleIdTokenValidator>(sp));
        }
        else
        {
            services.AddScoped<IGoogleIdTokenValidator, GoogleIdTokenValidator>();
        }

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
