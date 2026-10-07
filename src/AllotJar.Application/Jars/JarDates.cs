namespace AllotJar.Application.Jars;

/// <summary>How a jar's date reads in a message.</summary>
public static class JarDates
{
    /// <summary>"Mar 2027" for a date given as just a month (<see cref="Domain.Entities.Jar.MonthOnly"/>, always the 1st), otherwise "1 Mar 2027".</summary>
    public static string Show(DateOnly date, bool monthOnly) =>
        monthOnly && date.Day == 1 ? date.ToString("MMM yyyy") : date.ToString("d MMM yyyy");

    /// <inheritdoc cref="Show(DateOnly, bool)"/>
    public static string Show(DateOnly? date, bool monthOnly) => date is { } d ? Show(d, monthOnly) : string.Empty;
}
