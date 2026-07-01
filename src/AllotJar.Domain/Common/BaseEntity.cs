namespace AllotJar.Domain.Common;

/// <summary>
/// Base type for all persisted aggregate roots / entities.
/// A GUID surrogate key is used so the client can generate ids and so
/// keys are non-sequential (avoids enumeration of other users' resources).
/// </summary>
public abstract class BaseEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
}
