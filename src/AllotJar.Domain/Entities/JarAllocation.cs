using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A persisted jar-ledger operation on one account: how money already in the account, or one
/// account leg of a recorded transaction, is attributed to that account's jars and unallocated
/// funds. The postings are actual money (rule 1), never a plan. A transaction-linked operation
/// (<see cref="TransactionId"/> set) sums to that leg's signed movement; the other kinds sum to
/// zero; a Departure operation is the zero-sum settlement of a jar's history in an account it
/// has left (P51). Read through the domain <c>ActualSavingsLedger</c>; the reader derives the attribution
/// of any movement that has no stored operation from its budget line (rule 79).
/// </summary>
public class JarAllocation : BaseEntity
{
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>The account whose ledger this operation belongs to.</summary>
    public Guid AccountId { get; set; }
    public Account? Account { get; set; }

    public JarAllocationKind Kind { get; set; }

    /// <summary>
    /// The posting date. For a transaction-linked operation the transaction's own posting date
    /// governs at read time; this column follows it and is kept for querying only.
    /// </summary>
    public DateOnly Date { get; set; }

    /// <summary>The transaction whose account leg this operation attributes; null for zero-sum operations.</summary>
    public Guid? TransactionId { get; set; }
    public Transaction? Transaction { get; set; }

    /// <summary>For a <see cref="JarAllocationKind.Return"/> operation: the returned transfer whose money it puts back.</summary>
    public Guid? ReturnOfTransferId { get; set; }

    /// <summary>An optional user note (e.g. why money was moved).</summary>
    [MaskCardNumbers]
    public string? Note { get; set; }

    public DateTime CreatedUtc { get; set; }

    public ICollection<JarAllocationPosting> Postings { get; set; } = new List<JarAllocationPosting>();
}

/// <summary>One signed line of a <see cref="JarAllocation"/>: a jar, or unallocated funds when <see cref="JarId"/> is null.</summary>
public class JarAllocationPosting : BaseEntity
{
    public Guid JarAllocationId { get; set; }
    public JarAllocation JarAllocation { get; set; } = null!;

    public Guid? JarId { get; set; }
    public Jar? Jar { get; set; }

    /// <summary>Signed amount in the account's currency; decimal(18,4).</summary>
    public decimal Amount { get; set; }
}
