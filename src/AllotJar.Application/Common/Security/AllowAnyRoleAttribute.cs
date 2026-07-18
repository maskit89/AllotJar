namespace AllotJar.Application.Common.Security;

/// <summary>
/// Exempts a command from the <see cref="AllotJar.Domain.Enums.HouseholdRole"/> gate entirely:
/// authorization is carried by something other than the caller's role in their current household
/// (e.g. an invite token). Use sparingly — without this marker, commands require Admin or above.
/// </summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class AllowAnyRoleAttribute : Attribute;
