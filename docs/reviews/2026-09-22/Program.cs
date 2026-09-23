using Microsoft.EntityFrameworkCore;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Budgets;
using AllotJar.Application.Allocation;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Accounts;
using AllotJar.Application.Household.Queries.GetMemberIncome;

await using var db = new ApplicationDbContext(new DbContextOptionsBuilder<ApplicationDbContext>()
    .UseInMemoryDatabase("review-" + Guid.NewGuid()).Options);
var today = DateOnly.FromDateTime(DateTime.UtcNow);
var month = new BudgetMonth { OwnerId = "review", Year = today.Year, Month = today.Month };
db.BudgetMonths.Add(month);
await db.SaveChangesAsync();
var jar = await new CreateJarCommandHandler(db, new ReviewUser()).Handle(
    new CreateJarCommand("Opening example", JarKind.Goal, 1200m, null, null, null,
        AccrualMethod.TargetByDate, 600m, null, null), CancellationToken.None);
db.ChangeTracker.Clear();
var saved = await db.BudgetMonths.Include(m => m.Categories).ThenInclude(c => c.Items).SingleAsync();
await BudgetActuals.ApplyAsync(db, "review", saved, CancellationToken.None);
var line = saved.Categories.SelectMany(c => c.Items).Single();
Console.WriteLine($"Opening 600, target 1200, no date: budget planned={line.PlannedAmount}; budget available={line.SavingsAvailable}; jar balance={jar.CurrentBalance}; jar monthly={jar.RequiredMonthlyContribution}");

var person = new HouseholdMember { OwnerId = "review", Name = "Person", NetMonthlyIncome = 3000m };
db.HouseholdMembers.Add(person);
var income = new BudgetCategory { BudgetMonthId = saved.Id, Name = "Income", Kind = CategoryKind.Income };
db.BudgetCategories.Add(income);
db.BudgetItems.Add(new BudgetItem { BudgetCategoryId = income.Id, Name = "Income", PlannedAmount = 2000m });
await db.SaveChangesAsync();
var plan = await AllocationPlanner.PlanAsync(db,"review",today.Year,today.Month,null,CancellationToken.None);
Console.WriteLine($"Budget income=2000, member default=3000, unassigned income: allocation pool={plan.Result.Pool}; income from budget={plan.IncomeFromBudget}");

await using var futureDb = new ApplicationDbContext(new DbContextOptionsBuilder<ApplicationDbContext>()
    .UseInMemoryDatabase("review-" + Guid.NewGuid()).Options);
for (var i = 0; i < 2; i++) {
    var date = today.AddMonths(i);
    futureDb.BudgetMonths.Add(new BudgetMonth { OwnerId = "review", Year = date.Year, Month = date.Month });
}
await futureDb.SaveChangesAsync();
var futureJar = await new CreateJarCommandHandler(futureDb, new ReviewUser()).Handle(
    new CreateJarCommand("Future example", JarKind.Goal, 1200m, null, null, null,
        AccrualMethod.TargetByDate, 0m, null, null), CancellationToken.None);
Console.WriteLine($"New 1200 goal, current + next month exist: planned lines={string.Join(",",await futureDb.BudgetItems.Select(i=>i.PlannedAmount).ToListAsync())}; jar balance={futureJar.CurrentBalance}; jar monthly={futureJar.RequiredMonthlyContribution}");

await using var importDb = new ApplicationDbContext(new DbContextOptionsBuilder<ApplicationDbContext>()
    .UseInMemoryDatabase("review-" + Guid.NewGuid()).Options);
var a = new Account { OwnerId="review", Name="A", Currency=CurrencyCode.Eur, OpeningBalance=1000m };
var b = new Account { OwnerId="review", Name="B", Currency=CurrencyCode.Eur };
importDb.Accounts.AddRange(a,b);
await importDb.SaveChangesAsync();
var importer = new CommitImportCommandHandler(importDb,new ReviewUser(),new ReviewRates());
await importer.Handle(new CommitImportCommand(a.Id,new[] {
    new CommitImportItem("bank-a-reference",today,"Transfer to B",100m,"EUR",false,null,null,TransferAccountId:b.Id)
}),CancellationToken.None);
await importer.Handle(new CommitImportCommand(b.Id,new[] {
    new CommitImportItem("bank-b-reference",today,"Transfer from A",100m,"EUR",true,null,null,TransferAccountId:a.Id)
}),CancellationToken.None);
await AccountBalances.ApplyAsync(importDb,"review",new[] { a,b },CancellationToken.None);
Console.WriteLine($"Import both sides of ONE 100 transfer with different bank references: A={a.CurrentBalance}; B={b.CurrentBalance}; transactions={await importDb.Transactions.CountAsync()}");

var member = new HouseholdMember { OwnerId="review",Name="FX person" };
importDb.HouseholdMembers.Add(member);
importDb.Transactions.Add(new Transaction { OwnerId="review",Date=today,Payee="Foreign income",Amount=100m,
    Currency=CurrencyCode.From("GBP"),ExchangeRate=1.2m,Type=TransactionType.Income,MemberId=member.Id });
await importDb.SaveChangesAsync();
var memberIncome = await new GetMemberIncomeQueryHandler(importDb,new ReviewUser()).Handle(
    new GetMemberIncomeQuery(today.Year,today.Month),CancellationToken.None);
Console.WriteLine($"Member income 100 GBP at 1.2 EUR/GBP: received={memberIncome.Items.Single().Received}; converted amount should be 120");

sealed class ReviewUser : ICurrentUser { public string? UserId => "review"; }
sealed class ReviewRates : IExchangeRateProvider {
    public Task<decimal?> GetRateAsync(CurrencyCode from,CurrencyCode to,DateOnly date,CancellationToken ct)
        => Task.FromResult<decimal?>(1m);
}
