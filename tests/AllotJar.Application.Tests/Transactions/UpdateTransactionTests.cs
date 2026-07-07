using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

public class UpdateTransactionTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    private static Transaction Seed(ApplicationDbContext db, string ownerId)
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            Date = new DateOnly(2026, 6, 1),
            Payee = "Tesco",
            Amount = 20m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    [Fact]
    public async Task Update_ChangesTheCoreFields()
    {
        await using var db = NewContext();
        var tx = Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 6, 9), "Aldi", 31.50m, TransactionType.Expense),
            CancellationToken.None);

        dto.Payee.Should().Be("Aldi");
        dto.Amount.Should().Be(31.50m);
        dto.Date.Should().Be(new DateOnly(2026, 6, 9));
    }

    [Fact]
    public async Task Update_Throws_WhenUserDoesNotOwnTheTransaction()
    {
        await using var db = NewContext();
        var tx = Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 6, 9), "x", 1m, TransactionType.Expense),
                CancellationToken.None));
    }

    [Fact]
    public async Task Update_Throws_WhenNotFound()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(Guid.NewGuid(), new DateOnly(2026, 6, 9), "x", 1m, TransactionType.Expense),
                CancellationToken.None));
    }

    [Fact]
    public void Validator_RejectsNonPositiveAmount()
    {
        var validator = new UpdateTransactionCommandValidator();
        validator
            .Validate(new UpdateTransactionCommand(Guid.NewGuid(), new DateOnly(2026, 6, 1), "x", 0m, TransactionType.Expense))
            .IsValid.Should().BeFalse();
    }
}
