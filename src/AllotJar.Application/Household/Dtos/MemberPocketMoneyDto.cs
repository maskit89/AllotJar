namespace AllotJar.Application.Household.Dtos;

/// <summary>
/// A person's pocket-money line in the calendar current month (rule 54): what is planned, what
/// has been paid out so far and what remains. Absent when the month has no line for them.
/// </summary>
public record MemberPocketMoneyDto(decimal Planned, decimal Paid, decimal Remaining);
