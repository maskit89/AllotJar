namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// A serialised write against one account's ledger: on SQL Server a transaction holding an
/// update lock on the account row, so two concurrent reallocations, initial allocations or
/// account-balance checks cannot both pass validation against the same money (rules 10/68/70).
/// Null on providers without transactions (the EF InMemory tests), where nothing runs concurrently.
/// </summary>
public interface ILedgerWrite : IAsyncDisposable
{
    Task CommitAsync(CancellationToken cancellationToken);
}
