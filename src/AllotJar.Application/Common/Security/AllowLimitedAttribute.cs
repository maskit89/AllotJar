namespace AllotJar.Application.Common.Security;

/// <summary>
/// Marks a command as part of day-to-day data entry, so a <see cref="Domain.Enums.HouseholdRole.Limited"/>
/// login is allowed to run it. Without this marker, commands require Admin or above.
/// </summary>
[AttributeUsage(AttributeTargets.Class)]
public sealed class AllowLimitedAttribute : Attribute;
