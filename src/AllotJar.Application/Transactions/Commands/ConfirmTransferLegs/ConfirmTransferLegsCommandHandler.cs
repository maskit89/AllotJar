using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
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
        if (transfer.Type != TransactionType.Transfer)
        {
            throw Validation("TransactionId", "Only a transfer has bank legs to confirm.");
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

        transfer.DepartedOn = departedOn;
        transfer.ReceivedOn = receivedOn;
        transfer.BankReference = bankReference;
        transfer.ReceiptBankReference = receiptBankReference;

        // Keep the register's display date on the confirmed departure once it is known, so a
        // resolved receipt-first row sorts by the date the money actually left.
        if (departedOn is DateOnly departed)
        {
            transfer.Date = departed;
        }

        await _db.SaveChangesAsync(cancellationToken);
        return transfer.ToDto();
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
        $"The {label} is already confirmed as {value}. Correcting a confirmed bank leg is not supported here; delete and re-record the transfer instead.";

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
