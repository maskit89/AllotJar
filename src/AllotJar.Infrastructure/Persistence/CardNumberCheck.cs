using System.Linq.Expressions;
using System.Reflection;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Services;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Finds card numbers stored before compliance fix 12 masked them on every save, and only reports
/// them: the ids of the rows, never their text. It changes nothing, because masking is for good
/// and a long number that happens to look like a card (a reference that fits a scheme's prefix,
/// length and Luhn check) would lose its digits with no way back but a backup. What to do with a
/// row it names is the owner's call. Runs on startup after migrations. Reads in pages by id; on
/// SQL Server only rows whose text holds at least 13 digits, the fewest a card number has.
/// </summary>
public static class CardNumberCheck
{
    private const int PageSize = 500;

    /// <summary>13 digits, anything between them: the cheapest test that can rule a text out.</summary>
    private static readonly string ThirteenDigits = "%" + string.Concat(Enumerable.Repeat("[0-9]%", 13));

    /// <summary>Fields that are not free text but are checked too: a card typed as an account number.</summary>
    private static readonly (Type Type, string Property)[] AlsoChecked = [(typeof(Account), nameof(Account.AccountNumber))];

    private static readonly MethodInfo FindInSetMethod =
        typeof(CardNumberCheck).GetMethod(nameof(FindInSetAsync), BindingFlags.NonPublic | BindingFlags.Static)!;

    /// <summary>The rows holding a card number, by table name.</summary>
    public static async Task<IReadOnlyDictionary<string, IReadOnlyList<Guid>>> FindAsync(
        ApplicationDbContext db, CancellationToken ct = default)
    {
        var found = new Dictionary<string, IReadOnlyList<Guid>>();
        foreach (var entityType in db.Model.GetEntityTypes().Where(t => typeof(BaseEntity).IsAssignableFrom(t.ClrType)))
        {
            var type = entityType.ClrType;
            var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.PropertyType == typeof(string) && p.IsDefined(typeof(MaskCardNumbersAttribute), true))
                .Select(p => p.Name)
                .Concat(AlsoChecked.Where(a => a.Type == type).Select(a => a.Property))
                .ToArray();
            if (properties.Length == 0)
            {
                continue;
            }
            var ids = await (Task<List<Guid>>)FindInSetMethod.MakeGenericMethod(type).Invoke(null, [db, properties, ct])!;
            if (ids.Count > 0)
            {
                found[entityType.GetTableName() ?? type.Name] = ids;
            }
        }
        return found;
    }

    private static async Task<List<Guid>> FindInSetAsync<T>(ApplicationDbContext db, string[] properties, CancellationToken ct)
        where T : BaseEntity
    {
        IQueryable<T> rows = db.Set<T>().IgnoreQueryFilters().AsNoTracking();
        // An encrypted column (Account's bank details, compliance fix 10) holds ciphertext in SQL, so
        // LIKE cannot see its digits: such a table is read whole and checked after decryption.
        var entityType = db.Model.FindEntityType(typeof(T))!;
        var encrypted = properties.Any(p => entityType.FindProperty(p)?.GetValueConverter() is not null);
        if (db.Database.IsSqlServer() && !encrypted)
        {
            rows = rows.Where(MayHoldCardNumber<T>(properties));
        }
        var getters = properties.Select(p => typeof(T).GetProperty(p)!).ToArray();

        var ids = new List<Guid>();
        Guid? after = null;
        while (true)
        {
            var page = await (after is Guid last ? rows.Where(r => r.Id.CompareTo(last) > 0) : rows)
                .OrderBy(r => r.Id)
                .Take(PageSize)
                .ToListAsync(ct);
            foreach (var row in page)
            {
                if (getters.Any(g => g.GetValue(row) is string text
                                     && (CardNumberMask.HasCardNumber(text) || CardNumberMask.IsCardNumber(text))))
                {
                    ids.Add(row.Id);
                }
            }
            if (page.Count < PageSize)
            {
                return ids;
            }
            after = page[^1].Id;
        }
    }

    /// <summary><c>row => LIKE(row.A, pattern) || LIKE(row.B, pattern) || ...</c></summary>
    private static Expression<Func<T, bool>> MayHoldCardNumber<T>(string[] properties)
    {
        var row = Expression.Parameter(typeof(T), "row");
        var like = typeof(DbFunctionsExtensions).GetMethod(
            nameof(DbFunctionsExtensions.Like), [typeof(DbFunctions), typeof(string), typeof(string)])!;
        var tests = properties.Select(name => (Expression)Expression.Call(like,
            Expression.Constant(EF.Functions), Expression.Property(row, name), Expression.Constant(ThirteenDigits)));
        return Expression.Lambda<Func<T, bool>>(tests.Aggregate(Expression.OrElse), row);
    }
}
