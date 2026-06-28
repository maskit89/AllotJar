using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using ZeroBudget.Application.Budgets.Commands.CreateBudgetMonth;
using ZeroBudget.Application.Budgets.Queries.GetBudgetTemplates;
using ZeroBudget.Application.Common.Exceptions;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Domain.Entities;
using ZeroBudget.Domain.Enums;
using ZeroBudget.Domain.ValueObjects;
using ZeroBudget.Infrastructure.Persistence;

namespace ZeroBudget.Application.Tests.Application;

/// <summary>
/// Quick-start templates: the catalogue query, and creating a month from a template.
/// </summary>
public class BudgetTemplatesTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-templates-{Guid.NewGuid()}")
            .Options);

    [Fact]
    public async Task GetTemplates_ReturnsTheBuiltInCatalogue()
    {
        var handler = new GetBudgetTemplatesQueryHandler();
        var templates = await handler.Handle(new GetBudgetTemplatesQuery(), CancellationToken.None);

        templates.Select(t => t.Key).Should().Contain(new[] { "essentials", "student", "family" });
        templates.Should().OnlyContain(t => t.Name.Length > 0 && t.Groups.Count > 0);
        // Every template leads with an income group.
        templates.Should().OnlyContain(t => t.Groups[0].Kind == "Income");
    }

    [Fact]
    public async Task CreateMonth_FromTemplate_BuildsTheGroupsAndLinesAtZeroPlanned()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false, TemplateKey: "essentials"),
            CancellationToken.None);

        dto.Categories.Should().Contain(c => c.Kind == "Income");
        dto.Categories.Should().Contain(c => c.Name == "Housing" && c.Kind == "Expense");
        dto.Categories.Should().Contain(c => c.Kind == "Savings"); // Savings (Emergency Fund)
        dto.Categories.SelectMany(c => c.Items).Should().OnlyContain(i => i.PlannedAmount == 0m);
        dto.RemainingToBudget.Should().Be(0m); // nothing planned yet
    }

    [Fact]
    public async Task CreateMonth_FromTemplate_GivesFundLinesAFundId()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false, TemplateKey: "essentials"),
            CancellationToken.None);

        var fundLines = await db.BudgetItems
            .Include(i => i.BudgetCategory)
            .Where(i => i.BudgetCategory.Kind == CategoryKind.Savings)
            .ToListAsync();

        fundLines.Should().NotBeEmpty();
        fundLines.Should().OnlyContain(i => i.SavingsId != null);
    }

    [Fact]
    public async Task CreateMonth_TemplateWinsOverCopyFromPrevious()
    {
        await using var db = NewContext();
        // A previous month the copy path *would* use if the template didn't take precedence.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 5,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Old Group", Kind = CategoryKind.Expense,
                    Items = new List<BudgetItem> { new() { Name = "Old Line", PlannedAmount = 99m } } },
            },
        });
        await db.SaveChangesAsync();

        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true, TemplateKey: "student"),
            CancellationToken.None);

        dto.Categories.Should().NotContain(c => c.Name == "Old Group"); // not copied
        dto.Categories.Should().Contain(c => c.Name == "Study"); // from the student template
    }

    [Fact]
    public async Task CreateMonth_WithUnknownTemplate_Throws()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false, TemplateKey: "does-not-exist"),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
    }
}
