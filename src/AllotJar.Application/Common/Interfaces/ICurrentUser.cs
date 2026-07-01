using AllotJar.Domain.Enums;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Identity and household context of the current request. Implemented in the API layer:
/// <see cref="UserId"/> comes from the JWT, while <see cref="OwnerId"/>/<see cref="Role"/>
/// are resolved from the caller's household membership. Application handlers scope every
/// query/command to <see cref="OwnerId"/> (the household), not the individual caller, so
/// that several logins can share one budget.
/// </summary>
public interface ICurrentUser
{
    /// <summary>The authenticated login's id, or null if the request is anonymous.</summary>
    string? UserId { get; }

    /// <summary>
    /// The household partition key the caller belongs to — the creator's id. This is the
    /// value all budget data is stamped/filtered by. Defaults to <see cref="UserId"/> so
    /// that a caller with no explicit membership owns their own household (and so the unit
    /// test stubs, which only set <see cref="UserId"/>, keep behaving as a single owner).
    /// </summary>
    string? OwnerId => UserId;

    /// <summary>The caller's access level in their household. Defaults to full <see cref="HouseholdRole.Owner"/>.</summary>
    HouseholdRole? Role => HouseholdRole.Owner;

    /// <summary>The budget-attribution member this login is linked to, if any.</summary>
    Guid? MemberId => null;
}
