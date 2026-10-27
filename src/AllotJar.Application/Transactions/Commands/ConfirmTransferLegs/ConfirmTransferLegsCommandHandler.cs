using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;

public class ConfirmTransferLegsCommandHandler : IRequestHandler<ConfirmTransferLegsCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ConfirmTransferLegsCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(ConfirmTransferLegsCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transfer = await _db.Transactions
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken)
            ?? throw new NotFoundException($"Transaction {request.TransactionId} was not found.");

        if (transfer.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        // Re-sending a confirmed receipt date with a jar division rewrites only the receipt's jar
        // postings: written back too, the transfer's version moves, so a transfer form loaded
        // before this is refused rather than putting its old division back (D11, #308 review P2-1).
        _db.TouchVersion(transfer);
        if (transfer.Type != TransactionType.Transfer)
        {
            throw Validation("TransactionId", "Only a transfer has bank legs to confirm.");
        }
        if (transfer.ReturnedOn is not null && request.ReceivedOn.HasValue)
        {
            throw Validation(nameof(request.ReceivedOn), "This transfer was sent back to its source account, so it has no receipt to confirm.");
        }

        // Resolve every leg into locals first: nothing is written to the tracked row until the
        // whole request is known to be acceptable, so a refused confirmation changes nothing.
        var errors = new Dictionary<string, string[]>();
        var departedOn = ConfirmDate(errors, nameof(request.DepartedOn), request.DepartedOn, transfer.DepartedOn, "departure");
        var receivedOn = ConfirmDate(errors, nameof(request.ReceivedOn), request.ReceivedOn, transfer.ReceivedOn, "receipt");
        var bankReference = ConfirmReference(
            errors, nameof(request.BankReference), request.BankReference, transfer.BankReference, "source statement reference");
        var receiptBankReference = ConfirmReference(
            errors, nameof(request.ReceiptBankReference), request.ReceiptBankReference, transfer.ReceiptBankReference,
            "destination statement reference");
        if (errors.Count > 0)
        {
            throw new ValidationException(errors);
        }

        // A receipt confirmed earlier than the confirmed departure is a typo far more often
        // than a value-dated credit; statement dates arrive through the import path instead.
        if (departedOn is DateOnly d && receivedOn is DateOnly r && r < d
            && (request.DepartedOn.HasValue || request.ReceivedOn.HasValue))
        {
            throw Validation(request.ReceivedOn.HasValue ? nameof(request.ReceivedOn) : nameof(request.DepartedOn),
                "The receipt date can't be before the departure date.");
        }

        var receiptPosted = transfer.TransferAccountId is Guid destination && JarMovements.PostsOn(transfer, destination) is not null;
        var departureNowKnown = transfer.DepartedOn is null && departedOn is not null;
        var receiptNowKnown = transfer.ReceivedOn is null && receivedOn is not null;

        transfer.DepartedOn = departedOn;
        transfer.ReceivedOn = receivedOn;
        transfer.BankReference = bankReference;
        transfer.ReceiptBankReference = receiptBankReference;
        if (receiptBankReference is not null)
        {
            transfer.ReceiptKnownBySourceReference = false;
        }

        // Keep the register's display date on the confirmed departure once it is known, so a
        // resolved receipt-first row sorts by the date the money actually left.
        if (departedOn is DateOnly departed)
        {
            transfer.Date = departed;
        }

        // A departure supplied now posts the debit (rule 72): the source must stay at or above
        // zero on every date (rule 74). Confirming a receipt only adds money, but it answers the
        // destination's jars, so both sides are locked (P11, JL-P2-6).
        var sides = new[] { transfer.AccountId, transfer.TransferAccountId }.OfType<Guid>().ToList();
        await using var write = sides.Count == 0 ? null : await _db.BeginLedgerWriteAsync(sides, cancellationToken);
        // A departure now posting its draw on a Recurring jar replants that jar (JarDrawReplants).
        var jarsBefore = await JarDrawReplants.BeforeAsync(_db, userId, new[] { transfer.Id }, cancellationToken);
        if (departureNowKnown && transfer.Account is not null)
        {
            await AccountBalanceGuard.EnsureNonNegativeAsync(
                _db, new[] { transfer.Account }, new[] { transfer }, Array.Empty<Guid>(), nameof(request.DepartedOn), cancellationToken);
            if (request.FromJarId is Guid fromJarId)
            {
                await JarMovements.ApplyOutgoingAsync(_db, userId, transfer, transfer.Account, fromJarId, nameof(request.FromJarId), cancellationToken);
                await JarHistoryChecks.EnsureTransferDrawAsync(_db, userId, transfer, transfer.Account, fromJarId, nameof(request.FromJarId), cancellationToken);
            }
        }
        if (request.JarAllocations is not null && transfer.TransferAccount is not null && receivedOn is DateOnly receivedDate)
        {
            if (!receiptNowKnown && !request.ReceivedOn.HasValue)
            {
                throw Validation(nameof(request.JarAllocations), "Confirm the receipt date to divide the money among jars.");
            }
            await JarMovements.ApplyIncomingAsync(
                _db, userId, transfer, transfer.TransferAccount, receivedDate, transfer.Amount, request.JarAllocations,
                nameof(request.JarAllocations), cancellationToken, postsNow: !receiptPosted);
        }
        else if (!receiptPosted && transfer.TransferAccountId is Guid to && JarMovements.PostsOn(transfer, to) is DateOnly posts)
        {
            // The answer given while the money was in transit, kept (the command's doc).
            await JarMovements.FollowReceiptAsync(_db, transfer, to, posts, cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);
        await JarDrawReplants.ReplantAsync(_db, userId, jarsBefore, new[] { transfer.Id }, cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
        return await TransactionReads.ReadDtoAsync(_db, transfer.Id, cancellationToken);
    }

    /// <summary>
    /// Fill-only semantics: a null request leaves the leg alone; a value equal to what is already
    /// confirmed is a harmless repeat; a different value against a confirmed leg is refused.
    /// Returns the leg's resulting value.
    /// </summary>
    private static DateOnly? ConfirmDate(
        Dictionary<string, string[]> errors, string key, DateOnly? requested, DateOnly? existing, string label)
    {
        if (requested is not DateOnly date) return existing;
        if (existing is not DateOnly confirmed) return date;
        if (confirmed != date)
        {
            errors[key] = new[] { AlreadyConfirmed(label, confirmed.ToString("yyyy-MM-dd")) };
        }
        return confirmed;
    }

    private static string? ConfirmReference(
        Dictionary<string, string[]> errors, string key, string? requested, string? existing, string label)
    {
        var reference = string.IsNullOrWhiteSpace(requested) ? null : requested.Trim();
        if (reference is null) return existing;
        if (existing is null) return reference;
        if (!string.Equals(existing, reference, StringComparison.OrdinalIgnoreCase))
        {
            errors[key] = new[] { AlreadyConfirmed(label, existing) };
        }
        return existing;
    }

    private static string AlreadyConfirmed(string label, string value) =>
        $"The {label} is already confirmed as {value}. To correct it, edit the transfer.";

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
