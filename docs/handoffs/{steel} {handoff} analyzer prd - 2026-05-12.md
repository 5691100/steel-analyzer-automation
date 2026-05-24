# Steel Analyzer PRD / Handoff

> Status: historical operating context imported into the canonical Steel Analyzer
> automation repo on 2026-05-24. Legacy absolute paths in this document are
> retained for traceability only. The current source of truth for Drive
> automation is this repository and `agent-core/scripts/steel-drive.mjs`.
> Do not use legacy `/root` archive paths as the current implementation source.

Date: 2026-05-12  
Historical canonical rule file: `/root/agent-core/agents/{core} {agent} steel analyzer - 2026-05-09.md`

Current automation source of truth:

- GitHub repo: `5691100/steel-analyzer-automation`
- Local checkout: `/root/workspace/projects/steel-analyzer-automation`
- Drive utility: `agent-core/scripts/steel-drive.mjs`
- Critical rule: no n8n on the Steel Drive critical path

## Purpose

The Steel Analyzer agent produces procurement-ready steel reports from project documentation:

- BoM
- Material List
- Description

The outputs are used for supplier ordering and subcontractor offer requests, so they must be concise, traceable, and based on the strongest available source evidence.

## Primary Deliverables

### BoM

Procurement summary by profile type/grade.

Required totals:

- total length
- total weight
- total painting area

For multi-part projects, use separate tabs by subproject/building/documentation package plus a consolidated `TOTAL BoM`.

### Material List

Procurement basis behind the BoM.

Rows should include where extractable:

- Subproject
- Category
- Assembly No.
- Part No.
- Profile
- Steel Grade
- Qty
- Length
- Total Length
- Weight
- Paint Area
- Source

When grouped by profile, subtotals must appear in the same tab immediately after each profile group as `SUBTOTAL [PROFILE]`. Summary tabs may be added, but cannot replace in-tab subtotals.

### Description

Wider project understanding and scope breakdown.

Should include:

- project/subproject summaries
- category summary
- coating requirements
- source/reconciliation sheets
- excluded scope when relevant
- category detail sheets where available

Main steel should be split where possible into beams, columns, trusses, braces. Additions such as gratings, steps, load-bearing profiles, and sandwich panels should be tracked separately.

## Core Workflow

1. Read shared steel index:
   `/root/CODEXCLAW/obsidian-vault/projects/steel/steel-analyzer-results-index.md`

2. Download/stage source files.

3. Extract PDF text with:
   `pdftotext -layout`

4. Build source inventory before calculation:
   - reports: material lists, assembly lists, part lists, manufacturing summaries
   - drawings: assembly, part, overview drawings
   - specifications: coating, corrosion, execution class, delivery/scope notes
   - models: IFC/Tekla exports
   - correspondence: email/message scope, exclusions, coating, delivery

5. Select source of truth.

6. Identify material decisions and ask questions before finalizing when evidence is not enough.

7. Generate workbooks.

8. Validate Excel integrity.

9. Upload to Drive and verify by download-back MD5 where possible.

10. Update shared delivery log/index.

## Source Of Truth Rules

Reports and manufacturing summaries are first source of truth when complete and current for the affected scope.

Material-list detection terms:

- `Materiallista`
- `Material List`
- `MATERIALLISTA`
- `TEKLA STRUCTURES MATERIAL LIST`
- equivalent columns: `Size / Grade / Qty / Length / Area / Weight`

If a complete material-list report exists, use it first for profile-level subtotals.

Do not silently replace a complete material-list report with detail rows. Use part/detail/assembly lists to explain, expand, and reconcile.

Do not let partial, superseded, or scope-limited reports override better source reports.

Separate:

- quantitative source-of-truth: length, weight, area totals
- classification source-of-truth: categories, assemblies, scope, exclusions

A material list can control quantities while assembly lists/drawings control categories and assembly mapping.

## Assembly Mapping Rules

For every Material List detail row, include part number and assembly number when extractable.

Priority:

1. Use `Part in Mark`, assembly-part, or equivalent reports when available.
2. If no such report exists, use assembly drawings.
3. If assembly drawing extraction is incomplete, use reliable extracted rows for classification/traceability while keeping controlling quantities from the best source report.

Assembly drawings should be parsed for:

- assembly mark
- part number
- profile
- material/grade
- quantity
- length
- weight
- painting area
- source page/line

PDF text may split one table row across multiple lines or mix drawing labels with table text. Validate extracted rows against printed assembly totals before using them for procurement exclusion, category split, or reconciliation.

If extraction gaps materially affect outputs, ask the user with 3 options.

If `Assembly No.` or `Part No.` cannot be extracted, mark it explicitly as missing/unknown.

## No Silent Decisions

The agent must not make silent material decisions.

Material decisions include anything affecting:

- scope
- totals
- quantities
- weights
- painting area
- coating split
- categories
- source priority
- inclusion/exclusion
- workbook structure
- procurement output

Before asking, the agent should first check available evidence:

- project files
- source inventory
- shared index / prior deliveries
- active rule
- reference appendix
- local Dlubal archive
- Dlubal source if needed

If uncertainty remains, ask a direct question with exactly 3 practical options and mark a recommended option where evidence supports it.

## Missing Values

If weight or painting area is missing, search in this order:

1. Assembly drawings and part drawings.
2. Local Dlubal archive:
   `/root/CODEXCLAW/obsidian-vault/projects/steel/steel-profile-am-dlubal-archive.csv`
3. Dlubal cross-section properties:
   `https://www.dlubal.com/en/cross-section-properties/`
4. Calculation fallback only if no source value exists.

Do not add calculated fallback values to the Dlubal archive.

For Swedish hollow sections:

- `KKR` = EN 10219 cold-formed/cold-rolled
- `VKR` = EN 10210 hot-finished/hot-rolled

Document the selected standard when it affects dimensions, weight, or painting area.

## Scope Rules

Include standard profiles, plates, structural elements, checker plate, railings, and stair structure unless source/user scope says otherwise.

Exclude reference/zero-quantity items.

If correspondence or project instruction suggests some category may be purchased by others or excluded from procurement, ask before finalizing BoM and Material List unless the instruction is explicit and current.

When exclusion is confirmed:

- exclude it from BoM and Material List procurement totals
- keep it visible in Description summary/reconciliation

Gratings:

- exclude weight from steel total
- calculate covered plan area `L x W`
- do not calculate paint area

Stair treads/steps:

- exclude weight
- count pieces
- report dimensions only

Flag oversize:

- length over `13.7 m`
- width over `2.4 m`

## Nordic A-jaur Lessons

Project Drive folder:
`1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5`

Subprojects:

- Skärmtak
- Ombyggnad

Key issue found:

Skärmtak `Bilaga 1 Ståldokumentation.pdf` contained the controlling Tekla material list. The first pass used single-part drawings instead, which missed the stronger material-list source. The corrected process uses:

- Skärmtak `Bilaga 1`: controlling profile totals
- Skärmtak `Bilaga 3`: assembly drawing part mapping and truss exclusion evidence
- Ombyggnad `Bilaga 1`: Part-in-Mark style report / assembly-part mapping basis

User decisions during restarted evaluation:

1. Exclude Skärmtak trusses from BoM and Material List procurement totals, keep them visible in Description.
2. Use Skärmtak assembly drawings to map extractable parts/assemblies.
3. Leave Ombyggnad basis unchanged.

v3 procurement totals:

| Scope | Weight | Paint area |
|---|---:|---:|
| Skärmtak procurement, trusses excluded | 28.211 t | 740.700 m2 |
| Ombyggnad procurement | 21.151 t | 503.900 m2 |
| Total procurement | 49.363 t | 1244.600 m2 |
| Skärmtak trusses shown as excluded | 10.980 t | 228.800 m2 |

v3 Drive files:

- BoM: `1Q5_54ITW6jINXGTP5mf9iJo5acZxyM-2`
- Material List: `1IeXGf_4O8F5b46xRmZh7TTvo38DWg7Vz`
- Description: `1v2LH4gPqAuPPsEoYeLNznfDwppNggMvC`

All v3 files were uploaded and verified by download-back MD5.

## Implementation Notes

Current working script for Nordic A-jaur:

`/root/CODEXCLAW/workspace/inbox/project-1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5/build_nordic_ajaur_workbooks.py`

Current output folder:

`/root/workspace/output/steel-analyzer/project-1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5/`

Shared logs updated:

- `/root/CODEXCLAW/obsidian-vault/projects/steel/steel-analyzer-results-index.md`
- `/root/CODEXCLAW/obsidian-vault/_inbox/{AIM} {message} mutual memory – 2026-05-06.md`
