#!/usr/bin/env node
const fs = require('fs');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = '';
      }
    }
  }
  return args;
}

const args = parseArgs();
const jsonPath = args.json || 'tfplan.json';
const rawPath = args.raw || 'plan.txt';
const env = args.env || 'unknown';
const cloud = (args.cloud || 'unknown').toUpperCase();
const stack = args.stack || '.';
const exitCode = parseInt(args.exitcode || '0', 10);
const outputPath = args.out || 'plan-report.md';

let add = 0, change = 0, destroy = 0;
const destructiveResources = [];

if (exitCode === 1) {
  const rawLog = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : 'Execution log unavailable.';
  const safeLog = rawLog.length > 48000 ? rawLog.substring(0, 48000) + '\n...[TRUNCATED FOR SIZE]' : rawLog;

  const failureReport = `## ❌ Terraform Plan Failed [\`${cloud}\` | \`${env}\` | \`${stack}\`]

> [!CAUTION]
> **Terraform init/validate/plan encountered errors during execution.** Review the error logs below.

<details open>
<summary>📋 Error Log Details</summary>

\`\`\`text
${safeLog}
\`\`\`

</details>

*Generated at: ${new Date().toUTCString()}*
`;
  fs.writeFileSync(outputPath, failureReport);
  console.log(`Plan failure report generated at: ${outputPath}`);
  process.exit(0);
}

if (fs.existsSync(jsonPath)) {
  try {
    const rawJson = fs.readFileSync(jsonPath, 'utf8');
    if (rawJson.trim().length > 2) {
      const data = JSON.parse(rawJson);
      const resourceChanges = data.resource_changes || [];

      for (const res of resourceChanges) {
        const actions = res.change ? res.change.actions : [];
        if (actions.includes('create')) add++;
        if (actions.includes('update')) change++;
        if (actions.includes('delete')) {
          destroy++;
          destructiveResources.push(`${res.type} (${res.name})`);
        }
      }
    }
  } catch (err) {
    console.warn("Could not parse JSON plan completely; falling back to raw plan output.", err.message);
  }
}

const rawPlan = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : 'Plan details unavailable';
const safePlan = rawPlan.length > 48000 ? rawPlan.substring(0, 48000) + '\n...[TRUNCATED FOR SIZE]' : rawPlan;

let alertBadge = '✅ **Clean Plan: No changes detected (Infrastructure is up-to-date)**';
if (destroy > 0) {
  alertBadge = '⚠️ **WARNING: Destructive Actions Detected (Resources will be deleted!)**';
} else if (add > 0 || change > 0) {
  alertBadge = '🚀 **Plan Succeeded: Proposed infrastructure modifications detected**';
}

let report = `## 🪐 Terraform Plan Summary [\`${cloud}\` | \`${env}\` | \`${stack}\`]

${alertBadge}

| 🟢 To Add | 🟡 To Modify | 🔴 To Destroy |
| :---: | :---: | :---: |
| **${add}** | **${change}** | **${destroy}** |
`;

if (destructiveResources.length > 0) {
  report += `\n> [!CAUTION]\n> **Resources scheduled for deletion:**\n`;
  destructiveResources.forEach(r => { report += `> - \`${r}\`\n`; });
}

report += `
<details>
<summary>📋 Click to expand detailed raw plan</summary>

\`\`\`hcl
${safePlan}
\`\`\`

</details>

*Report generated at: ${new Date().toUTCString()}*
`;

fs.writeFileSync(outputPath, report);
console.log(`Plan report successfully written to: ${outputPath}`);
