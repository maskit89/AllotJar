namespace AllotJar.Domain.Enums;

/// <summary>
/// The kind of real-world account money sits in. Purely descriptive — it doesn't
/// change how a balance is computed (balance is always opening + Σ income − Σ expense
/// of the assigned transactions); it just lets the UI label and group accounts.
/// </summary>
public enum AccountType
{
    Current = 0,
    Savings = 1,
    Cash = 2,
    CreditCard = 3,
    Other = 4
}
