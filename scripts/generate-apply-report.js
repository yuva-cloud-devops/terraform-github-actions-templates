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
const logPath = args.log || 'apply.log';
const env = args.env || 'unknown';
const cloud = (args.cloud || 'unknown').toUpperCase();
const stack = args.stack || '.';
const exitCode = parseInt(args.exitcode || '0', 10);
const outputPath = args.out || 'apply-report.md';

const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'Apply log unavailable.';

const isSuccess = exitCode === 0 && logContent.includes('Apply complete!') && !logContent.includes('Error:');
const match = logContent.match(/Apply complete! Resources: (\d+) added, (\d+) changed, (\d+) destroyed\./);
const add = match ? match[1] : (isSuccess ? '0' : 'N/A');
const change = match ? match[2] : (isSuccess ? '0' : 'N/A');
const destroy = match ? match[3] : (isSuccess ? '0' : 'N/A');

const safeLog = logContent.length > 40000 ? logContent.substring(0, 40000) + '\n...[TRUNCATED FOR SIZE]' : logContent;
const statusBadge = isSuccess ? '✅ **APPLY SUCCESSFUL**' : '❌ **APPLY FAILED**';

const report = `## 🚀 Terraform Apply Audit [\`${cloud}\` | \`${env}\` | \`${stack}\`]

| Status | 🟢 Added | 🟡 Changed | 🔴 Destroyed | Execution Timestamp |
| :---: | :---: | :---: | :---: | :---: |
| ${statusBadge} | **${add}** | **${change}** | **${destroy}** | \`${new Date().toUTCString()}\` |

<details ${isSuccess ? '' : 'open'}>
<summary>📜 Click to view execution log</summary>

\`\`\`text
${safeLog}
\`\`\`

</details>
`;

fs.writeFileSync(outputPath, report);
console.log(`Apply report written to: ${outputPath}`);
