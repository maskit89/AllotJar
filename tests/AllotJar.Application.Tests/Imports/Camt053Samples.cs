namespace AllotJar.Application.Tests.Imports;

/// <summary>Realistic CAMT.053 fixtures for the import tests.</summary>
public static class Camt053Samples
{
    // Three entries: a EUR debit (rent), a EUR credit (salary), and a GBP debit
    // (taxi) whose reference comes from EndToEndId rather than AcctSvcrRef.
    public const string ThreeEntries = """
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
          <BkToCstmrStmt>
            <Stmt>
              <Id>STMT-2026-06</Id>
              <Acct>
                <Id><IBAN>DE89370400440532013000</IBAN></Id>
                <Ccy>EUR</Ccy>
              </Acct>
              <Ntry>
                <Amt Ccy="EUR">1100.00</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <Sts>BOOK</Sts>
                <BookgDt><Dt>2026-06-01</Dt></BookgDt>
                <AcctSvcrRef>REF-RENT-001</AcctSvcrRef>
                <NtryDtls><TxDtls>
                  <RltdPties><Cdtr><Nm>Landlord GmbH</Nm></Cdtr></RltdPties>
                  <RmtInf><Ustrd>June rent</Ustrd></RmtInf>
                </TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="EUR">3000.00</Amt>
                <CdtDbtInd>CRDT</CdtDbtInd>
                <BookgDt><Dt>2026-06-02</Dt></BookgDt>
                <AcctSvcrRef>REF-SALARY-001</AcctSvcrRef>
                <NtryDtls><TxDtls>
                  <RltdPties><Dbtr><Nm>ACME Payroll</Nm></Dbtr></RltdPties>
                </TxDtls></NtryDtls>
              </Ntry>
              <Ntry>
                <Amt Ccy="GBP">45.50</Amt>
                <CdtDbtInd>DBIT</CdtDbtInd>
                <BookgDt><Dt>2026-06-03</Dt></BookgDt>
                <NtryDtls><TxDtls>
                  <Refs><EndToEndId>E2E-TAXI-9</EndToEndId></Refs>
                  <RltdPties><Cdtr><Nm>London Cab</Nm></Cdtr></RltdPties>
                  <RmtInf><Ustrd>Taxi</Ustrd></RmtInf>
                </TxDtls></NtryDtls>
              </Ntry>
            </Stmt>
          </BkToCstmrStmt>
        </Document>
        """;
}
