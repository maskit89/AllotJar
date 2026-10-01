using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Middleware;

/// <summary>
/// Marks the few signed-in endpoints a login may still use while it has to replace a password
/// someone else chose: reading who it is, agreeing to the terms, changing the password, signing out.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AllowWhilePasswordChangePendingAttribute : Attribute;

/// <summary>
/// S-P2-3 / P59: a login created by an owner's direct invite starts with a password the owner
/// knows. Until it chooses its own, every signed-in endpoint other than those marked
/// <see cref="AllowWhilePasswordChangePendingAttribute"/> answers 403, so neither the new member
/// nor an owner signed in as them can read or change anything. The flag is read per request, like
/// the household, so changing the password takes effect at once; the change also rotates the
/// security stamp, which ends any session opened with the temporary password.
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
                title = "Choose your own password first: this login's password was set by someone else.",
                code = Code,
            });
            return;
        }

        await _next(context);
    }
}
