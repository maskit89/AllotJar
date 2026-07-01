namespace AllotJar.Application.Common.Exceptions;

/// <summary>Thrown when a requested resource does not exist (mapped to HTTP 404).</summary>
public class NotFoundException : Exception
{
    public NotFoundException(string message) : base(message) { }
}
