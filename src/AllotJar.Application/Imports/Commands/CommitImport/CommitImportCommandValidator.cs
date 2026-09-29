using FluentValidation;
using AllotJar.Application.Jars;

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

            item.RuleFor(i => i.JarAllocations).JarAllocationsWellFormed();
            item.RuleFor(i => i.JarAllocations)
                .Must((i, list) => list is not { Count: > 0 } || i.IsCredit)
                .WithMessage("Only money received can be divided among jars.");
            item.RuleFor(i => i.PaidFromJarId)
                .Must((i, jar) => jar is null || !i.IsCredit)
                .WithMessage("Only money paid out can come from a jar.");

            // A transfer is its own thing — it can't also be split across budget lines.
            item.RuleFor(i => i)
                .Must(i => i.Splits is null || i.Splits.Count == 0)
                .When(i => i.TransferAccountId is not null)
                .WithMessage("A transfer can't also be split.");

            // Confirming the other side of a recorded transfer is a transfer decision: the row names
            // the counterparty the candidate names, or leaves it to the transfer (a side private to
            // another login has no id this login receives, P57).
            item.RuleFor(i => i)
                .Must(i => i.BudgetItemId is null && i.MemberId is null && i.Splits is not { Count: > 0 })
                .When(i => i.MatchTransferId is not null)
                .WithMessage("A row that confirms a recorded transfer is that transfer: it takes no budget line, person or split.");

            // A fee is part of a transfer: a debit recorded as one, or a match that states it. A
            // fee confirmed here always names the line it is spent from (O1 answer 5, rule 91).
            item.RuleFor(i => i.Fee)
                .GreaterThan(0m).WithMessage("A fee must be greater than zero.")
                .When(i => i.Fee.HasValue);
            item.RuleFor(i => i.FeeBudgetItemId)
                .NotNull()
                .When(i => i.Fee is > 0m)
                .WithMessage("Choose the budget line the transfer's fee is spent from.");
            item.RuleFor(i => i.Fee)
                .Must((i, fee) => i.MatchTransferId is not null || (i.TransferAccountId is not null && !i.IsCredit))
                .When(i => i.Fee.HasValue)
                .WithMessage("Only a transfer can carry a fee: a payment out recorded as a transfer, or a match that states it.");
            item.RuleFor(i => i.Fee)
                .Must((i, fee) => fee < i.Amount)
                .When(i => i.Fee.HasValue && i.MatchTransferId is null)
                .WithMessage("The fee must be less than the amount that left the account.");
            item.RuleFor(i => i.FeeBudgetItemId)
                .Null()
                .When(i => i.Fee is not > 0m)
                .WithMessage("Choose a line for the fee only when there is a fee.");

            // A returned transfer is confirmed on its own: no line, member, split, jar answer or other transfer.
            item.RuleFor(i => i)
                .Must(i => i.IsCredit && i.TransferAccountId is null && i.MatchTransferId is null
                           && i.BudgetItemId is null && i.MemberId is null && i.Splits is not { Count: > 0 }
                           && i.JarAllocations is not { Count: > 0 } && i.Fee is null)
                .When(i => i.ReturnOfTransferId is not null)
                .WithMessage("Money coming back from a transfer is confirmed on its own, as money received with nothing else chosen.");
        });

        // Transfers need to know which account the statement belongs to.
        RuleFor(x => x)
            .Must(c => c.AccountId is not null || c.Items.All(i => i.TransferAccountId is null))
            .WithMessage("Choose the account this import belongs to before marking rows as transfers.");
    }
}
