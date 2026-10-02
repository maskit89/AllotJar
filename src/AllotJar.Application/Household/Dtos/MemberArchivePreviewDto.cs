namespace AllotJar.Application.Household.Dtos;

/// <summary>What archiving a person does to their pocket money (rule 54), read before the People page archives them.</summary>
public class MemberArchivePreviewDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public bool IsArchived { get; set; }

    /// <summary>
    /// The current month's pocket-money lines, when the person has any: while <see cref="PocketMoneyMonthDto.Remaining"/>
    /// is above zero the archive needs the keep-or-cancel decision. Null when there is nothing this month.
    /// </summary>
    public PocketMoneyMonthDto? ThisMonth { get; set; }

    /// <summary>Later months that already hold a pocket-money line for the person; archiving cancels them.</summary>
    public List<PocketMoneyMonthDto> FutureMonths { get; set; } = new();
}

/// <summary>One month's pocket money for a person: planned, paid so far and what remains planned.</summary>
public class PocketMoneyMonthDto
{
    public int Year { get; set; }
    public int Month { get; set; }
    public decimal Planned { get; set; }
    public decimal Paid { get; set; }
    public decimal Remaining { get; set; }

    /// <summary>A payment this month still waits for its converted amount: a cancel keeps that line's plan until the amount is confirmed (D13).</summary>
    public bool WaitingForConvertedAmount { get; set; }
}
