using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AllotJar.Application.Export;

/// <summary>
/// Packs an export as one zip: <c>allotjar-data.json</c> with everything, a CSV for each table
/// (UTF-8 with a byte order mark, so Excel reads accents), and a short README naming the files.
/// </summary>
public static class DataExportArchive
{
    public const string JsonFile = "allotjar-data.json";

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private static readonly UTF8Encoding Utf8WithBom = new(encoderShouldEmitUTF8Identifier: true);

    public static string FileName(DateTime exportedUtc) => $"allotjar-data-{exportedUtc:yyyy-MM-dd}.zip";

    public static byte[] Build(DataExport export)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            Add(zip, "README.txt", Readme(export), new UTF8Encoding(false));
            Add(zip, JsonFile, JsonSerializer.Serialize(export, JsonOptions), new UTF8Encoding(false));
            foreach (var (name, csv) in Tables(export))
            {
                Add(zip, name, csv.ToString(), Utf8WithBom);
            }
        }
        return buffer.ToArray();
    }

    private static void Add(ZipArchive zip, string name, string text, Encoding encoding)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        using var stream = entry.Open();
        var preamble = encoding.GetPreamble();
        stream.Write(preamble);
        stream.Write(encoding.GetBytes(text));
    }

    public static IEnumerable<(string Name, Csv Table)> Tables(DataExport e)
    {
        var p = e.Profile;
        yield return ("profile.csv", new Csv("email", "first_name", "last_name", "display_name", "email_confirmed",
                "terms_accepted_utc", "has_password", "google_connected", "preferred_currency", "number_format", "household", "role")
            .Row(p.Email, p.FirstName, p.LastName, p.DisplayName, p.EmailConfirmed,
                p.ConsentedUtc, p.HasPassword, p.GoogleConnected, p.PreferredCurrency, p.NumberFormat, p.Household, p.Role));

        var signIns = new Csv("device", "signed_in_utc", "last_used_utc");
        foreach (var s in e.SignIns)
        {
            signIns.Row(s.Device, s.SignedInUtc, s.LastUsedUtc);
        }
        yield return ("sign-ins.csv", signIns);

        var passkeys = new Csv("added_on_device", "added_utc");
        foreach (var k in e.Passkeys)
        {
            passkeys.Row(k.Name, k.AddedUtc);
        }
        yield return ("passkeys.csv", passkeys);

        var accounts = new Csv("id", "name", "type", "currency", "opening_balance", "opening_date", "balance", "balance_as_of",
            "in_transit_out", "in_transit_in", "holders", "private");
        foreach (var a in e.Accounts)
        {
            accounts.Row(a.Id, a.Name, a.Type, a.Currency, a.OpeningBalance, a.OpeningDate, a.CurrentBalance, a.BalanceAsOf,
                a.InTransitOut, a.InTransitIn,
                string.Join("; ", a.Holders.Select(h => h.Name)), a.IsPrivate);
        }
        yield return ("accounts.csv", accounts);

        var people = new Csv("id", "name", "net_monthly_income", "personal_savings_account_id", "savings_account_private", "archived");
        foreach (var m in e.People)
        {
            people.Row(m.Id, m.Name, m.NetMonthlyIncome, m.PersonalSavingsAccountId, m.SavingsPrivate, m.IsArchived);
        }
        yield return ("people.csv", people);

        var access = new Csv("email", "display_name", "role", "status", "person_id", "you", "since_utc");
        foreach (var m in e.HouseholdAccess)
        {
            access.Row(m.Email, m.DisplayName, m.Role, m.Status, m.MemberId, m.IsSelf, m.CreatedUtc);
        }
        yield return ("household-access.csv", access);

        var transactions = new Csv("id", "date", "type", "payee", "amount", "currency", "original_amount", "original_currency",
            "budget_amount", "account", "transfer_account", "budget_line", "budget_month", "person", "split", "bank_reference",
            "transfer_status", "departed_on", "received_on", "returned_on", "fee", "refund_of_id", "notes", "statement_match");
        var splits = new Csv("transaction_id", "date", "payee", "budget_line", "person", "amount");
        foreach (var t in e.Transactions)
        {
            transactions.Row(t.Id, t.Date, t.Type, t.Payee, t.Amount, t.Currency, t.OriginalAmount, t.OriginalCurrency,
                t.BudgetAmount, t.AccountName, t.TransferAccountName, t.BudgetItemName, MonthKey(t.BudgetItemYear, t.BudgetItemMonth),
                t.MemberName, t.IsSplit, t.BankReference, t.TransferStatus, t.DepartedOn, t.ReceivedOn, t.ReturnedOn, t.Fee,
                t.RefundOfTransactionId, t.Notes, t.StatementMatch);
            foreach (var s in t.Splits)
            {
                splits.Row(t.Id, t.Date, t.Payee, s.BudgetItemName, s.MemberName, s.Amount);
            }
        }
        yield return ("transactions.csv", transactions);
        yield return ("transaction-splits.csv", splits);

        var memberNames = e.People.ToDictionary(m => m.Id, m => m.Name);
        var lines = new Csv("month", "group", "group_kind", "line", "planned", "actual", "remaining", "refunded",
            "jar_id", "due_day", "paid", "skipped", "person");
        foreach (var month in e.Budgets)
        {
            foreach (var c in month.Categories.OrderBy(c => c.DisplayOrder))
            {
                foreach (var i in c.Items.OrderBy(i => i.DisplayOrder))
                {
                    lines.Row(month.Key, c.Name, c.Kind, i.Name, i.PlannedAmount, i.ActualAmount, i.Remaining, i.RefundedAmount,
                        i.SavingsId, i.DueDay, i.IsPaid, i.IsSkipped,
                        i.MemberId is Guid id && memberNames.TryGetValue(id, out var name) ? name : null);
                }
            }
        }
        yield return ("budget-lines.csv", lines);

        var jars = new Csv("id", "name", "kind", "target", "target_date", "accrual", "monthly_contribution", "repeats_every_months",
            "month_only", "account", "balance", "balance_as_of", "status", "deadline", "completed_on", "archived");
        var accountNames = e.Accounts.ToDictionary(a => a.Id, a => a.Name);
        foreach (var j in e.Jars)
        {
            jars.Row(j.Id, j.Name, j.Kind, j.TargetAmount, j.TargetDate, j.Accrual, j.MonthlyContribution, j.RecurMonths,
                j.MonthOnly, accountNames.GetValueOrDefault(j.FundingAccountId), j.CurrentBalance, j.BalanceAsOf, j.Status,
                j.Deadline, j.CompletedOn, j.IsArchived);
        }
        yield return ("jars.csv", jars);

        var cycles = new Csv("jar_id", "jar", "deadline", "target", "outcome", "balance_at_deadline", "paid_on", "paid_amount",
            "payment_payee", "closed_on");
        foreach (var c in e.JarCycles)
        {
            cycles.Row(c.JarId, c.JarName, c.Deadline, c.TargetAmount, c.Outcome, c.BalanceAtDeadline, c.PaidOn, c.PaidAmount,
                c.PaymentPayee, c.ClosedOn);
        }
        yield return ("jar-cycles.csv", cycles);

        var movements = new Csv("date", "kind", "account", "jar", "amount", "transaction_id", "note");
        foreach (var m in e.JarMovements)
        {
            movements.Row(m.Date, m.Kind, m.AccountName, m.JarName, m.Amount, m.TransactionId, m.Note);
        }
        yield return ("jar-movements.csv", movements);

        var history = new Csv("jar_id", "jar", "effective_from", "kind", "target", "target_date", "cycle_deadline", "accrual",
            "monthly_contribution", "include_deadline_month", "repeats_every_months");
        foreach (var r in e.JarHistory)
        {
            history.Row(r.JarId, r.JarName, r.EffectiveFrom, r.Kind, r.TargetAmount, r.TargetDate, r.CycleDeadline, r.Accrual,
                r.MonthlyContribution, r.IncludeDeadlineMonth, r.RecurMonths);
        }
        yield return ("jar-history.csv", history);

        var archived = new Csv("jar_id", "jar", "archived_on", "restored_on");
        foreach (var a in e.JarArchivePeriods)
        {
            archived.Row(a.JarId, a.JarName, a.ArchivedOn, a.RestoredOn);
        }
        yield return ("jar-archive-periods.csv", archived);

        var rules = new Csv("order", "type", "split", "fixed_amount_per_person");
        foreach (var r in e.AllocationProfile?.Rules ?? [])
        {
            rules.Row(r.Order, r.Type, r.Split, r.FixedAmountPerMember);
        }
        yield return ("allocation-rules.csv", rules);
    }

    private static string? MonthKey(int? year, int? month) =>
        year is int y && month is int m ? $"{y:D4}-{m:D2}" : null;

    private static string Readme(DataExport e) =>
        $"""
        AllotJar: your data
        Exported {e.ExportedUtc:yyyy-MM-dd HH:mm} UTC for {e.Profile.Email}, household "{e.Profile.Household}".

        This is everything you can see in AllotJar for this household. Accounts another person
        keeps private are not included; money from them on a shared budget line reads "Private account".
        If you belong to more than one household, switch household and download again for the other.

        {JsonFile}          everything below in one file
        profile.csv                 your sign-in details and preferences
        sign-ins.csv                the devices you are signed in on, and when each was last used
        passkeys.csv                your passkeys: the device each was added on, and when
        accounts.csv                accounts, bank details and balances
        people.csv                  the people in the household
        household-access.csv        who can sign in to the household
        transactions.csv            every transaction, with notes and the statement date, amount and
                                    direction it was matched on when imported
        transaction-splits.csv      the parts of split transactions
        budget-lines.csv            every budget month, group and line
        jars.csv                    jars and their balances
        jar-cycles.csv              each jar's past deadlines and how they ended
        jar-movements.csv           money put into, moved between and taken out of jars
        jar-history.csv             each jar's earlier targets and schedules, from the date they applied
        jar-archive-periods.csv     the times a jar was archived and then restored
        allocation-rules.csv        the income allocation rules

        Amounts use a dot for decimals; dates are YYYY-MM-DD.
        """;
}
