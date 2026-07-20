using FluentValidation;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.CreateTransaction;

public class CreateTransactionCommandValidator : AbstractValidator<CreateTransactionCommand>
{
    public CreateTransactionCommandValidator()
    {
        RuleFor(x => x.Amount)
            .GreaterThan(0m)
            .WithMessage("Enter an amount greater than zero.")
            .LessThanOrEqualTo(99_999_999_999_999.9999m)
            .WithMessage("Amount exceeds the supported range.");

        RuleFor(x => x.Payee)
            .MaximumLength(200);

        // Only income and expense may be entered directly. A transfer moves money
        // between two accounts and must go through CreateTransfer, which records both
        // legs; a bare Type=Transfer here would leave a destination-less transfer that
        // makes money vanish from the derived account balances.
        RuleFor(x => x.Type)
            .IsInEnum()
            .Must(t => t != TransactionType.Transfer)
            .WithMessage("Use the transfer action to move money between accounts.");

        // Create-with-splits mirrors SplitTransactionCommandValidator, plus the rule
        // that a split transaction carries no whole-transaction attribution.
        When(x => x.Splits is not null, () =>
        {
            RuleFor(x => x.Splits!)
                .Must(s => s.Count >= 2)
                .WithMessage("A split needs at least two lines.");

            RuleFor(x => x.BudgetItemId)
                .Null()
                .WithMessage("A split transaction cannot also have a whole-transaction category.");

            RuleFor(x => x.MemberId)
                .Null()
                .WithMessage("On a split transaction, attribute members on the split lines instead.");

            RuleForEach(x => x.Splits!).ChildRules(a =>
            {
                a.RuleFor(x => x.BudgetItemId)
                    .NotEmpty()
                    .WithMessage("Choose a budget line for every split line.");

                a.RuleFor(x => x.Amount)
                    .GreaterThan(0m)
                    .WithMessage("Each split line needs an amount greater than zero.")
                    .LessThanOrEqualTo(99_999_999_999_999.9999m)
                    .WithMessage("Amount exceeds the supported range.");
            });
        });
    }
}
