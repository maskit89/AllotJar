using MediatR;

namespace AllotJar.Application.Accounts.Commands.DeleteAccount;

/// <summary>Deletes an account; its transactions survive but become unlinked.</summary>
public record DeleteAccountCommand(Guid Id) : IRequest;
