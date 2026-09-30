using FluentAssertions;
using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Extra coverage for the TRANSFERS area (catalog prefix TRF, docs/testing/cases/11-transfers.md)
/// at the Application/domain layer — the gaps left by <see cref="TransfersTests"/>:
/// the returned single-signed-row DTO shape, payee defaulting/trimming, the money-integrity
/// invariant (balances move, budget actuals + net worth do not, even when a transfer is
/// force-assigned to a line), delete/account-delete keeping both legs coherent, the handler
/// lookup order + ownership guard, and the amount/note/empty-id validator boundaries. All
/// behaviour here lives server-side; UI/client-only cases stay in the client suites.
/// </summary>
public class TTransfersCoverageTests
{
    private sealed class RoleStub(HouseholdRole? role) : ICurrentUser
    {
        public string? UserId => "u1";
        public string? OwnerId => "u1";
        public HouseholdRole? Role { get; } = role;
    }

    private static Account SeedAccount(
        ApplicationDbContext db, string ownerId, string name, decimal opening = 0m, string currency = "EUR")
    {
        var a = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = AccountType.Current,
            Currency = CurrencyCode.From(currency),
            OpeningBalance = opening,
            OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static Task<IReadOnlyList<Accounts.Dtos.AccountDto>> Accounts(ApplicationDbContext db, string userId) =>
        new GetAccountsQueryHandler(db, new CurrentUserStub(userId))
            .Handle(new GetAccountsQuery(), CancellationToken.None);

    // ── TRF-005 / TRF-023: the handler records ONE signed Type=Transfer row (not two legs)
    // and returns a DTO stamped source=AccountId, dest=TransferAccountId,
    // currency from the source, with the from→to account names — the data behind the
    // register's "{from} → {to}" cell. (TransfersTests only asserts the derived balances.)
    [Fact]
    public async Task Transfer_ReturnsASingleSignedTransferRow_WithSourceCurrencyAndPointers()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 2000m);
        var to = SeedAccount(db, "user-1", "Pot", 500m);

        var dto = await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 7, 16), 300m, from.Id, to.Id), CancellationToken.None);

        dto.Type.Should().Be(TransactionType.Transfer);
        dto.Amount.Should().Be(300m);
        dto.Currency.Should().Be("EUR");
        dto.AccountId.Should().Be(from.Id);
        dto.AccountName.Should().Be("Current");
        dto.TransferAccountId.Should().Be(to.Id);
        dto.TransferAccountName.Should().Be("Pot");
        dto.BudgetItemId.Should().BeNull();
        dto.IsSplit.Should().BeFalse();

        // One row — a transfer is a single signed row, never a two-leg pair.
        (await db.Transactions.CountAsync()).Should().Be(1);
    }

    // ── TRF-006 / TRF-007: a custom Note becomes the payee, trimmed by the handler; a
    // null/blank/whitespace-only Note falls back to "Transfer" (not the raw spaces).
    [Theory]
    [InlineData("  Rent buffer  ", "Rent buffer")]
    [InlineData(null, "Transfer")]
    [InlineData("", "Transfer")]
    [InlineData("   ", "Transfer")]
    public async Task Transfer_PayeeIsTheTrimmedNote_OrTransfer(string? note, string expectedPayee)
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 2000m);
        var to = SeedAccount(db, "user-1", "Pot", 500m);

        var dto = await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(
                new CreateTransferCommand(new DateOnly(2026, 7, 16), 50m, from.Id, to.Id, note),
                CancellationToken.None);

        dto.Payee.Should().Be(expectedPayee);
    }

    // ── TRF-028 (+ TRF-027 expense side): a transfer moves both balances by the raw amount,
    // leaves the two-account net unchanged, and never lands on ANY budget line's actual —
    // income "received" and expense "spent" both stay 0.
    [Fact]
    public async Task Transfer_MovesBalances_ButLeavesNetWorthAndBudgetActualsUntouched()
    {
        await using var db = NewContext();
        var current = SeedAccount(db, "user-1", "Current", 2000m);
        var pot = SeedAccount(db, "user-1", "Pot", 500m);
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 1000m } },
                },
                new()
                {
                    Name = "Everyday", Kind = CategoryKind.Expense,
                    Items = new List<BudgetItem> { new() { Name = "Groceries", PlannedAmount = 400m } },
                },
            },
        });
        await db.SaveChangesAsync();

        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 7, 16), 300m, current.Id, pot.Id, ReceivedOn: new DateOnly(2026, 7, 16)), CancellationToken.None);

        var accounts = await Accounts(db, "user-1");
        var currentBal = accounts.Single(a => a.Id == current.Id).CurrentBalance;
        var potBal = accounts.Single(a => a.Id == pot.Id).CurrentBalance;
        currentBal.Should().Be(1700m); // 2000 − 300
        potBal.Should().Be(800m);      // 500 + 300
        (currentBal + potBal).Should().Be(2500m); // net across both accounts is unchanged

        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        month.Categories.Single(c => c.Kind == "Income").Items.Single(i => i.Name == "Pay")
            .ActualAmount.Should().Be(0m);
        month.Categories.Single(c => c.Kind == "Expense").Items.Single(i => i.Name == "Groceries")
            .ActualAmount.Should().Be(0m);
    }

    // ── TRF-029: a transfer cannot be assigned to a budget line — the assign endpoint rejects it
    // (transfers are excluded from the budget entirely). Previously the assign silently accepted
    // it and relied on the read-side (line, Type) filter to keep it out of actuals.
    [Fact]
    public async Task Transfer_CannotBeAssignedToABudgetLine()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 2000m);
        var to = SeedAccount(db, "user-1", "Pot", 500m);
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Everyday", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries } },
            },
        });
        await db.SaveChangesAsync();

        var transfer = await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 7, 16), 300m, from.Id, to.Id), CancellationToken.None);

        // The assign endpoint refuses to put a budget line on a transfer.
        var act = () => new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new AssignTransactionCommand(transfer.Id, groceries.Id), CancellationToken.None);
        await act.Should().ThrowAsync<ValidationException>();

        // The line's Spent stays 0 and the transfer keeps no line.
        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        month.Categories.Single(c => c.Kind == "Expense").Items.Single(i => i.Id == groceries.Id)
            .ActualAmount.Should().Be(0m);
    }

    // ── TRF-030: deleting a transfer (immediate, un-confirmed at the handler) reverts BOTH
    // balances to their openings — the register is the single source of truth.
    [Fact]
    public async Task DeletingATransfer_RevertsBothBalances()
    {
        await using var db = NewContext();
        var current = SeedAccount(db, "user-1", "Current", 2000m);
        var pot = SeedAccount(db, "user-1", "Pot", 500m);
        var transfer = await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 7, 16), 300m, current.Id, pot.Id, ReceivedOn: new DateOnly(2026, 7, 16)), CancellationToken.None);

        // Sanity: the transfer has moved the balances before we delete it.
        var moved = await Accounts(db, "user-1");
        moved.Single(a => a.Id == current.Id).CurrentBalance.Should().Be(1700m);
        moved.Single(a => a.Id == pot.Id).CurrentBalance.Should().Be(800m);

        await new DeleteTransactionCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new DeleteTransactionCommand(transfer.Id), CancellationToken.None);

        var reverted = await Accounts(db, "user-1");
        reverted.Single(a => a.Id == current.Id).CurrentBalance.Should().Be(2000m);
        reverted.Single(a => a.Id == pot.Id).CurrentBalance.Should().Be(500m);
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // ── TRF-031 (source side): deleting the SOURCE account of a transfer is refused. A transfer
    // is one movement with a bank leg on each side (rules 51/69); clearing either pointer would
    // leave a half-movement the dated ledger cannot read. Nothing is detached or moved by the
    // refused delete. (TransfersTests covers the destination side.)
    [Fact]
    public async Task DeletingTheSourceAccount_IsRefused_AndLeavesTheTransferIntact()
    {
        await using var db = NewContext();
        var current = SeedAccount(db, "user-1", "Current", 2000m);
        var pot = SeedAccount(db, "user-1", "Pot", 500m);
        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 7, 16), 300m, current.Id, pot.Id,
                ReceivedOn: new DateOnly(2026, 7, 16)), CancellationToken.None);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            new DeleteAccountCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new DeleteAccountCommand(current.Id), CancellationToken.None));

        ex.Errors["Id"].Single().Should().Contain("1 transfer");
        (await db.Accounts.CountAsync()).Should().Be(2);
        var tx = db.Transactions.Single();
        tx.AccountId.Should().Be(current.Id);
        tx.TransferAccountId.Should().Be(pot.Id);

        var accounts = await Accounts(db, "user-1");
        accounts.Single(a => a.Id == current.Id).CurrentBalance.Should().Be(1700m);
        accounts.Single(a => a.Id == pot.Id).CurrentBalance.Should().Be(800m);
    }

    // ── TRF-037: a non-empty but unknown account id is a 404, and the SOURCE is looked up
    // first — a bad source throws before the destination is even read.
    [Fact]
    public async Task Transfer_UnknownAccountId_ThrowsNotFound_SourceCheckedFirst()
    {
        await using var db = NewContext();
        var current = SeedAccount(db, "user-1", "Current", 2000m);
        var handler = new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"));

        // Unknown destination.
        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, current.Id, Guid.NewGuid()),
                CancellationToken.None));

        // Unknown source (checked first).
        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, Guid.NewGuid(), current.Id),
                CancellationToken.None));

        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // ── TRF-038: both accounts exist but the destination belongs to another household —
    // ownership check throws Forbidden (existence revealed), and nothing moves.
    [Fact]
    public async Task Transfer_CrossHouseholdDestination_ThrowsForbidden_AndMovesNothing()
    {
        await using var db = NewContext();
        var mine = SeedAccount(db, "user-1", "Current", 2000m);
        var foreign = SeedAccount(db, "user-2", "Foreign", 0m);
        var handler = new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, mine.Id, foreign.Id),
                CancellationToken.None));

        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // ── TRF-018: the amount at the max boundary is valid; one minor unit over is rejected
    // by the range rule.
    [Fact]
    public void Validator_AcceptsMaxAmount_RejectsOverMax()
    {
        var validator = new CreateTransferCommandValidator();
        var from = Guid.NewGuid();
        var to = Guid.NewGuid();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 99_999_999_999_999.9999m, from, to))
            .IsValid.Should().BeTrue();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 100_000_000_000_000m, from, to))
            .IsValid.Should().BeFalse();
    }

    // ── TRF-019: a Note over 200 characters is rejected by the Payee.MaximumLength(200) rule;
    // exactly 200 is accepted.
    [Fact]
    public void Validator_RejectsNoteLongerThan200Chars()
    {
        var validator = new CreateTransferCommandValidator();
        var from = Guid.NewGuid();
        var to = Guid.NewGuid();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, from, to, new string('x', 201)))
            .IsValid.Should().BeFalse();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, from, to, new string('x', 200)))
            .IsValid.Should().BeTrue();
    }

    // ── TRF-040: an empty/omitted source or destination id fails the NotEmpty rule at the
    // validator (a 400 before the handler), never reaching the 404 lookup path a non-empty
    // unknown id would hit.
    [Fact]
    public void Validator_RejectsEmptyAccountIds()
    {
        var validator = new CreateTransferCommandValidator();
        var real = Guid.NewGuid();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, Guid.Empty, real))
            .IsValid.Should().BeFalse();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, real, Guid.Empty))
            .IsValid.Should().BeFalse();
    }

    // ── TRF-039 (server side): the transfer command is [AllowLimited], so the role gate lets
    // a Limited login through but refuses a ReadOnly one. Exercised end-to-end against the
    // REAL CreateTransferCommand type through AuthorizationBehaviour (the handler is stubbed).
    [Fact]
    public async Task CreateTransferCommand_IsAllowedForLimited_ButNotReadOnly()
    {
        var command = new CreateTransferCommand(new DateOnly(2026, 7, 16), 10m, Guid.NewGuid(), Guid.NewGuid());

        // Limited: the gate passes the request to the (stub) handler.
        var limitedRan = false;
        var limitedGate = new AuthorizationBehaviour<CreateTransferCommand, TransactionDto>(new RoleStub(HouseholdRole.Limited));
        RequestHandlerDelegate<TransactionDto> next = _ =>
        {
            limitedRan = true;
            return Task.FromResult(new TransactionDto());
        };
        await limitedGate.Handle(command, next, CancellationToken.None);
        limitedRan.Should().BeTrue();

        // ReadOnly: the gate throws before the handler runs.
        var readOnlyGate = new AuthorizationBehaviour<CreateTransferCommand, TransactionDto>(new RoleStub(HouseholdRole.ReadOnly));
        RequestHandlerDelegate<TransactionDto> blocked = _ => Task.FromResult(new TransactionDto());
        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            readOnlyGate.Handle(command, blocked, CancellationToken.None));
    }
}
