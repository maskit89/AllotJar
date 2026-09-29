using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetTemplates;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Quick-start templates: the catalogue query, and creating a month from a template.
/// </summary>
public class BudgetTemplatesTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

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
        dto.Categories.Should().NotContain(c => c.Kind == "Savings"); // rule 81: no savings lines in a template
        dto.Categories.SelectMany(c => c.Items).Should().OnlyContain(i => i.PlannedAmount == 0m);
        dto.RemainingToBudget.Should().Be(0m); // nothing planned yet
    }

    [Theory]
    [InlineData("essentials")]
    [InlineData("student")]
    [InlineData("family")]
    public async Task CreateMonth_FromTemplate_CreatesNoSavingsLinesAndNoJars(string templateKey)
    {
        // Rule 81: templates keep income/expense structure only; a jar needs its account and is
        // created through the jar form, so no template line ever carries a SavingsId.
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false, TemplateKey: templateKey),
            CancellationToken.None);

        var savingsLines = await db.BudgetItems
            .Include(i => i.BudgetCategory)
            .Where(i => i.BudgetCategory.Kind == CategoryKind.Savings || i.SavingsId != null)
            .ToListAsync();

        savingsLines.Should().BeEmpty();
        db.Jars.Should().BeEmpty();
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
