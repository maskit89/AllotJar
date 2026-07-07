namespace AllotJar.Application.Common.Security;

/// <summary>
/// Marks a command as household administration (managing members, roles and access), so only
/// the <see cref="Domain.Enums.HouseholdRole.Owner"/> may run it — not even an Admin.
/// </summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class OwnerOnlyAttribute : Attribute;
