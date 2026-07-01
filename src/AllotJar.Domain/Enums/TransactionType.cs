namespace AllotJar.Domain.Enums;

/// <summary>
/// Direction of money movement for a <see cref="Entities.Transaction"/>.
/// </summary>
public enum TransactionType
{
    Expense = 0,
    Income = 1,

    /// <summary>
    /// A movement between two of the user's own accounts: out of <see cref="Entities.Transaction.AccountId"/>
    /// and into <see cref="Entities.Transaction.TransferAccountId"/>. Net-zero to net worth, so it is excluded
    /// from budget actuals and never assigned to a budget line.
    /// </summary>
    Transfer = 2
}
