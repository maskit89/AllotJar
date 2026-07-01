using AllotJar.Domain.Enums;

namespace AllotJar.Api.Services;

/// <summary>
/// Per-request holder for the caller's resolved household + role. Populated once by
/// <see cref="Middleware.HouseholdResolutionMiddleware"/> and read back by
/// <see cref="CurrentUser"/>. Registered scoped so each request gets its own instance.
/// </summary>
public class HouseholdContext
{
    public string? OwnerId { get; set; }
    public HouseholdRole? Role { get; set; }
    public Guid? MemberId { get; set; }

    /// <summary>True once the middleware has run the membership lookup for this request.</summary>
    public bool Resolved { get; set; }
}
