namespace AllotJar.Application.Common.Exceptions;

/// <summary>
/// Thrown when an edit form saves a record someone else changed after the form loaded it (D11);
/// mapped to HTTP 409 so the form reloads the record instead of overwriting the other change.
/// </summary>
public class EditConflictException : Exception
{
    public const string Reason = "Someone else changed this. Reload and try again.";

    public EditConflictException() : base(Reason) { }
}
