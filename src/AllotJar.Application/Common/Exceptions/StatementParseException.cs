namespace AllotJar.Application.Common.Exceptions;

/// <summary>
/// Thrown when a statement document is well-formed as a request but cannot be
/// parsed into entries (mapped to HTTP 422 Unprocessable Entity).
/// </summary>
public class StatementParseException : Exception
{
    public StatementParseException(string message) : base(message) { }
    public StatementParseException(string message, Exception inner) : base(message, inner) { }
}
