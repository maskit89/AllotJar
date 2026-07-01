namespace AllotJar.Domain.Enums;

/// <summary>
/// A login's access level within a household. The budget creator is the
/// <see cref="Owner"/>; additional logins are granted one of the lower tiers.
///   <see cref="Owner"/>    — full control, including managing members and access.
///   <see cref="Admin"/>    — every budgeting action, but cannot manage members/access.
///   <see cref="Limited"/>  — day-to-day entry only (transactions, mark-paid, allocate).
///   <see cref="ReadOnly"/> — view everything, change nothing.
/// </summary>
public enum HouseholdRole
{
    Owner = 0,
    Admin = 1,
    Limited = 2,
    ReadOnly = 3,
}
