namespace AllotJar.Application.Common.Exceptions;

/// <summary>
/// Aggregates FluentValidation failures into a single exception that the API
/// surfaces as an HTTP 400 with a field -> messages dictionary.
/// </summary>
public class ValidationException : Exception
{
    public ValidationException()
        : base("One or more validation failures have occurred.")
    {
        Errors = new Dictionary<string, string[]>();
    }

    public ValidationException(IDictionary<string, string[]> errors) : this()
    {
        Errors = errors;
    }

    public IDictionary<string, string[]> Errors { get; }
}
