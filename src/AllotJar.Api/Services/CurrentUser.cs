using System.Security.Claims;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Services;

/// <summary>
/// Reads the authenticated login's id from the JWT claims, and the resolved household +
/// role from the per-request <see cref="HouseholdContext"/> (populated by
/// <see cref="Middleware.HouseholdResolutionMiddleware"/>). Registered scoped.
/// </summary>
public class CurrentUser : ICurrentUser
{
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly HouseholdContext _household;

    public CurrentUser(IHttpContextAccessor httpContextAccessor, HouseholdContext household)
    {
        _httpContextAccessor = httpContextAccessor;
        _household = household;
    }

    public string? UserId =>
        _httpContextAccessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);

    // Fall back to the caller's own id when no membership has been resolved, so a brand-new
    // login (or a request that bypassed the middleware) still owns its own household.
    public string? OwnerId => _household.OwnerId ?? UserId;

    public HouseholdRole? Role => _household.Resolved ? _household.Role : null;

    public Guid? MemberId => _household.MemberId;
}
