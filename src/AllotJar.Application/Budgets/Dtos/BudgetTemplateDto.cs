using AllotJar.Application.Budgets.Templates;

namespace AllotJar.Application.Budgets.Dtos;

public class BudgetTemplateDto
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public List<BudgetTemplateGroupDto> Groups { get; set; } = new();
}

public class BudgetTemplateGroupDto
{
    public string Name { get; set; } = string.Empty;
    public string Kind { get; set; } = "Expense";
    public List<string> Lines { get; set; } = new();
}

public static class BudgetTemplateMapping
{
    public static BudgetTemplateDto ToDto(this BudgetTemplate t) => new()
    {
        Key = t.Key,
        Name = t.Name,
        Description = t.Description,
        Groups = t.Groups
            .Select(g => new BudgetTemplateGroupDto
            {
                Name = g.Name,
                Kind = g.Kind.ToString(),
                Lines = g.Lines.ToList(),
            })
            .ToList(),
    };
}
