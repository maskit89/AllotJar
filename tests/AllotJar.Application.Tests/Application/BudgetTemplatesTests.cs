using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetTemplates;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Quick-start templates: the catalogue query, and creating a month from a template.
/// </summary>
public class BudgetTemplatesTests
{
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

    private static void SeedMay(AllotJar.Infrastructure.Persistence.ApplicationDbContext db) =>
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

    [Theory]
    [InlineData(true, "student")]  // a template, even with the copy asked for too
    [InlineData(false, "student")] // a template
    [InlineData(false, null)]      // a blank start
    public async Task CreateMonth_WithAnEarlierMonth_OnlyContinuesIt_ABlankOrTemplateStartIsRefused(
        bool copyFromPrevious, string? templateKey)
    {
        // Rule 94 (holistic review 2026-11-02, L1): once there is a budget, a new month continues
        // the most recent earlier one. The server refuses the rest, not just the Dashboard, so a
        // hand-made request can't drop May's plan; nothing is saved.
        await using var db = NewContext();
        SeedMay(db);
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var refused = await Assert.ThrowsAsync<ValidationException>(() => handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, copyFromPrevious, templateKey), CancellationToken.None));

        refused.Errors.Keys.Should().ContainSingle()
            .Which.Should().Be(templateKey is null ? "CopyFromPrevious" : "TemplateKey");
        refused.Errors.Values.Single().Single().Should().Contain("2026-05");
        (await db.BudgetMonths.CountAsync()).Should().Be(1);

        var june = await handler.Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);
        june.Categories.Should().Contain(c => c.Name == "Old Group");
    }

    [Fact]
    public async Task CreateMonth_BeforeTheEarliestMonth_MayStartBlank_ButNotFromATemplate()
    {
        // A month before the first has nothing to continue, so it may start blank (the Dashboard
        // offers that); templates are for the household's very first budget only.
        await using var db = NewContext();
        SeedMay(db);
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var refused = await Assert.ThrowsAsync<ValidationException>(() => handler.Handle(
            new CreateBudgetMonthCommand(2026, 4, CopyFromPrevious: false, TemplateKey: "student"), CancellationToken.None));
        refused.Errors.Keys.Should().ContainSingle().Which.Should().Be("TemplateKey");

        var april = await handler.Handle(new CreateBudgetMonthCommand(2026, 4, CopyFromPrevious: false), CancellationToken.None);
        april.Categories.Should().ContainSingle().Which.Kind.Should().Be("Income");
        (await db.BudgetMonths.CountAsync()).Should().Be(2);
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
