import fs from 'fs';
import path from 'path';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateDashboard(data, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const totalWeight = data.subprojects.reduce((acc, sp) => acc + (sp.totals.weight_kg || 0) / 1000, 0);
  const totalArea = data.subprojects.reduce((acc, sp) => acc + (sp.totals.paint_m2 || 0), 0);
  const issueCount = (data.open_questions?.length || 0) + (data.analysis_warnings?.length || 0);
  const primarySources = (data.sources_detail || []).filter(s => s.priority === 'Primary');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Steel Analyzer Pre-Approval Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1d1d1f; max-width: 1000px; margin: 0 auto; padding: 40px 20px; background-color: #f5f5f7; }
        .header { margin-bottom: 40px; }
        .header h1 { margin: 0; font-size: 32px; font-weight: 700; }
        .header p { margin: 8px 0 0; color: #86868b; font-size: 17px; }

        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .card { background: white; padding: 24px; border-radius: 18px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); text-align: left; transition: transform 0.2s; }
        .card:hover { transform: translateY(-2px); }
        .card h3 { margin: 0; font-size: 13px; color: #86868b; text-transform: uppercase; letter-spacing: 0.02em; }
        .card .value { font-size: 24px; font-weight: 600; margin: 12px 0 0; color: #1d1d1f; }
        .card .unit { font-size: 15px; color: #86868b; margin-left: 2px; }

        .section { background: white; border-radius: 18px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); margin-bottom: 24px; overflow: hidden; }
        .section-header { padding: 20px 24px; background: #fafafa; border-bottom: 1px solid #f2f2f2; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 18px; user-select: none; }
        .section-header:hover { background: #f0f0f2; }
        .section-content { padding: 24px; display: none; background: white; }
        .section.open .section-content { display: block; }
        .section-header .arrow { transition: transform 0.3s; color: #86868b; }
        .section.open .section-header .arrow { transform: rotate(180deg); }

        table { width: 100%; border-collapse: collapse; margin-top: 0; }
        th, td { text-align: left; padding: 14px; border-bottom: 1px solid #f2f2f2; font-size: 15px; }
        th { background: white; color: #86868b; font-weight: 500; font-size: 13px; text-transform: uppercase; }
        tr:last-child td { border-bottom: none; }

        .status-tag { display: inline-block; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; }
        .status-open { background: #fff1f1; color: #d70015; }
        .status-answered { background: #f2fcf5; color: #248a3d; }

        .source-item { padding: 12px 0; border-bottom: 1px solid #f2f2f2; }
        .source-item:last-child { border-bottom: none; }
        .source-name { font-weight: 600; color: #1d1d1f; }
        .source-meta { color: #86868b; font-size: 13px; margin-top: 4px; }

        .badge { background: #86868b; color: white; padding: 2px 8px; border-radius: 10px; font-size: 12px; margin-left: 8px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Project ${escHtml(data.project_no || 'N/A')} - ${escHtml(data.project_name || 'N/A')}</h1>
        <p>Generated: ${new Date(data.generated_at).toLocaleString('de-DE')} | Version: ${escHtml(data.version_string || 'v1')}</p>
    </div>

    <div class="cards">
        <div class="card">
            <h3>Total Weight</h3>
            <div class="value">${totalWeight.toFixed(2)}<span class="unit">t</span></div>
        </div>
        <div class="card">
            <h3>Paint Area</h3>
            <div class="value">${totalArea.toFixed(2)}<span class="unit">m²</span></div>
        </div>
        <div class="card">
            <h3>Coating</h3>
            <div class="value">${escHtml(data.subprojects[0]?.coating_summary || 'N/A')}</div>
        </div>
        <div class="card">
            <h3>Fire Protection</h3>
            <div class="value">${escHtml(data.subprojects[0]?.fire_summary || 'N/A')}</div>
        </div>
        <div class="card">
            <h3>Transport</h3>
            <div class="value">${escHtml(data.subprojects[0]?.transport_summary || 'N/A')}</div>
        </div>
    </div>

    <div class="section open">
        <div class="section-header" onclick="toggleSection(this)">
            Project Summary
            <span class="arrow">▼</span>
        </div>
        <div class="section-content">
            <table>
                <thead>
                    <tr>
                        <th>Subproject</th>
                        <th>Weight (t)</th>
                        <th>Area (m²)</th>
                        <th>Coating</th>
                        <th>Fire</th>
                        <th>Transport</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.subprojects.map(sp => `
                        <tr>
                            <td>${escHtml(sp.name)}</td>
                            <td>${((sp.totals.weight_kg || 0) / 1000).toFixed(2)}</td>
                            <td>${(sp.totals.paint_m2 || 0).toFixed(2)}</td>
                            <td>${escHtml(sp.coating_summary || 'N/A')}</td>
                            <td>${escHtml(sp.fire_summary || 'N/A')}</td>
                            <td>${escHtml(sp.transport_summary || 'N/A')}</td>
                        </tr>
                    `).join('')}
                    ${data.subprojects.length > 1 ? `
                        <tr style="font-weight: 700; background: #fafafa;">
                            <td>All</td>
                            <td>${totalWeight.toFixed(2)}</td>
                            <td>${totalArea.toFixed(2)}</td>
                            <td>-</td>
                            <td>-</td>
                            <td>-</td>
                        </tr>
                    ` : ''}
                </tbody>
            </table>
        </div>
    </div>

    <div class="section">
        <div class="section-header" onclick="toggleSection(this)">
            Warnings & Open Questions <span class="badge">${issueCount}</span>
            <span class="arrow">▼</span>
        </div>
        <div class="section-content">
            ${data.open_questions?.length > 0 ? `
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Subproject</th>
                            <th>Category</th>
                            <th>Question</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.open_questions.map(q => `
                            <tr>
                                <td style="font-weight: 600;">${escHtml(q.id)}</td>
                                <td>${escHtml(q.subproject)}</td>
                                <td>${escHtml(q.category)}</td>
                                <td>${escHtml(q.question)}</td>
                                <td><span class="status-tag ${q.status === 'Open' ? 'status-open' : 'status-answered'}">${escHtml(q.status || 'Open')}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : ''}

            ${data.analysis_warnings?.length > 0 ? `
              <h4 style="margin-top:12px;color:#b45309;">Validator Warnings</h4>
              <ul style="margin:0;padding-left:1.5em;color:#b45309;">
                ${data.analysis_warnings.map(w => `<li>${escHtml(w)}</li>`).join('')}
              </ul>
            ` : ''}

            ${issueCount === 0 ? '<p style="color: #86868b;">No open questions or warnings identified.</p>' : ''}
        </div>
    </div>

    <div class="section">
        <div class="section-header" onclick="toggleSection(this)">
            Primary Sources <span class="badge">${primarySources.length}</span>
            <span class="arrow">▼</span>
        </div>
        <div class="section-content">
            ${primarySources.length > 0 ? primarySources.map(s => `
                <div class="source-item">
                    <div class="source-name">${escHtml(s.name)}</div>
                    <div class="source-meta">${escHtml(s.type)} &bull; Used for: ${escHtml(s.used_for)}</div>
                </div>
            `).join('') : '<p style="color: #86868b;">No primary sources listed.</p>'}
        </div>
    </div>

    <script>
        function toggleSection(el) {
            el.parentElement.classList.toggle('open');
        }
    </script>
</body>
</html>
`;

  fs.writeFileSync(path.join(outputDir, 'dashboard.html'), html, 'utf8');
}
