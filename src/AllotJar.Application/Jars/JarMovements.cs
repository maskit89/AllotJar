using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>Money arriving in an account, put into one of that account's jars (rule 78). Whatever is not named stays unallocated.</summary>
public sealed record JarAllocationInput(Guid JarId, decimal Amount);

/// <summary>
/// Writes the stored jar split of one account leg of a transaction (<see cref="JarAllocationKind.Movement"/>).
/// Incoming money (rule 78): the user's answer to "how much goes to each jar?", the remainder
/// unallocated. Outgoing money (rule 79): jar-line portions draw from their jars, and the rest
/// from the jar the user named, or unallocated. A leg whose attribution equals what the reader
/// derives on its own stores nothing, so the ledger stays the single source of truth.
/// The transaction may be unsaved; the row follows it into the same SaveChanges.
/// </summary>
public static class JarMovements
{
    /// <summary>
    /// Stores how <paramref name="amount"/> reaching <paramref name="account"/> is divided among its
    /// jars. An empty or null <paramref name="inputs"/> leaves it all unallocated (the prompt was
    /// dismissed) and clears any earlier answer, except the shares of jars that have since left
    /// the account (rule 80), which stay as recorded and are reduced only when the amount can no
    /// longer hold them.
    /// </summary>
    public static async Task ApplyIncomingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account, DateOnly date,
        decimal amount, IReadOnlyList<JarAllocationInput>? inputs, string errorKey, CancellationToken cancellationToken,
        bool postsNow = false)
    {
        var existing = await FindAsync(db, transaction.Id, account.Id, cancellationToken);
        // Shares this leg put into jars that have since left the account (rule 80): history kept
        // there, which the prompt can no longer answer for, so they stay as recorded — reduced
        // only when the corrected amount can no longer hold them.
        var kept = await KeptIncomingAsync(db, ownerId, existing, account.Id, date, cancellationToken);
        kept = ScaleToFit(kept, amount);
        var postings = kept.Where(k => k.Value != 0m).Select(k => new JarAllocationPosting { JarId = k.Key, Amount = k.Value }).ToList();
        var named = kept.Values.Sum();
        // An answer naming a kept jar is the stored share echoed back by the edit form.
        var answers = inputs?.Where(i => !kept.ContainsKey(i.JarId)).ToList();
        if (answers is { Count: > 0 })
        {
            // An answer the edit form echoes back unchanged (same jar, amount and date) is the leg's
            // own history and is not judged again; a new answer, a changed one, one on a re-dated
            // leg, or a pledge whose receipt posts only now (#283 review P2-1) is.
            var echoed = !postsNow && existing is not null && existing.Date == date
                ? answers.GroupBy(i => i.JarId)
                    .Where(g => StoredShare(existing, g.Key) is var stored && stored > 0m && stored == g.Sum(i => i.Amount))
                    .Select(g => g.Key).ToHashSet()
                : new HashSet<Guid>();
            var jars = await OwnJarsAsync(db, ownerId, account, answers.Select(i => i.JarId), date, echoed, errorKey, cancellationToken);
            foreach (var group in answers.Where(i => i.Amount != 0m).GroupBy(i => i.JarId))
            {
                var jar = jars[group.Key];
                var jarAmount = group.Sum(i => i.Amount);
                if (jarAmount < 0m)
                {
                    throw Validation(errorKey, $"The amount for {jar.Name} must be zero or more.");
                }
                // An archived jar holds nothing (rule 26); its stored share sent back unchanged is
                // history, not money put in now (W07 P3-10).
                if (jar.IsArchived && !echoed.Contains(jar.Id))
                {
                    throw Validation(errorKey, $"{jar.Name} is archived. Restore it before putting money into it.");
                }
                named += jarAmount;
                postings.Add(new JarAllocationPosting { JarId = jar.Id, Amount = jarAmount });
            }
        }
        if (named > amount)
        {
            var keptNote = kept.Values.Sum() is var k and > 0m
                ? $" ({k:0.##} of it stays in jars that have since moved to another account)"
                : string.Empty;
            throw Validation(errorKey,
                $"The jar amounts total {named:0.##} but only {amount:0.##} {account.Currency.Value} reached {account.Name}{keptNote}.");
        }
        if (postings.Count > 0 && amount - named > 0m)
        {
            postings.Add(new JarAllocationPosting { JarId = null, Amount = amount - named });
        }
        await ReplaceAsync(db, ownerId, transaction, account.Id, date, postings, cancellationToken, existing);
    }

    /// <summary>The incoming shares <paramref name="existing"/> gave jars designated elsewhere now; refused when the leg would be dated after such a jar left.</summary>
    private static async Task<Dictionary<Guid, decimal>> KeptIncomingAsync(
        IApplicationDbContext db, string ownerId, JarAllocation? existing, Guid accountId, DateOnly date, CancellationToken cancellationToken)
    {
        var shares = existing?.Postings.Where(p => p.JarId is not null && p.Amount > 0m)
            .GroupBy(p => p.JarId!.Value).ToDictionary(g => g.Key, g => g.Sum(p => p.Amount)) ?? new Dictionary<Guid, decimal>();
        if (shares.Count == 0)
        {
            return shares;
        }
        var ids = shares.Keys.ToList();
        var departed = await db.Jars.AsNoTracking().Where(j => ids.Contains(j.Id) && j.FundingAccountId != accountId).ToListAsync(cancellationToken);
        var kept = new Dictionary<Guid, decimal>();
        foreach (var jar in departed)
        {
            if (await JarDepartures.CoveringAsync(db, ownerId, jar.Id, accountId, date, cancellationToken) is null)
            {
                var left = await JarDepartures.LastAsync(db, jar.Id, accountId, cancellationToken);
                throw JarDepartures.DatedAfterDeparture(jar.Name, left);
            }
            kept[jar.Id] = shares[jar.Id];
        }
        return kept;
    }

    /// <summary>
    /// Kept shares unchanged when they fit in <paramref name="amount"/>; otherwise each is reduced
    /// in proportion so they total exactly <paramref name="amount"/> (cents by largest remainder,
    /// ties by jar id), never below zero.
    /// </summary>
    internal static Dictionary<Guid, decimal> ScaleToFit(Dictionary<Guid, decimal> shares, decimal amount)
    {
        var total = shares.Values.Sum();
        if (total <= amount || total == 0m)
        {
            return shares;
        }
        var cents = (long)decimal.Round(amount * 100m, 0, MidpointRounding.ToZero);
        var exact = shares.OrderBy(s => s.Key).Select(s => (s.Key, Raw: s.Value * 100m * amount / total)).ToList();
        var floors = exact.Select(e => (e.Key, Cents: (long)decimal.Floor(e.Raw), Rem: e.Raw - decimal.Floor(e.Raw))).ToList();
        var left = cents - floors.Sum(f => f.Cents);
        var result = floors.ToDictionary(f => f.Key, f => f.Cents);
        foreach (var f in floors.OrderByDescending(f => f.Rem).ThenBy(f => f.Key).Take((int)left))
        {
            result[f.Key]++;
        }
        return result.ToDictionary(r => r.Key, r => r.Value / 100m);
    }

    /// <summary>
    /// Stores where an expense leaving <paramref name="account"/> comes from: each slice (or the
    /// whole line) on a jar of this account draws from that jar; everything else draws from
    /// <paramref name="paidFromJarId"/>, or from unallocated when null. Reads the transaction's
    /// current line and slices, so callers set those first. A line whose jar has since left this
    /// account (rule 80) still draws from that jar when the leg's stored operation says it did:
    /// the reader can no longer derive that on its own, so the attribution is written down again.
    /// So does a line whose jar this account held on the payment's date in a stretch that has
    /// since ended (a late entry, or one re-lined onto the jar, R2-D1): the account made it while
    /// it held the jar. The departure closing that stretch is re-settled either way (P51). The
    /// account's ledger must read the date: before its opening date nothing is counted, so nothing
    /// is kept. With <paramref name="keepDepartedDraw"/> (an edit that gave no jar answer) a draw from the
    /// named jar that has since left the account is kept too. A leg drawing from a departed jar
    /// can't be dated after the day the jar left, nor re-dated before its recorded stretch there began.
    /// </summary>
    /// <param name="slices">The transaction's slices when they are not yet on its collection (a split being written); null reads <c>transaction.Splits</c>.</param>
    public static async Task ApplyOutgoingAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account,
        Guid? paidFromJarId, string errorKey, CancellationToken cancellationToken,
        IReadOnlyCollection<TransactionSplit>? slices = null, bool keepDepartedDraw = false)
    {
        slices ??= transaction.Splits.ToList();
        var existing = await FindAsync(db, transaction.Id, account.Id, cancellationToken);
        // Jars this leg is recorded as drawing from although they are held elsewhere now: history
        // kept when the jar changed account (KeepLineAttributionAsync).
        var heldThen = existing?.Postings.Where(p => p.JarId is not null).Select(p => p.JarId!.Value).ToHashSet() ?? new HashSet<Guid>();
        var keepsHistory = false;
        var keptJars = new HashSet<Guid>();
        var stretches = JarStretches.None;
        // The account's ledger reads nothing before its opening date, while a departure's share of
        // a kept draw would still count there: a share dated before it is not kept (R2-N2).
        var beforeOpening = account.OpeningDate is { } opened && transaction.Date < opened;
        Guid JarFor(Guid? lineId, IReadOnlyDictionary<Guid, (Guid JarId, Guid AccountId, DateOnly? Since)> lineJars)
        {
            if (lineId is not Guid id || !lineJars.TryGetValue(id, out var line))
            {
                return Guid.Empty;
            }
            if (JarLedgerReader.HeldOn(line.AccountId, line.Since, account.Id, transaction.Date))
            {
                // A payment of this account written down on its unallocated money before the jar
                // arrived here (KeepArrivalAttributionAsync) stays there while it is dated on the
                // day the jar arrived: the reader would now derive it onto the jar (P2-20). Only
                // that write-down (or this branch) stores a leg that draws from no jar; a leg with
                // any stored draw ("paid from" another jar, or one kept from a jar that left) was
                // answered here, so on the jar's line it draws from the jar like any other payment.
                if (existing is not null && heldThen.Count == 0 && line.Since is { } since && transaction.Date <= since)
                {
                    keepsHistory = true;
                    return Guid.Empty;
                }
                return line.JarId;
            }
            if (!beforeOpening
                && (heldThen.Contains(line.JarId)
                    || (account.OpeningDate is not null && stretches.LeftOn(line.JarId, account.Id, transaction.Date) is not null)))
            {
                keepsHistory = true;
                keptJars.Add(line.JarId);
                return line.JarId;
            }
            return Guid.Empty;
        }

        // Portions keyed by jar; Guid.Empty is the portion on no jar line (unallocated by default).
        var portions = new Dictionary<Guid, decimal>();
        if (slices.Count > 0)
        {
            var lineIds = slices.Where(s => s.BudgetItemId is not null).Select(s => s.BudgetItemId!.Value).Distinct().ToList();
            var lineJars = await LineJarsAsync(db, lineIds, cancellationToken);
            stretches = await StretchesAsync(db, lineJars.Values, account.Id, transaction.Date, cancellationToken);
            foreach (var slice in slices)
            {
                var jarId = JarFor(slice.BudgetItemId, lineJars);
                portions[jarId] = portions.GetValueOrDefault(jarId) + slice.Amount;
            }
        }
        else if (transaction.BudgetItemId is Guid lineId)
        {
            var lineJars = await LineJarsAsync(db, new[] { lineId }, cancellationToken);
            stretches = await StretchesAsync(db, lineJars.Values, account.Id, transaction.Date, cancellationToken);
            portions[JarFor(lineId, lineJars)] = transaction.Amount;
        }
        else
        {
            portions[Guid.Empty] = transaction.Amount;
        }

        var unlined = portions.GetValueOrDefault(Guid.Empty);
        // The jar the rest of the payment was drawn from ("which jar?", rule 79) when that jar has
        // since left this account: kept while the edit names it again or leaves the answer out.
        var departedHeld = heldThen.Count == 0 ? new List<Guid>() : await db.Jars.AsNoTracking()
            .Where(j => heldThen.Contains(j.Id) && j.FundingAccountId != account.Id).Select(j => j.Id).ToListAsync(cancellationToken);
        var keptFrom = departedHeld.Where(j => !portions.ContainsKey(j)).Select(j => (Guid?)j).FirstOrDefault();
        var keepsFrom = keepDepartedDraw && keptFrom is Guid k && unlined != 0m && !beforeOpening && (paidFromJarId is null || paidFromJarId == k);
        if (keepsFrom)
        {
            keptJars.Add(keptFrom!.Value);
        }

        // A kept share is history from the stretch the jar was held here: the leg can't move past
        // the day it left, nor (re-dated) before the stretch began, while another account held it.
        var redated = existing is not null && existing.Date != transaction.Date;
        var keptStretches = redated ? await JarStretches.LoadAsync(db, keptJars, cancellationToken) : JarStretches.None;
        foreach (var keptJar in keptJars)
        {
            if (await JarDepartures.CoveringAsync(db, ownerId, keptJar, account.Id, transaction.Date, cancellationToken) is null)
            {
                var name = await db.Jars.AsNoTracking().Where(j => j.Id == keptJar).Select(j => j.Name).FirstAsync(cancellationToken);
                throw JarDepartures.DatedAfterDeparture(name, await JarDepartures.LastAsync(db, keptJar, account.Id, cancellationToken));
            }
            if (keptStretches.HeldElsewhereUntil(keptJar, account.Id, transaction.Date) is { } arrived)
            {
                var name = await db.Jars.AsNoTracking().Where(j => j.Id == keptJar).Select(j => j.Name).FirstAsync(cancellationToken);
                throw JarDepartures.DatedBeforeArrival(name, arrived);
            }
        }

        var postings = new List<JarAllocationPosting>();
        if (keepsFrom)
        {
            portions.Remove(Guid.Empty);
            portions[keptFrom!.Value] = portions.GetValueOrDefault(keptFrom.Value) + unlined;
            postings.AddRange(portions.Where(p => p.Value != 0m).Select(p => new JarAllocationPosting { JarId = p.Key, Amount = -p.Value }));
        }
        else if (paidFromJarId is null && keepsHistory)
        {
            postings.AddRange(portions.Where(p => p.Value != 0m)
                .Select(p => new JarAllocationPosting { JarId = p.Key == Guid.Empty ? null : p.Key, Amount = -p.Value }));
        }
        else if (paidFromJarId is Guid fromId)
        {
            if (unlined == 0m)
            {
                throw Validation(errorKey, "This payment is already on a jar's line; it draws from that jar.");
            }
            portions.Remove(Guid.Empty);
            portions[fromId] = portions.GetValueOrDefault(fromId) + unlined;
            var echoed = existing is not null && existing.Date == transaction.Date && StoredShare(existing, fromId) == -portions[fromId]
                ? heldThen.Where(id => id == fromId).ToHashSet()
                : new HashSet<Guid>();
            var jar = (await OwnJarsAsync(db, ownerId, account, new[] { fromId }, transaction.Date, echoed, errorKey, cancellationToken))[fromId];
            if (jar.IsArchived && !echoed.Contains(fromId))
            {
                throw Validation(errorKey, $"{jar.Name} is archived and holds nothing.");
            }
            postings.AddRange(portions.Select(p => new JarAllocationPosting { JarId = p.Key, Amount = -p.Value }));
        }
        await EnsureArchivedJarsCoverAsync(db, ownerId, transaction,
            portions.Where(p => p.Key != Guid.Empty && p.Value > 0m).ToDictionary(p => p.Key, p => p.Value), errorKey, cancellationToken);
        await ReplaceAsync(db, ownerId, transaction, account.Id, transaction.Date, postings, cancellationToken, existing);
    }

    /// <summary>
    /// An archived jar holds nothing (rule 26) and plans nothing, so a payment on its line may not
    /// push it below zero, as a payment on a live jar's line may (rule 5): it must hold the draw
    /// on the payment's date and on every later date its ledger changes (his 1 Oct answer
    /// "Refuse"). What the stored version of this payment already drew from the jar on a date is
    /// not asked for twice, so an edit that takes no more passes. Checked after the account's
    /// ledger lock is taken, like every other validation of a write.
    /// </summary>
    private static async Task EnsureArchivedJarsCoverAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, IReadOnlyDictionary<Guid, decimal> draws,
        string errorKey, CancellationToken cancellationToken)
    {
        if (await ArchivedJarsRefusalAsync(db, ownerId, transaction, draws, null, cancellationToken) is string refusal)
        {
            throw Validation(errorKey, refusal);
        }
    }

    /// <summary>
    /// The same "Refuse" check for a new bank row an import is about to add (P2-1 of the #301
    /// review): what its line, or its slices' lines, draw from archived jars this account holds on
    /// its date, counting what the import's earlier rows drew from them (<paramref name="earlier"/>,
    /// which a passing row is added to). Returns the refusal, so the import holds the row rather
    /// than failing; null when the row may be added. A row naming a jar it is paid from goes
    /// through <see cref="ApplyOutgoingAsync"/> instead.
    /// </summary>
    public static async Task<string?> ArchivedLineRefusalAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Account account,
        Dictionary<Guid, decimal> earlier, CancellationToken cancellationToken)
    {
        var lined = transaction.Splits.Count > 0
            ? transaction.Splits.Where(s => s.BudgetItemId is not null).Select(s => (Line: s.BudgetItemId!.Value, s.Amount)).ToList()
            : transaction.BudgetItemId is Guid lineId ? new List<(Guid Line, decimal Amount)> { (lineId, transaction.Amount) } : new();
        if (lined.Count == 0)
        {
            return null;
        }
        var lineJars = await LineJarsAsync(db, lined.Select(l => l.Line).Distinct().ToList(), cancellationToken);
        var draws = new Dictionary<Guid, decimal>();
        foreach (var (line, amount) in lined)
        {
            if (lineJars.TryGetValue(line, out var jar) && JarLedgerReader.HeldOn(jar.AccountId, jar.Since, account.Id, transaction.Date))
            {
                draws[jar.JarId] = draws.GetValueOrDefault(jar.JarId) + amount;
            }
        }
        var positive = draws.Where(d => d.Value > 0m).ToDictionary(d => d.Key, d => d.Value);
        if (await ArchivedJarsRefusalAsync(db, ownerId, transaction, positive, earlier, cancellationToken) is string refusal)
        {
            return refusal;
        }
        foreach (var (jarId, draw) in positive)
        {
            earlier[jarId] = earlier.GetValueOrDefault(jarId) + draw;
        }
        return null;
    }

    private static async Task<string?> ArchivedJarsRefusalAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, IReadOnlyDictionary<Guid, decimal> draws,
        IReadOnlyDictionary<Guid, decimal>? earlier, CancellationToken cancellationToken)
    {
        if (draws.Count == 0)
        {
            return null;
        }
        var ids = draws.Keys.ToList();
        var archived = await db.Jars.AsNoTracking()
            .Where(j => ids.Contains(j.Id) && j.IsArchived)
            .ToListAsync(cancellationToken);
        if (archived.Count == 0)
        {
            return null;
        }

        // The ledger without this payment, and as stored (its earlier version, when it is an edit).
        var without = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, excludeTransactionIds: new[] { transaction.Id });
        var stored = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        foreach (var jar in archived)
        {
            var dates = without.OperationDatesAfter(jar.FundingAccountId, transaction.Date)
                .Concat(stored.OperationDatesAfter(jar.FundingAccountId, transaction.Date))
                .Prepend(transaction.Date)
                .Distinct().Order();
            var draw = draws[jar.Id];
            // Unsaved rows of the same import: counted on every date, the cautious reading.
            var drawnEarlier = earlier?.GetValueOrDefault(jar.Id) ?? 0m;
            foreach (var date in dates)
            {
                var held = (without.At(date).BalanceOf(jar.Id) ?? 0m) - drawnEarlier;
                var drawnBefore = Math.Max(0m, held + drawnEarlier - (stored.At(date).BalanceOf(jar.Id) ?? 0m));
                if (draw > Math.Max(0m, held) && draw > drawnBefore)
                {
                    var holds = Math.Max(0m, held);
                    return $"{jar.Name} is archived and holds {holds:0.##}{(date == transaction.Date ? "" : $" on {date:yyyy-MM-dd}")}, "
                        + $"so it can't pay {draw:0.##}. Restore {jar.Name} or put the payment on another line.";
                }
            }
        }
        return null;
    }

    /// <summary>The departures of the line jars <paramref name="accountId"/> did not hold on <paramref name="date"/>; none (and no query) when it held them all.</summary>
    private static Task<JarStretches> StretchesAsync(
        IApplicationDbContext db, IEnumerable<(Guid JarId, Guid AccountId, DateOnly? Since)> lineJars, Guid accountId, DateOnly date,
        CancellationToken cancellationToken)
    {
        var elsewhere = lineJars.Where(l => !JarLedgerReader.HeldOn(l.AccountId, l.Since, accountId, date)).Select(l => l.JarId).ToList();
        return elsewhere.Count == 0 ? Task.FromResult(JarStretches.None) : JarStretches.LoadAsync(db, elsewhere, cancellationToken);
    }

    /// <summary>
    /// Rule 80, before <paramref name="jar"/> is re-designated to another account: every payment
    /// its budget lines drew from its current account (rule 79) is written down as a stored
    /// operation on that account, exactly as the reader derives it today. The derivation looks the
    /// jar up in its current account, so once the jar names another one those payments would fall
    /// to unallocated and the account's history would change though no money moved. Legs that
    /// already carry a stored answer are left alone. Only payments dated on or before
    /// <paramref name="movedOn"/> are kept: a later one was paid while the jar was held elsewhere.
    /// Returns how many were written down. The caller saves.
    /// </summary>
    public static async Task<int> KeepLineAttributionAsync(IApplicationDbContext db, string ownerId, Jar jar, DateOnly movedOn, CancellationToken cancellationToken)
    {
        var account = await db.Accounts.AsNoTracking().FirstOrDefaultAsync(a => a.Id == jar.FundingAccountId, cancellationToken);
        return account is null ? 0 : await KeepAsIsAsync(db, ownerId, jar.Id, account, movedOn, cancellationToken);
    }

    /// <summary>
    /// The mirror of <see cref="KeepLineAttributionAsync"/> for the account <paramref name="jar"/>
    /// is about to join (P2-20): its payments on the jar's lines dated on or before
    /// <paramref name="movedOn"/> were made while the jar was held elsewhere, so they drew from its
    /// unallocated money. They are written down as the reader derives them today, before the jar
    /// names the account, so neither the reader nor a later edit moves them onto the jar. Returns
    /// how many were written down. The caller saves.
    /// </summary>
    public static Task<int> KeepArrivalAttributionAsync(
        IApplicationDbContext db, string ownerId, Jar jar, Account joining, DateOnly movedOn, CancellationToken cancellationToken) =>
        KeepAsIsAsync(db, ownerId, jar.Id, joining, movedOn, cancellationToken);

    private static async Task<int> KeepAsIsAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, Account account, DateOnly upTo, CancellationToken cancellationToken)
    {
        var payments = await UnstoredLinePaymentsAsync(db, ownerId, new[] { jarId }, account.Id, upTo, cancellationToken);
        if (payments.Count == 0)
        {
            return 0;
        }
        var jars = await db.Jars.AsNoTracking().Where(j => j.OwnerId == ownerId).ToDictionaryAsync(j => j.Id, cancellationToken);
        var lineJars = await JarLedgerReader.LineJarsAsync(db, ownerId, cancellationToken);
        WriteDown(db, ownerId, payments, account, lineJars, jars);
        return payments.Count;
    }

    /// <summary>The expenses from <paramref name="accountId"/> on a line of any of <paramref name="jarIds"/> (whole or a slice), dated on or before <paramref name="upTo"/>, that carry no stored answer there.</summary>
    internal static Task<List<Transaction>> UnstoredLinePaymentsAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> jarIds, Guid accountId, DateOnly upTo,
        CancellationToken cancellationToken, DateOnly? after = null) =>
        db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Expense && t.AccountId == accountId
                        && t.Date <= upTo && (after == null || t.Date > after)
                        && !t.JarAllocations.Any(a => a.AccountId == accountId)
                        && ((t.BudgetItem != null && t.BudgetItem.SavingsId != null && jarIds.Contains(t.BudgetItem.SavingsId.Value))
                            || t.Splits.Any(s => s.BudgetItem != null && s.BudgetItem.SavingsId != null && jarIds.Contains(s.BudgetItem.SavingsId.Value))))
            .ToListAsync(cancellationToken);

    /// <summary>
    /// The payments of <paramref name="accountId"/> on <paramref name="jarId"/>'s lines dated after
    /// <paramref name="after"/> that carry no stored leg there: the reader draws them from the jar
    /// on their date (rule 79), so a jar at zero today is not at zero then (JL-P2-1, JL-P2-2).
    /// </summary>
    internal static Task<List<Transaction>> LinePaymentsAfterAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, Guid accountId, DateOnly after, CancellationToken cancellationToken) =>
        UnstoredLinePaymentsAsync(db, ownerId, new[] { jarId }, accountId, DateOnly.MaxValue, cancellationToken, after);

    /// <summary>Stores each payment's leg on <paramref name="account"/> exactly as the reader derives it with <paramref name="jars"/>. Returns the operations added; the caller saves.</summary>
    internal static List<JarAllocation> WriteDown(
        IApplicationDbContext db, string ownerId, IEnumerable<Transaction> payments, Account account,
        IReadOnlyDictionary<Guid, Guid> lineJars, IReadOnlyDictionary<Guid, Jar> jars)
    {
        var added = new List<JarAllocation>();
        foreach (var payment in payments)
        {
            var postings = JarLedgerReader.Derive(payment, account, -payment.Amount, lineJars, jars);
            var operation = new JarAllocation
            {
                OwnerId = ownerId,
                AccountId = account.Id,
                Kind = JarAllocationKind.Movement,
                Date = payment.Date,
                TransactionId = payment.Id,
                CreatedUtc = DateTime.UtcNow,
                Postings = postings.Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount }).ToList(),
            };
            db.JarAllocations.Add(operation);
            added.Add(operation);
        }
        return added;
    }

    /// <summary>
    /// One leg's date moved by a bank statement, its jar answer unchanged (a transfer's departure
    /// or its fee, rule 69). Each jar the leg draws from keeps the draw when the account held the
    /// jar on <paramref name="date"/>: in its current stretch there, or in a recorded one it has
    /// since left (R2-D1), when the account's ledger reads that date. Any other share draws from
    /// unallocated money instead, as a return decided on a bank's date does: the date is the
    /// bank's, so it is not refused. The departures are re-settled (P51).
    /// </summary>
    public static async Task FollowDateAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Guid accountId, DateOnly date, CancellationToken cancellationToken)
    {
        var existing = await FindAsync(db, transaction.Id, accountId, cancellationToken);
        if (existing is null || existing.Date == date)
        {
            return;
        }
        var jarIds = existing.Postings.Where(p => p.JarId is not null && p.Amount != 0m).Select(p => p.JarId!.Value).Distinct().ToList();
        var jars = await db.Jars.AsNoTracking()
            .Where(j => jarIds.Contains(j.Id))
            .Select(j => new { j.Id, j.FundingAccountId, j.FundingAccountSince })
            .ToListAsync(cancellationToken);
        var elsewhere = jars.Where(j => !JarLedgerReader.HeldOn(j.FundingAccountId, j.FundingAccountSince, accountId, date)).Select(j => j.Id).ToList();
        var stretches = elsewhere.Count == 0 ? JarStretches.None : await JarStretches.LoadAsync(db, elsewhere, cancellationToken);
        var read = stretches.OpeningDateOf(accountId) is { } opened && date >= opened;
        var dropped = elsewhere.Where(id => !read || stretches.LeftOn(id, accountId, date) is null).ToHashSet();
        var unallocated = existing.Postings.Where(p => p.JarId is null || dropped.Contains(p.JarId.Value)).Sum(p => p.Amount);
        var postings = existing.Postings
            .Where(p => p.JarId is Guid jarId && !dropped.Contains(jarId))
            .Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount })
            .ToList();
        if (unallocated != 0m || postings.Count == 0)
        {
            postings.Add(new JarAllocationPosting { JarId = null, Amount = unallocated });
        }
        await ReplaceAsync(db, ownerId, transaction, accountId, date, postings, cancellationToken, existing);
    }

    /// <summary>
    /// The day <paramref name="transaction"/>'s leg on <paramref name="accountId"/> posts there; null
    /// while it has none: a receipt still in transit, sent back, or held for its departure.
    /// </summary>
    public static DateOnly? PostsOn(Transaction transaction, Guid accountId) =>
        transaction.Type != TransactionType.Transfer ? transaction.Date
        : transaction.DepartedOn is null ? null
        : transaction.AccountId == accountId ? transaction.DepartedOn
        : transaction.ReturnedOn is null ? transaction.ReceivedOn : null;

    /// <summary>
    /// For a receipt on <paramref name="accountId"/> that a confirmation or a statement posts on
    /// <paramref name="date"/> while keeping its stored answer: a share that answer gives a jar of
    /// the account that is archived (rule 26: it holds nothing), or that only arrived in the
    /// account after <paramref name="date"/> (rule 80, #276 R2-P2-4), goes to the account's
    /// unallocated funds instead. Archiving is refused while
    /// money is on its way to a jar, so an archived jar is named here only by an answer stored
    /// before that refusal (#282 review P2-1, #283 review P2-2).
    /// </summary>
    public static async Task FollowReceiptAsync(
        IApplicationDbContext db, Transaction transaction, Guid accountId, DateOnly date, CancellationToken cancellationToken)
    {
        var existing = await FindAsync(db, transaction.Id, accountId, cancellationToken);
        // Not there, or removed earlier in this request.
        if (existing is null || !db.JarAllocations.Local.Contains(existing))
        {
            return;
        }
        var ids = existing.Postings.Where(p => p.JarId is not null && p.Amount > 0m).Select(p => p.JarId!.Value).ToList();
        var jars = await db.Jars.AsNoTracking()
            .Where(j => ids.Contains(j.Id) && j.FundingAccountId == accountId)
            .ToListAsync(cancellationToken);
        var released = jars
            .Where(j => j.IsArchived || !JarLedgerReader.HeldOn(j.FundingAccountId, j.FundingAccountSince, accountId, date))
            .Select(j => j.Id)
            .ToHashSet();
        if (released.Count == 0)
        {
            return;
        }
        var postings = existing.Postings
            .Where(p => p.JarId is Guid jarId && !released.Contains(jarId))
            .Select(p => new JarAllocationPosting { JarId = p.JarId, Amount = p.Amount })
            .ToList();
        // All of it unallocated is what the reader derives on its own, so nothing is stored then.
        var unallocated = existing.Postings.Sum(p => p.Amount) - postings.Sum(p => p.Amount);
        if (postings.Count > 0 && unallocated != 0m)
        {
            postings.Add(new JarAllocationPosting { JarId = null, Amount = unallocated });
        }
        await ReplaceAsync(db, transaction.OwnerId, transaction, accountId, existing.Date, postings, cancellationToken, existing);
    }

    /// <summary>Drops the stored split of one leg, so the reader falls back to its derived attribution.</summary>
    public static Task ClearAsync(IApplicationDbContext db, Transaction transaction, Guid accountId, CancellationToken cancellationToken) =>
        ReplaceAsync(db, transaction.OwnerId, transaction, accountId, transaction.Date, new List<JarAllocationPosting>(), cancellationToken);

    private static Task<JarAllocation?> FindAsync(IApplicationDbContext db, Guid transactionId, Guid accountId, CancellationToken cancellationToken) =>
        db.JarAllocations
            .Include(a => a.Postings)
            .FirstOrDefaultAsync(a => a.TransactionId == transactionId && a.AccountId == accountId, cancellationToken);

    /// <param name="existing">The leg's stored operation when the caller already loaded it; null loads it.</param>
    private static async Task ReplaceAsync(
        IApplicationDbContext db, string ownerId, Transaction transaction, Guid accountId, DateOnly date,
        List<JarAllocationPosting> postings, CancellationToken cancellationToken, JarAllocation? existing = null)
    {
        existing ??= await FindAsync(db, transaction.Id, accountId, cancellationToken);
        // Rule 80: a change in the share of a jar that has left this account is settled on the
        // departure, so the account still holds nothing of the jar from the day it left.
        await JarDepartures.SettleAsync(db, ownerId, accountId,
            existing?.Date ?? date, existing?.Postings.Select(p => (p.JarId, p.Amount)).ToList() ?? new List<(Guid?, decimal)>(),
            date, postings.Select(p => (p.JarId, p.Amount)).ToList(), cancellationToken);
        if (postings.Count == 0)
        {
            if (existing is not null)
            {
                db.JarAllocations.Remove(existing);
            }
            return;
        }
        if (existing is null)
        {
            var allocation = new JarAllocation
            {
                OwnerId = ownerId,
                AccountId = accountId,
                Kind = JarAllocationKind.Movement,
                Date = date,
                Transaction = transaction,
                CreatedUtc = DateTime.UtcNow,
                Postings = postings,
            };
            transaction.JarAllocations.Add(allocation);
            db.JarAllocations.Add(allocation);
            return;
        }
        // Update in place: the (transaction, account) index is unique, so a delete-and-insert in
        // one SaveChanges would depend on statement ordering. The new postings are added through
        // the set explicitly: discovered only through the navigation, an entity whose Guid key is
        // already set would be tracked as Modified and the save would issue an UPDATE for a row
        // that was never inserted.
        db.JarAllocationPostings.RemoveRange(existing.Postings);
        existing.Postings.Clear();
        existing.Date = date;
        foreach (var posting in postings)
        {
            posting.JarAllocationId = existing.Id;
            posting.JarAllocation = existing;
            existing.Postings.Add(posting);
            db.JarAllocationPostings.Add(posting);
        }
    }

    /// <summary>
    /// The jars an answer names, each held in <paramref name="account"/> on <paramref name="date"/>
    /// (rule 80: from the day it moved there, <see cref="JarLedgerReader.HeldOn"/>; #276 review
    /// R2-P2-4). A jar in <paramref name="echoed"/> is the leg's stored answer sent back unchanged.
    /// </summary>
    private static async Task<Dictionary<Guid, Jar>> OwnJarsAsync(
        IApplicationDbContext db, string ownerId, Account account, IEnumerable<Guid> jarIds, DateOnly date,
        IReadOnlySet<Guid> echoed, string errorKey, CancellationToken cancellationToken)
    {
        var ids = jarIds.Distinct().ToList();
        var jars = await db.Jars.AsNoTracking().Where(j => ids.Contains(j.Id)).ToDictionaryAsync(j => j.Id, cancellationToken);
        foreach (var id in ids)
        {
            if (!jars.TryGetValue(id, out var jar))
            {
                throw new NotFoundException($"Jar {id} was not found.");
            }
            if (jar.OwnerId != ownerId)
            {
                throw new ForbiddenAccessException();
            }
            if (jar.FundingAccountId != account.Id)
            {
                throw Validation(errorKey, $"{jar.Name}'s money is not held in {account.Name}.");
            }
            if (!echoed.Contains(id) && !JarLedgerReader.HeldOn(jar.FundingAccountId, jar.FundingAccountSince, account.Id, date))
            {
                throw Validation(errorKey, ArrivedLater(jar, account));
            }
        }
        return jars;
    }

    /// <summary>Budget line → the jar whose savings line it is, the account that holds the jar now and the day it moved there (rule 79).</summary>
    private static async Task<Dictionary<Guid, (Guid JarId, Guid AccountId, DateOnly? Since)>> LineJarsAsync(
        IApplicationDbContext db, IReadOnlyCollection<Guid> lineIds, CancellationToken cancellationToken)
    {
        if (lineIds.Count == 0)
        {
            return new Dictionary<Guid, (Guid, Guid, DateOnly?)>();
        }
        return await db.BudgetItems
            .AsNoTracking()
            .Where(i => lineIds.Contains(i.Id) && i.SavingsId != null && i.Jar != null)
            .Select(i => new { i.Id, JarId = i.SavingsId!.Value, i.Jar!.FundingAccountId, i.Jar.FundingAccountSince })
            .ToDictionaryAsync(x => x.Id, x => (x.JarId, x.FundingAccountId, x.FundingAccountSince), cancellationToken);
    }

    /// <summary>What <paramref name="existing"/> stored for the jar (a draw is negative).</summary>
    private static decimal StoredShare(JarAllocation? existing, Guid jarId) =>
        existing?.Postings.Where(p => p.JarId == jarId).Sum(p => p.Amount) ?? 0m;

    /// <summary>The refusal for money dated before a jar arrived in the account.</summary>
    internal static string ArrivedLater(Jar jar, Account account) =>
        $"{jar.Name} has been in {account.Name} only since {jar.FundingAccountSince:d MMM yyyy}, so money dated before then can't go into or come out of it there. "
        + $"To put earlier money in {jar.Name}, record it without the jar and use Move money dated {jar.FundingAccountSince:d MMM yyyy} or later.";

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
