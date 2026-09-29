namespace AllotJar.Application.Jars.Dtos;

/// <summary>A payment offered as the one that fulfilled a Recurring jar's cycle (rule 83; GET /jars/{id}/payments).</summary>
public class JarPaymentDto
{
    public Guid Id { get; set; }
    public DateOnly Date { get; set; }
    public string Payee { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "EUR";
    public bool FxPending { get; set; }
    public Guid? AccountId { get; set; }
    public string? AccountName { get; set; }
    public string? BudgetItemName { get; set; }

    /// <summary>True when the payment drew from the jar (its Savings line, or paid from it) in the jar's own account (rule 79).</summary>
    public bool FromJar { get; set; }
}
