using System.IO.Compression;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Export;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Compliance fix 4, "Download my data": the zip holds everything the login can see, as JSON and a
/// CSV per table, and nothing it can't. Chris owns the household; Sam keeps a private account
/// (rule 31) with an entry off the budget, one on a household line and a transfer in from the joint
/// account. Chris's download must never carry Sam's private account, its bank details, its balance or
/// the money only it moves (P53/P56); on the budget line the entry reads "Private account" with no
/// id. Sam's own download has all of it.
/// </summary>
public class DataExportTests
{
    private const string Household = "chris-login";
    private const string SamLogin = "sam-login";
    private static readonly DateOnly June10 = new(2026, 6, 10);
    private const string SamsIban = "MT84MALT011000012345MTLCAST001S";

    private sealed class Viewer(string userId, Guid? memberId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => Household;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId { get; } = memberId;
    }

    private sealed class NoLogins : IIdentityService
    {
        public Task<UserAccount?> FindByIdAsync(string userId) => Task.FromResult<UserAccount?>(null);
        public Task<bool> EmailExistsAsync(string email) => throw new NotSupportedException();
        public Task<UserAccount?> FindByEmailAsync(string email) => throw new NotSupportedException();
        public Task<CurrencyCode?> GetPreferredCurrencyAsync(string userId) => Task.FromResult<CurrencyCode?>(null);
        public Task<CreateUserResult> CreateUserAsync(string email, string password, string? displayName, bool consented = false, bool mustChangePassword = false) => throw new NotSupportedException();
        public Task SetActiveHouseholdAsync(string userId, string? ownerId) => throw new NotSupportedException();
        public Task<IReadOnlyList<string>> ChangePasswordAsync(string userId, string currentPassword, string newPassword) => throw new NotSupportedException();
        public Task<CredentialCheckResult> CheckCredentialsAsync(string email, string password) => throw new NotSupportedException();
    }

    private readonly DbContextOptions<ApplicationDbContext> _options = new DbContextOptionsBuilder<ApplicationDbContext>()
        .UseInMemoryDatabase($"export-{Guid.NewGuid()}")
        .Options;

    private readonly Guid _chris;
    private readonly Guid _sam;

    public DataExportTests()
    {
        using var db = new ApplicationDbContext(_options);
        _chris = AddPerson(db, "Chris", 0);
        _sam = AddPerson(db, "Sam", 1);
        db.HouseholdMemberships.AddRange(
            new HouseholdMembership { OwnerId = Household, UserId = Household, Role = HouseholdRole.Owner, MemberId = _chris, InvitedEmail = "chris@example.com" },
            new HouseholdMembership { OwnerId = Household, UserId = SamLogin, Role = HouseholdRole.Admin, MemberId = _sam, InvitedEmail = "sam@example.com" });
        db.SaveChanges();
    }

    private Viewer Chris => new(Household, _chris);
    private Viewer Sam => new(SamLogin, _sam);
    private ApplicationDbContext As(ICurrentUser viewer) => new(_options, viewer);

    private static Guid AddPerson(ApplicationDbContext db, string name, int order)
    {
        var member = new HouseholdMember { OwnerId = Household, Name = name, DisplayOrder = order };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member.Id;
    }

    private static ExportProfile ProfileOf(string email) =>
        new(email, null, null, null, true, null, true, false, "EUR", "en", "Your household", "Owner");

    private async Task<DataExport> ExportAsync(Viewer viewer)
    {
        var services = new ServiceCollection().AddApplication();
        services.AddScoped<IApplicationDbContext>(_ => As(viewer));
        services.AddSingleton<ICurrentUser>(viewer);
        services.AddSingleton<IIdentityService, NoLogins>();
        await using var provider = services.BuildServiceProvider();
        using var scope = provider.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<MediatR.ISender>()
            .Send(new ExportMyDataQuery(ProfileOf(viewer.UserId + "@example.com"), June10));
    }

    private static Dictionary<string, string> Unzip(byte[] zip)
    {
        using var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read);
        return archive.Entries.ToDictionary(e => e.FullName, e =>
        {
            using var reader = new StreamReader(e.Open(), Encoding.UTF8);
            return reader.ReadToEnd();
        });
    }

    private async Task<(Guid Joint, Guid Mine, Guid Line)> SeedAsync()
    {
        Guid line;
        await using (var db = new ApplicationDbContext(_options))
        {
            var month = new BudgetMonth { OwnerId = Household, Year = 2026, Month = 6 };
            var category = new BudgetCategory { BudgetMonth = month, Name = "Food", Kind = CategoryKind.Expense };
            var item = new BudgetItem { BudgetCategory = category, Name = "Groceries", PlannedAmount = 300m };
            category.Items.Add(item);
            month.Categories.Add(category);
            db.BudgetMonths.Add(month);
            await db.SaveChangesAsync();
            line = item.Id;
        }

        Guid joint;
        await using (var db = As(Chris))
        {
            joint = (await new CreateAccountCommandHandler(db, Chris).Handle(
                new CreateAccountCommand("Joint", AccountType.Current, "EUR", 1000m, LedgerFixtures.DefaultOpening),
                CancellationToken.None)).Id;
            await new CreateTransactionCommandHandler(db, Chris).Handle(
                new CreateTransactionCommand(June10, "=HYPERLINK(\"http://x\")", 25m, TransactionType.Expense, BudgetItemId: line, AccountId: joint),
                CancellationToken.None);
        }

        Guid mine;
        await using (var db = As(Sam))
        {
            mine = (await new CreateAccountCommandHandler(db, Sam).Handle(
                new CreateAccountCommand("Sam's secret savings", AccountType.Current, "EUR", 5000m, LedgerFixtures.DefaultOpening,
                    Iban: SamsIban, HolderIds: new[] { _sam }),
                CancellationToken.None)).Id;
            var sam = new CreateTransactionCommandHandler(db, Sam);
            await sam.Handle(new CreateTransactionCommand(June10, "Pharmacy", 40m, TransactionType.Expense, BudgetItemId: null, AccountId: mine), CancellationToken.None);
            await sam.Handle(new CreateTransactionCommand(June10, "Corner shop", 60m, TransactionType.Expense, BudgetItemId: line, AccountId: mine), CancellationToken.None);
            await new CreateTransferCommandHandler(db, Sam).Handle(
                new CreateTransferCommand(June10, 200m, joint, mine, ReceivedOn: June10), CancellationToken.None);
        }

        // Notes and the statement match, which no screen lists; one on each side.
        await using (var db = new ApplicationDbContext(_options))
        {
            foreach (var t in db.Transactions)
            {
                t.Notes = $"note {t.Payee}";
                t.BankEntry = $"2026-06-10|{t.Amount}|D";
            }
            await db.SaveChangesAsync();
        }
        return (joint, mine, line);
    }

    /// <summary>
    /// Sam's opening balance (5000) as a number: with a sign, a currency code or a decimal part, in
    /// the JSON or a CSV. A bare "5000" would also match inside a random id or a timestamp, so a hex
    /// digit or point right before it, a letter or digit and a hyphen before it (a segment of an id),
    /// or a letter, digit or point after it rules a match out.
    /// </summary>
    private const string SamsOpeningBalance = @"(?<![0-9A-Fa-f.])(?<![0-9A-Za-z]-)5000(\.0+)?(?![\w.])";

    [Fact]
    public async Task The_owners_download_leaves_out_another_logins_private_account_and_its_money()
    {
        var (_, mine, _) = await SeedAsync();

        var export = await ExportAsync(Chris);

        export.Accounts.Select(a => a.Name).Should().Equal("Joint");
        export.Transactions.Select(t => t.Payee).Should().NotContain("Pharmacy", "off the budget, only Sam ever sees it");
        var onTheLine = export.Transactions.Single(t => t.Payee == "Corner shop");
        onTheLine.AccountId.Should().BeNull("P56: the others never receive a private account's id");
        onTheLine.AccountName.Should().Be("Private account");
        onTheLine.Notes.Should().BeNull("its notes are Sam's");
        onTheLine.StatementMatch.Should().BeNull("it is a row of the private account's statement");
        var transfer = export.Transactions.Single(t => t.Type == TransactionType.Transfer);
        transfer.TransferAccountId.Should().BeNull();
        transfer.StatementMatch.Should().BeNull();
        export.Transactions.Single(t => t.Payee.StartsWith("=HYPERLINK")).Notes.Should().NotBeNull("Chris's own entry keeps its notes");

        // Nothing in any file of the zip names, numbers or points at Sam's account.
        var files = Unzip(DataExportArchive.Build(export));
        foreach (var (name, text) in files)
        {
            text.Should().NotContain("Sam's secret savings", name)
                .And.NotContain(SamsIban, name)
                .And.NotContain(mine.ToString(), name)
                .And.NotContain("Pharmacy", name)
                .And.NotMatchRegex(SamsOpeningBalance, name);
        }
    }

    [Fact]
    public async Task The_holders_own_download_has_their_private_account_its_bank_details_and_notes()
    {
        await SeedAsync();

        var export = await ExportAsync(Sam);

        export.Accounts.Select(a => a.Name).Should().BeEquivalentTo("Joint", "Sam's secret savings");
        export.Accounts.Single(a => a.Name == "Sam's secret savings").Iban.Should().Be(SamsIban);
        var pharmacy = export.Transactions.Single(t => t.Payee == "Pharmacy");
        pharmacy.Notes.Should().Be("note Pharmacy");
        pharmacy.StatementMatch.Should().Be("2026-06-10|40|D");

        var files = Unzip(DataExportArchive.Build(export));
        files["accounts.csv"].Should().Contain(SamsIban).And.MatchRegex(SamsOpeningBalance, "the pattern must find the balance where it is written");
        files["allotjar-data.json"].Should().MatchRegex(SamsOpeningBalance);
        files["transactions.csv"].Should().Contain("2026-06-10|40|D");
    }

    [Fact]
    public async Task The_devices_the_login_is_signed_in_on_are_in_the_zip()
    {
        await SeedAsync();
        var export = await ExportAsync(Chris);
        export.SignIns = [new ExportedSignIn("Safari on iPhone", new DateTime(2026, 6, 1, 8, 0, 0), new DateTime(2026, 6, 9, 21, 30, 0))];

        var files = Unzip(DataExportArchive.Build(export));

        files["sign-ins.csv"].Should().Contain("device,signed_in_utc,last_used_utc")
            .And.Contain("Safari on iPhone,2026-06-01T08:00:00Z,2026-06-09T21:30:00Z");
        using var json = JsonDocument.Parse(files["allotjar-data.json"]);
        json.RootElement.GetProperty("signIns")[0].GetProperty("device").GetString().Should().Be("Safari on iPhone");
        files["README.txt"].Should().Contain("sign-ins.csv");
    }

    [Fact]
    public async Task The_login_s_passkeys_are_in_the_zip_by_device_and_date()
    {
        await SeedAsync();
        var export = await ExportAsync(Chris);
        export.Passkeys = [new ExportedPasskey("Chrome on Windows", new DateTime(2026, 6, 2, 9, 15, 0))];

        var files = Unzip(DataExportArchive.Build(export));

        files["passkeys.csv"].Should().Contain("added_on_device,added_utc")
            .And.Contain("Chrome on Windows,2026-06-02T09:15:00Z");
        using var json = JsonDocument.Parse(files["allotjar-data.json"]);
        json.RootElement.GetProperty("passkeys")[0].GetProperty("name").GetString().Should().Be("Chrome on Windows");
        files["README.txt"].Should().Contain("passkeys.csv");
    }

    [Fact]
    public async Task The_zip_holds_one_json_file_a_csv_per_table_and_a_readme()
    {
        await SeedAsync();

        var export = await ExportAsync(Chris);
        var files = Unzip(DataExportArchive.Build(export));

        files.Keys.Should().BeEquivalentTo(
            "README.txt", "allotjar-data.json", "profile.csv", "sign-ins.csv", "passkeys.csv", "accounts.csv", "people.csv", "household-access.csv",
            "transactions.csv", "transaction-splits.csv", "budget-lines.csv", "jars.csv", "jar-cycles.csv",
            "jar-movements.csv", "jar-history.csv", "jar-archive-periods.csv", "allocation-rules.csv");

        using var json = JsonDocument.Parse(files["allotjar-data.json"]);
        json.RootElement.GetProperty("profile").GetProperty("email").GetString().Should().Be("chris-login@example.com");
        json.RootElement.GetProperty("accounts").GetArrayLength().Should().Be(1);
        json.RootElement.GetProperty("budgets")[0].GetProperty("key").GetString().Should().Be("2026-06");
        json.RootElement.GetProperty("transactions")[0].GetProperty("type").ValueKind.Should().Be(JsonValueKind.String, "enums read as words");

        files["budget-lines.csv"].Should().Contain("2026-06,Food,Expense,Groceries,300");
        files["people.csv"].Should().Contain("Chris").And.Contain("Sam");
        files["accounts.csv"].Split("\r\n")[1].Should().StartWith(export.Accounts[0].Id + ",Joint,Current,EUR,1000");
    }

    [Fact]
    public async Task A_jars_earlier_settings_and_archived_spells_are_in_the_download()
    {
        var (joint, _, _) = await SeedAsync();
        await using (var db = new ApplicationDbContext(_options))
        {
            var jar = new Jar { OwnerId = Household, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 900m, FundingAccountId = joint };
            db.Jars.Add(jar);
            db.JarRevisions.Add(new JarRevision { JarId = jar.Id, EffectiveFrom = new DateOnly(2026, 3, 1), Kind = JarKind.Goal, TargetAmount = 600m });
            db.JarArchivePeriods.Add(new JarArchivePeriod { JarId = jar.Id, ArchivedOn = new DateOnly(2026, 4, 2), RestoredOn = new DateOnly(2026, 5, 1) });
            await db.SaveChangesAsync();
        }

        var files = Unzip(DataExportArchive.Build(await ExportAsync(Chris)));

        files["jar-history.csv"].Should().Contain(",Holiday,2026-03-01,Goal,600,");
        files["jar-archive-periods.csv"].Should().Contain(",Holiday,2026-04-02,2026-05-01");
    }

    [Fact]
    public async Task A_payee_a_spreadsheet_would_run_as_a_formula_is_written_as_text()
    {
        await SeedAsync();

        var files = Unzip(DataExportArchive.Build(await ExportAsync(Chris)));

        files["transactions.csv"].Should().Contain("\"'=HYPERLINK(\"\"http://x\"\")\"")
            .And.NotContain(",=HYPERLINK");
    }

    [Fact]
    public async Task Downloading_changes_no_figure()
    {
        var (joint, _, _) = await SeedAsync();
        async Task<(decimal? Balance, int Rows, decimal Actual)> Figures()
        {
            await using var db = As(Chris);
            var balance = (await new GetAccountsQueryHandler(db, Chris).Handle(new GetAccountsQuery(June10), CancellationToken.None))
                .Single(a => a.Id == joint).CurrentBalance;
            await using var all = new ApplicationDbContext(_options);
            return (balance, await all.Transactions.CountAsync(), await all.BudgetItems.SumAsync(i => i.ActualAmount));
        }

        var before = await Figures();
        await ExportAsync(Chris);
        await ExportAsync(Sam);

        (await Figures()).Should().Be(before);
    }

    [Theory]
    [InlineData("+44 20", "'+44 20")]
    [InlineData("-5", "'-5")]
    [InlineData("@SUM(A1)", "'@SUM(A1)")]
    [InlineData("Café, bar", "\"Café, bar\"")]
    [InlineData("say \"hi\"", "\"say \"\"hi\"\"\"")]
    [InlineData("Plain", "Plain")]
    public void Csv_text_fields_are_quoted_and_defused(string value, string written) =>
        Csv.Field(value).Should().Be(written);

    [Fact]
    public void Csv_numbers_and_dates_read_the_same_in_every_locale()
    {
        Csv.Field(-1234.50m).Should().Be("-1234.50");
        Csv.Field(new DateOnly(2026, 6, 10)).Should().Be("2026-06-10");
        Csv.Field(new DateTime(2026, 6, 10, 8, 5, 0, DateTimeKind.Utc)).Should().Be("2026-06-10T08:05:00Z");
        Csv.Field(null).Should().BeEmpty();
    }
}
