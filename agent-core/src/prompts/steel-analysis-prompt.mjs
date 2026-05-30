export function buildAnalysisPrompt(runId, sourceTexts) {
  const sourcesList = Object.keys(sourceTexts).map(name => `- ${name}`).join('\n');
  const combinedText = Object.entries(sourceTexts)
    .map(([name, text]) => `--- SOURCE: ${name} ---\n${text}`)
    .join('\n\n');

  return `
Analyze steel structures from the provided source texts and return a single JSON object.
Run ID: ${runId}

SOURCES:
${sourcesList}

OUTPUT REQUIREMENTS:
Return ONLY raw JSON — no markdown, no preamble, no postamble.
Follow this exact structure (omit optional fields if unknown, but include all required ones):

{
  "schema": "steel.run-complete.v1",
  "run_id": "${runId}",
  "owner_runtime": "claudeclaw",
  "project_name": "<project name from documents>",
  "project_no": "<project number if found, else null>",
  "status": "complete",
  "delivery_mode": "standard",
  "handoff_path": "",
  "source_inventory_path": "",
  "download_manifest_path": "",
  "workbooks_validated": false,
  "created_at": "<ISO 8601 datetime>",
  "subprojects": [
    {
      "name": "<subproject name>",
      "exec_class": "<EXC2 or similar, if known>",
      "coating_summary": "<compact form: 'C2: 820.50 m2; C3: 424.10 m2; Indoor C2 H, outdoor C3 H — inferred from location'>",
      "fire_summary": "<one-line fire protection: 'R30 intumescent paint, 420.00 m2' or 'None'>",
      "transport_summary": "<one-line transport class: 'Standard road transport'>",
      "welding": "<welding standard if known>",
      "notes": "<any important notes>",
      "totals": { "weight_kg": 0, "paint_m2": 0 },
      "source_total_kg": 0,
      "categories": [
        { "name": "<category>", "weight_kg": 0, "paint_m2": 0, "qty": 0, "length_m": 0 }
      ],
      "profiles": [
        {
          "profile": "<profile name>",
          "steel_grade": "S355",
          "category": "<assigned category — must match one of the subproject categories>",
          "qty": 0,
          "length_m": 0,
          "weight_kg": 0,
          "paint_m2": 0,
          "coating": "<coating system or null>",
          "fire_class": "<R30/R60/R90 or null>",
          "critical_temp_c": null,
          "am_v": null,
          "source": "<source filename>"
        }
      ],
      "source_rows": [
        {
          "part": "<part/assembly mark>",
          "profile": "<profile>",
          "steel_grade": "S355",
          "category": "<category>",
          "qty": 0,
          "length_mm": 0,
          "weight_kg": 0,
          "paint_m2": 0,
          "source": "<source filename>",
          "source_line": "<line reference>"
        }
      ],
      "assembly_map": [],
      "oversize": [],
      "excluded_rows": [
        {
          "category": "<category>",
          "assembly_no": "<assembly>",
          "part_no": "<part>",
          "profile": "<profile>",
          "steel_grade": "S355",
          "qty": 0,
          "length_mm": 0,
          "weight_kg": 0,
          "paint_m2": 0,
          "exclusion_reason": "<why excluded>",
          "source": "<source filename>"
        }
      ]
    }
  ],
  "excluded": [
    {
      "subproject": "<name>",
      "scope": "<scope description>",
      "reason": "<reason>",
      "weight_kg": 0,
      "paint_m2": 0
    }
  ],
  "sources": ["<filename1.pdf>", "<filename2.pdf>"],
  "sources_detail": [
    {
      "subproject": "<subproject name or 'All'>",
      "source_type": "Drawing",
      "file_name": "<filename>",
      "used_for": "<what data was extracted>",
      "priority": "Primary",
      "notes": ""
    }
  ],
  "open_questions": [
    {
      "id": "OQ-<Subproject>-<Category>-001",
      "subproject": "<name>",
      "category": "<category>",
      "question": "<what is unclear>",
      "option_a": "<option A>",
      "option_b": "<option B>",
      "option_c": "",
      "status": "Open"
    }
  ],
  "analysis_warnings": ["<any data quality warnings>"],
  "transport_detail": { "t1": [], "t2": [] },
  "outputs": []
}

ANALYSIS RULES:
1. DO NOT invent data. If a field is unknown, omit it or use null.
2. All weight in kg, lengths in m (or mm where schema specifies mm), areas in m2.
3. Identify trusses (FV/* marks) and exclude from procurement totals — list in both excluded_rows (per-subproject) and excluded (top-level summary).
4. coating_summary format: "C2: 820.50 m2; C3: 424.10 m2; <description> — inferred from <reason>". Include explicit area breakdown per coating class. Add assumption note when inferred.
5. fire_summary format: "R30: 420.00 m2 intumescent; R60: 120.00 m2 intumescent" or "None". Include area per R-class.
6. sources_detail: one entry per source document, Priority = "Primary" for main material lists, "Secondary" for supplementary.
7. open_questions: use ID format "OQ-{Subproject}-{Category}-{NNN}" (e.g. OQ-A1-STEEL-001). Separate Option A, Option B, Option C columns. Status = "Open". Document anything ambiguous.
8. analysis_warnings: list any data quality issues (missing weights, conflicting totals, missing drawings).
9. CATEGORY ASSIGNMENT — REQUIRED: Every profile MUST have a category. Standard categories: Columns, Beams, Trusses, HSQ, Bracing, Railings, Stairs, Outside, Plates, Other, Unclassified. Assign based on part mark / drawing table.
10. PROFILE-CATEGORY CONFLICT: If the same profile appears in 2+ categories across different drawings and cannot be split by quantity, create an open_questions entry: "Profile <X> appears in categories <A> and <B> in different drawings. Which category applies?" Mark both options. Do NOT silently pick one.
11. FIRE CLASS CONFLICT — R30+R60 rule: If a profile is required to be BOTH R30 and R60 (appears in both lists) and cannot be split by element, assign entire profile to R60 (worst case). For critical temperature: use the MINIMUM of the two values. Always emit an open_questions entry flagging the conflict.
12. COATING DEFAULT — C2 vs C3: When location is ambiguous, default to C2 and emit an open_questions entry. Do NOT silently assign C3.
13. PLATES: Always use "Plates" category. Do not distribute plates into Beams or Other.
14. MISSING VALUES: Use null for unknown numbers. Use empty string for unknown text. Do NOT invent zero weights.

TEXT CONTENT:
${combinedText}
`.trim();
}
