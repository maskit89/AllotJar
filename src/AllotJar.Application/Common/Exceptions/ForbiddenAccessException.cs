namespace AllotJar.Application.Common.Exceptions;

/// <summary>
/// Thrown when an authenticated user tries to touch data they do not own
/// (mapped to HTTP 403). This is the second line of defence behind the
/// owner-scoped queries — ownership is always re-checked in the handler.
/// </summary>
public class ForbiddenAccessException : Exception
{
    public ForbiddenAccessException(string message = "You do not have access to this resource.")
        : base(message) { }
}
