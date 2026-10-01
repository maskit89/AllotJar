using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Middleware;

/// <summary>
/// Marks the signed-in endpoints a login may still use while it has to replace a password someone
/// else chose: only reading who it is. Signing out, refreshing and asking for the emailed link are
/// anonymous endpoints, and the terms wait until the login is its holder's alone (review P3-1 of #298).
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AllowWhilePasswordChangePendingAttribute : Attribute;

/// <summary>
/// S-P2-3 / P59: a login created by an owner's direct invite starts with a password the owner
/// knows. Until its holder chooses their own through the link emailed to its address, every
/// signed-in endpoint other than those marked <see cref="AllowWhilePasswordChangePendingAttribute"/>
/// answers 403, so neither the new member nor an owner signed in as them can read or change
/// anything. The flag is read per request, like the household, so the reset takes effect at once;
/// it also rotates the security stamp, which ends any session opened with the temporary password.
/// </summary>
public class PasswordChangeGateMiddleware
{
    public const string Code = "password_change_required";

    private readonly RequestDelegate _next;

    public PasswordChangeGateMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, ApplicationDbContext db)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        var endpoint = context.GetEndpoint();
        var gated = !string.IsNullOrEmpty(userId)
            && endpoint?.Metadata.GetMetadata<IAuthorizeData>() is not null
            && endpoint.Metadata.GetMetadata<IAllowAnonymous>() is null
            && endpoint.Metadata.GetMetadata<AllowWhilePasswordChangePendingAttribute>() is null;

        if (gated && await db.Users.AsNoTracking()
                .Where(u => u.Id == userId)
                .Select(u => u.MustChangePassword)
                .FirstOrDefaultAsync(context.RequestAborted))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new
            {
                status = StatusCodes.Status403Forbidden,
                title = "Choose your own password first, with the link emailed to this login's address: its password was set by someone else.",
                code = Code,
            });
            return;
        }

        await _next(context);
    }
}
