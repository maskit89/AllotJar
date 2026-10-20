using System.Linq.Expressions;
using System.Reflection;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Common;
using AllotJar.Domain.Services;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Masks any card number already stored in a <see cref="MaskCardNumbersAttribute"/> text, written
/// before every save masked them (compliance fix 12). Runs on startup after migrations. Idempotent:
/// masked text has nothing left to mask, so a second run changes nothing. On SQL Server only rows
/// whose text holds at least 13 digits are read, the fewest a card number has. Bank references
/// are never touched, so import duplicate detection and transfer matching read exactly as before.
/// </summary>
public static class CardNumberBackfill
{
    /// <summary>13 digits, anything between them: the cheapest test that can rule a text out.</summary>
    private static readonly string ThirteenDigits = "%" + string.Concat(Enumerable.Repeat("[0-9]%", 13));

    private static readonly MethodInfo MaskSetMethod =
        typeof(CardNumberBackfill).GetMethod(nameof(MaskSetAsync), BindingFlags.NonPublic | BindingFlags.Static)!;

    /// <summary>Masks every stored text that holds a card number; returns how many texts changed.</summary>
    public static async Task<int> BackfillAsync(ApplicationDbContext db, CancellationToken ct = default)
    {
        var changed = 0;
        foreach (var type in db.Model.GetEntityTypes().Select(t => t.ClrType).Distinct())
        {
            var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.PropertyType == typeof(string) && p.IsDefined(typeof(MaskCardNumbersAttribute), true))
                .Select(p => p.Name)
                .ToArray();
            if (properties.Length == 0)
            {
                continue;
            }
            changed += await (Task<int>)MaskSetMethod.MakeGenericMethod(type).Invoke(null, [db, properties, ct])!;
        }
        return changed;
    }

    private static async Task<int> MaskSetAsync<T>(ApplicationDbContext db, string[] properties, CancellationToken ct)
        where T : class
    {
        IQueryable<T> rows = db.Set<T>().IgnoreQueryFilters();
        if (db.Database.IsSqlServer())
        {
            rows = rows.Where(MayHoldCardNumber<T>(properties));
        }

        var changed = 0;
        foreach (var row in await rows.ToListAsync(ct))
        {
            var entry = db.Entry(row);
            foreach (var name in properties)
            {
                var property = entry.Property(name);
                if (property.CurrentValue is string text && CardNumberMask.Mask(text) is var masked
                    && !ReferenceEquals(masked, text))
                {
                    property.CurrentValue = masked;
                    changed++;
                }
            }
        }
        if (changed > 0)
        {
            await db.SaveChangesAsync(ct);
        }
        db.ChangeTracker.Clear();
        return changed;
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
