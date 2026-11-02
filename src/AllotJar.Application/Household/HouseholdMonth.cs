namespace AllotJar.Application.Household;

/// <summary>
/// The month a People figure is read for: the caller's selected month, else the current UTC month
/// (of <paramref name="today"/> when the caller passes its clock's date).
/// </summary>
public static class HouseholdMonth
{
    public static (int Year, int Month) Resolve(int? year, int? month, DateOnly? today = null)
    {
        if (year is int y && month is int m)
        {
            return (y, m);
        }
        var now = today ?? DateOnly.FromDateTime(DateTime.UtcNow);
        return (now.Year, now.Month);
    }
}
