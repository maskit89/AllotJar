using FluentValidation;

namespace AllotJar.Application.Imports.Commands.CommitImport;

public class CommitImportCommandValidator : AbstractValidator<CommitImportCommand>
{
    public CommitImportCommandValidator()
    {
        RuleFor(x => x.Items).NotNull();

        RuleForEach(x => x.Items).ChildRules(item =>
        {
            item.RuleFor(i => i.Amount)
                .GreaterThan(0).WithMessage("Every imported amount must be greater than zero.");
            item.RuleFor(i => i.Currency)
                .NotEmpty().Length(3).WithMessage("Currency must be a 3-letter ISO code.");
            item.RuleFor(i => i.Payee)
                .MaximumLength(200);

            // When a row is split, it needs at least two slices that add up to its amount.
            item.RuleFor(i => i.Splits!)
                .Must(s => s.Count >= 2).WithMessage("A split needs at least two lines.")
                .Must((i, s) => s.Sum(x => x.Amount) == i.Amount)
                .WithMessage("Split lines must add up to the transaction amount.")
                .When(i => i.Splits is not null);

            item.RuleForEach(i => i.Splits!).ChildRules(slice =>
            {
                slice.RuleFor(s => s.BudgetItemId)
                    .NotEmpty().WithMessage("Choose a budget line for every split line.");
                slice.RuleFor(s => s.Amount)
                    .GreaterThan(0).WithMessage("Each split line needs an amount greater than zero.");
            }).When(i => i.Splits is not null);

            // A transfer is its own thing — it can't also be split across budget lines.
            item.RuleFor(i => i)
                .Must(i => i.Splits is null || i.Splits.Count == 0)
                .When(i => i.TransferAccountId is not null)
                .WithMessage("A transfer can't also be split.");

            // Confirming the other side of a recorded transfer is a transfer decision: the row must
            // be marked as one, with the counterparty the candidate names.
            item.RuleFor(i => i.TransferAccountId)
                .NotNull()
                .When(i => i.MatchTransferId is not null)
                .WithMessage("Mark the row as a transfer and choose its account before matching it to a recorded transfer.");
        });

        // Transfers need to know which account the statement belongs to.
        RuleFor(x => x)
            .Must(c => c.AccountId is not null || c.Items.All(i => i.TransferAccountId is null))
            .WithMessage("Choose the account this import belongs to before marking rows as transfers.");
    }
}
