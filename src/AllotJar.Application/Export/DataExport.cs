using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Household.Dtos;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Export;

/// <summary>The signed-in login's own details, as Account settings shows them.</summary>
public record ExportProfile(
    string Email,
    string? FirstName,
    string? LastName,
    string? DisplayName,
    bool EmailConfirmed,
    DateTime? ConsentedUtc,
    bool HasPassword,
    bool GoogleConnected,
    string PreferredCurrency,
    string NumberFormat,
    string Household,
    string Role);

/// <summary>
/// One export: the app's own read models (so every redaction the screens apply applies here too),
/// plus the stored details no screen lists in full — a transaction's notes and raw bank text, every
/// closed jar cycle and every jar movement.
/// </summary>
public class DataExport
{
    public DateTime ExportedUtc { get; set; }
    public ExportProfile Profile { get; set; } = null!;
    public IReadOnlyList<AccountDto> Accounts { get; set; } = [];
    public IReadOnlyList<HouseholdMemberDto> People { get; set; } = [];
    public IReadOnlyList<MembershipDto> HouseholdAccess { get; set; } = [];
    public IReadOnlyList<ExportedTransaction> Transactions { get; set; } = [];
    public IReadOnlyList<BudgetMonthDto> Budgets { get; set; } = [];
    public IReadOnlyList<JarDto> Jars { get; set; } = [];
    public IReadOnlyList<ExportedJarCycle> JarCycles { get; set; } = [];
    public IReadOnlyList<ExportedJarMovement> JarMovements { get; set; } = [];
    public AllocationProfileDto? AllocationProfile { get; set; }
}

/// <summary>
/// A transaction as the Transactions page reads it, with its notes and the bank's own text for the
/// row. Those two are left out (null) when the money sits in a private account the viewer can't see.
/// </summary>
public class ExportedTransaction : TransactionDto
{
    public string? Notes { get; set; }
    public string? BankEntry { get; set; }
}

/// <summary>A jar's closed (or waiting) cycle: its deadline, target and how it ended.</summary>
public class ExportedJarCycle : JarCycleDto
{
    public Guid JarId { get; set; }
    public string JarName { get; set; } = string.Empty;
}

/// <summary>One jar's share of a movement of money in a jar-backed account (rules 78–82).</summary>
public class ExportedJarMovement
{
    public Guid Id { get; set; }
    public DateOnly Date { get; set; }
    public string Kind { get; set; } = string.Empty;
    public Guid AccountId { get; set; }
    public string AccountName { get; set; } = string.Empty;
    public Guid? JarId { get; set; }
    public string? JarName { get; set; }
    public decimal Amount { get; set; }
    public Guid? TransactionId { get; set; }
    public string? Note { get; set; }
}
