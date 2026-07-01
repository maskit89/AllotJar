using System.Reflection;
using MediatR;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Common.Security;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Common.Behaviours;

/// <summary>
/// Enforces the caller's <see cref="HouseholdRole"/> on every request before it reaches the
/// handler. Reads (requests whose type name ends in "Query") are allowed for all roles. Writes
/// (".. Command") require Admin by default; <see cref="AllowLimitedAttribute"/> opens a command
/// to Limited logins, and <see cref="OwnerOnlyAttribute"/> restricts it to the Owner. When no
/// role is resolved (e.g. the request never went through the API middleware) enforcement is
/// skipped — data is still protected by the per-request OwnerId scoping in each handler.
/// </summary>
public class AuthorizationBehaviour<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    private readonly ICurrentUser _currentUser;

    public AuthorizationBehaviour(ICurrentUser currentUser)
    {
        _currentUser = currentUser;
    }

    public Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken cancellationToken)
    {
        var role = _currentUser.Role;
        if (role is null)
        {
            return next();
        }

        var type = typeof(TRequest);
        var isCommand = type.Name.EndsWith("Command", StringComparison.Ordinal);
        if (isCommand && !IsPermitted(role.Value, type))
        {
            throw new ForbiddenAccessException(
                $"Your access level ({role}) does not permit this action.");
        }

        return next();
    }

    private static bool IsPermitted(HouseholdRole role, Type commandType)
    {
        var ownerOnly = commandType.GetCustomAttribute<OwnerOnlyAttribute>() is not null;
        var allowLimited = commandType.GetCustomAttribute<AllowLimitedAttribute>() is not null;

        return role switch
        {
            HouseholdRole.Owner => true,
            HouseholdRole.Admin => !ownerOnly,
            HouseholdRole.Limited => !ownerOnly && allowLimited,
            HouseholdRole.ReadOnly => false,
            _ => false,
        };
    }
}
