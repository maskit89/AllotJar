using ClosedXML.Excel;

namespace AllotJar.Importer;

/// <summary>
/// Opens the workbook tolerantly: it copies the bytes through a shared read so the tool
/// still works while the file is open in Excel (ClosedXML's own file open takes an
/// exclusive lock and would otherwise fail with a sharing violation).
/// </summary>
internal static class Workbook
{
    public static XLWorkbook Open(string file)
    {
        using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var ms = new MemoryStream();
        fs.CopyTo(ms);
        ms.Position = 0;
        return new XLWorkbook(ms);
    }
}
