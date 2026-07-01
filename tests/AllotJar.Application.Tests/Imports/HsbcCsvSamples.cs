namespace AllotJar.Application.Tests.Imports;

/// <summary>Realistic HSBC transaction-history CSV fixtures for the import tests.</summary>
public static class HsbcCsvSamples
{
    // Six bookable rows exercising every quirk, plus a blank line and a header-ish line that
    // must be skipped (first column isn't a dd/MM/yyyy date):
    //   1. standard debit with the " * " separator
    //   2. debit with NO separator before the date
    //   3. "*" inside the merchant name (PAYPAL *TEMU) AND the separator
    //   4. doubled "*" inside the merchant (REVOLUT**0573*)
    //   5. a positive credit (E-BANKING PAYMENT)
    //   6. a quoted row whose amount carries a thousands separator (-1,770.00)
    public const string Mixed = """
        19/06/2026,AUTOMARKET SER STATION  * 17/06/2026 •••• •••• •••• 7406 -35.00 EUR,-35.00
        17/06/2026,PLANET PLAY RESTAURA 15/06/2026 •••• •••• •••• 7406 -67.75 EUR,-67.75
        15/06/2026,PAYPAL *TEMU            * 13/06/2026 •••• •••• •••• 7406 -4.29 EUR,-4.29
        17/06/2026,REVOLUT**0573*          * 16/06/2026 •••• •••• •••• 7406 -180.00 EUR,-180.00
        16/06/2026,E-BANKING PAYMENT       * 16/06/2026 •••• •••• •••• 7406 234.24 EUR,234.24
        27/05/2026,"4 PILLARS               * 26/05/2026 •••• •••• •••• 7406 -1,770.00 EUR","-1,770.00"

        Date,Details,Amount
        """;

    // Four genuinely separate, identical charges on the same day — the dedup edge case.
    // The parser must emit four distinct references (#0..#3), not collapse them to one.
    public const string FourIdenticalCharges = """
        03/06/2026,PAYPAL * MALTAINSTIT    * 02/06/2026 •••• •••• •••• 7406 -40.00 EUR,-40.00
        03/06/2026,PAYPAL * MALTAINSTIT    * 02/06/2026 •••• •••• •••• 7406 -40.00 EUR,-40.00
        03/06/2026,PAYPAL * MALTAINSTIT    * 02/06/2026 •••• •••• •••• 7406 -40.00 EUR,-40.00
        03/06/2026,PAYPAL * MALTAINSTIT    * 02/06/2026 •••• •••• •••• 7406 -40.00 EUR,-40.00
        """;
}
