#!/usr/bin/env node

/**
 * ==============================================================================
 * Dynamic Terraform Plan & Compliance Audit Report Generator
 * Zero static fallback content — parses real Gitleaks, Trivy, Checkov,
 * and per-layer tfplan.json artifacts across GCP, AWS, and Azure.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');

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

function stripAnsi(str) {
  return (str || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function mdCell(str, maxLen = 280) {
  let s = String(str ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  if (s.length > maxLen) s = s.substring(0, maxLen) + '...';
  return s;
}

function findFilesRecursive(dir, filename) {
  const results = [];
  if (!dir || !fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(full, filename));
    } else if (entry.name === filename) {
      results.push(full);
    }
  }
  return results;
}

function extractDynamicDetails(rc) {
  const change = rc.change || {};
  const actions = change.actions || [];
  const after = change.after || {};
  const before = change.before || {};
  const afterUnknown = change.after_unknown || {};
  const stateObj = Object.keys(after).length > 0 ? after : before;

  const details = [];

  // For updates, highlight exact changed attributes first
  if (actions.includes('update')) {
    const changedKeys = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changedKeys.length > 0) {
      details.push(`Changed: ${changedKeys.slice(0, 5).map(k => `\`${k}\``).join(', ')}${changedKeys.length > 5 ? ', ...' : ''}`);
    }
  }

  // Common multi-cloud attributes (GCP, AWS, Azure) extracted dynamically when present
  const candidateKeys = [
    ['machine_type', 'Machine'],
    ['instance_type', 'Instance'],
    ['vm_size', 'VM Size'],
    ['zone', 'Zone'],
    ['availability_zone', 'AZ'],
    ['region', 'Region'],
    ['location', 'Location'],
    ['ip_cidr_range', 'CIDR'],
    ['cidr_block', 'CIDR'],
    ['network', 'Network'],
    ['vpc_id', 'VPC'],
    ['virtual_network_name', 'VNet'],
    ['routing_mode', 'Routing'],
    ['private_ip_google_access', 'PGA'],
    ['bucket', 'Bucket'],
    ['storage_account_name', 'Storage'],
    ['asn', 'ASN'],
    ['type', 'Type'],
    ['role', 'Role']
  ];

  for (const [key, label] of candidateKeys) {
    if (stateObj[key] !== undefined && stateObj[key] !== null && stateObj[key] !== '') {
      details.push(`${label}: \`${mdCell(stateObj[key], 60)}\``);
    }
    if (details.length >= 4) break;
  }

  if (Array.isArray(stateObj.network_interface) && stateObj.network_interface[0]) {
    const ni = stateObj.network_interface[0];
    const hasPublic = Array.isArray(ni.access_config) && ni.access_config.length > 0;
    details.push(`Public IP: \`${hasPublic ? 'enabled' : 'private-only'}\``);
  }

  if (Array.isArray(stateObj.allow)) {
    const ports = stateObj.allow.flatMap(a => a.ports || []).filter(Boolean).join(', ');
    if (ports) details.push(`Ports: \`${mdCell(ports, 60)}\``);
  }

  if (Array.isArray(stateObj.source_ranges) && stateObj.source_ranges.length > 0) {
    details.push(`Source: \`${mdCell(stateObj.source_ranges.join(', '), 80)}\``);
  }

  if (details.length === 0) {
    const scalarEntries = Object.entries(stateObj)
      .filter(([k, v]) => k !== 'id' && k !== 'name' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && String(v).length > 0 && String(v).length <= 40)
      .slice(0, 3);
    for (const [k, v] of scalarEntries) {
      details.push(`${k}: \`${mdCell(v, 40)}\``);
    }
  }

  if (details.length === 0 && Object.keys(afterUnknown).length > 0) {
    const unknownKeys = Object.keys(afterUnknown).slice(0, 3).map(k => `\`${k}\``).join(', ');
    details.push(`Computed: ${unknownKeys}`);
  }

  return details.join(', ') || '—';
}

function parseTerraformPlanJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    return { counts: { toAdd: 0, toChange: 0, toDestroy: 0 }, grouped: [], resources: [], outputs: [] };
  }

  let plan = {};
  try {
    plan = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return { counts: { toAdd: 0, toChange: 0, toDestroy: 0 }, grouped: [], resources: [], outputs: [] };
  }

  const resourceChanges = plan.resource_changes || [];
  const outputChanges = plan.output_changes || {};

  let toAdd = 0, toChange = 0, toDestroy = 0;
  const resources = [];
  const groupedMap = new Map();

  for (const rc of resourceChanges) {
    const actions = (rc.change && rc.change.actions) || [];
    if (actions.includes('no-op') || actions.includes('read')) continue;

    let actionLabel = '➕ CREATE';
    if (actions.includes('delete') && actions.includes('create')) {
      actionLabel = '⚠️ RECREATE';
      toDestroy++;
      toAdd++;
    } else if (actions.includes('create')) {
      actionLabel = '➕ CREATE';
      toAdd++;
    } else if (actions.includes('update')) {
      actionLabel = '🔄 UPDATE';
      toChange++;
    } else if (actions.includes('delete')) {
      actionLabel = '🗑️ DESTROY';
      toDestroy++;
    }

    const rType = rc.type;
    const after = (rc.change && rc.change.after) || {};
    const before = (rc.change && rc.change.before) || {};
    const stateObj = Object.keys(after).length > 0 ? after : before;
    const rName = stateObj.name || rc.name || rc.address.split('.').pop();

    resources.push({
      action: actionLabel,
      type: rType,
      name: rName,
      address: rc.address,
      details: extractDynamicDetails(rc)
    });

    const groupKey = `${actionLabel}|${rType}`;
    if (!groupedMap.has(groupKey)) {
      groupedMap.set(groupKey, { action: actionLabel, type: rType, names: [] });
    }
    groupedMap.get(groupKey).names.push(rName);
  }

  const outputs = [];
  for (const [key, out] of Object.entries(outputChanges)) {
    const outActions = out.actions || [];
    let op = '+ ADD';
    if (outActions.includes('update')) op = '~ CHANGE';
    if (outActions.includes('delete')) op = '- DELETE';

    let valStr = '(known after apply)';
    if (out.after !== undefined && out.after !== null) {
      valStr = typeof out.after === 'object' ? JSON.stringify(out.after) : String(out.after);
    }
    outputs.push({ action: op, name: key, value: mdCell(valStr, 250) });
  }

  return {
    counts: { toAdd, toChange, toDestroy },
    grouped: Array.from(groupedMap.values()),
    resources,
    outputs
  };
}

function main() {
  const args = parseArgs();
  const artifactsDir = args.artifacts || 'ci-artifacts';
  const envName = (args.env || 'unknown').toUpperCase();
  const cloudName = (args.cloud || 'unknown').toUpperCase();
  const commitSha = args.sha || 'unknown';
  const outputPath = args.out || 'final-plan-report.md';

  let requestedStacks = [];
  try {
    requestedStacks = JSON.parse(args.stacks || '[]');
  } catch (e) {
    requestedStacks = [];
  }

  // --------------------------------------------------------------------------
  // A. Security Reports (Gitleaks, Trivy, Checkov) — Zero Static Fake Passes
  // --------------------------------------------------------------------------
  const gitleaksFiles = findFilesRecursive(artifactsDir, 'gitleaks_report.txt');
  const trivyFiles = findFilesRecursive(artifactsDir, 'trivy_report.txt');
  const checkovFiles = findFilesRecursive(artifactsDir, 'checkov_report.txt');

  // 1. Gitleaks
  let gitleaksStatus = '⏭️ Not executed / No report';
  let gitleaksDetail = 'Gitleaks did not run or no report artifact was uploaded.';
  let gitleaksBadge = '⏭️ SKIPPED';
  let gitleaksWarn = false;

  if (gitleaksFiles.length > 0) {
    const rawGl = stripAnsi(fs.readFileSync(gitleaksFiles[0], 'utf8')).trim();
    gitleaksDetail = rawGl || 'Empty Gitleaks output.';

    if (/no leaks found/i.test(rawGl)) {
      gitleaksStatus = '✅ No hardcoded secrets detected';
      gitleaksBadge = '✅ PASSED';
      const lines = rawGl.split('\n');
      const summaryIdx = lines.findIndex(l => l.includes('commits scanned') || l.includes('no leaks found'));
      if (summaryIdx !== -1) {
        gitleaksDetail = lines.slice(Math.max(0, summaryIdx - 6), summaryIdx + 3).join('\n').trim();
      }
    } else if (/leaks? found/i.test(rawGl) || /Finding:/i.test(rawGl)) {
      gitleaksStatus = '❌ Secrets detected in codebase';
      gitleaksBadge = '❌ FAILED';
      gitleaksWarn = true;
      gitleaksDetail = rawGl.split('\n').slice(0, 40).join('\n').trim();
    } else {
      gitleaksStatus = '⚠️ Scan completed (check log)';
      gitleaksBadge = '⚠️ INFO';
    }
  }

  // 2. Trivy
  let trivyStatus = '⏭️ Not executed / No report';
  let trivyDetail = 'Trivy did not run or no report artifact was uploaded.';
  let trivyBadge = '⏭️ SKIPPED';
  let trivyWarn = false;

  if (trivyFiles.length > 0) {
    const rawTr = stripAnsi(fs.readFileSync(trivyFiles[0], 'utf8')).trim();
    if (/FATAL|unknown flag/i.test(rawTr)) {
      trivyStatus = '❌ Trivy execution error';
      trivyBadge = '❌ ERROR';
      trivyWarn = true;
      trivyDetail = rawTr.split('\n').slice(-15).join('\n').trim();
    } else {
      const critMatches = [...rawTr.matchAll(/CRITICAL:\s*(\d+)/g)].map(m => parseInt(m[1], 10));
      const highMatches = [...rawTr.matchAll(/HIGH:\s*(\d+)/g)].map(m => parseInt(m[1], 10));
      const critCount = critMatches.reduce((a, b) => a + b, 0);
      const highCount = highMatches.reduce((a, b) => a + b, 0);

      if (critCount > 0 || highCount > 0) {
        trivyStatus = `⚠️ Findings: CRITICAL: ${critCount}, HIGH: ${highCount}`;
        trivyBadge = '⚠️ WARNING';
        trivyWarn = true;
      } else {
        trivyStatus = '✅ 0 High/Critical findings';
        trivyBadge = '✅ PASSED';
      }

      const boxStart = rawTr.indexOf('Report Summary');
      if (boxStart !== -1) {
        const lines = rawTr.substring(boxStart).split('\n');
        const legendEnd = lines.findIndex(l => l.includes('Clean (no security findings detected)'));
        trivyDetail = (legendEnd !== -1 ? lines.slice(0, legendEnd + 1) : lines.slice(0, 25)).join('\n').trim();
      } else {
        trivyDetail = rawTr.split('\n').slice(-25).join('\n').trim() || 'Scan completed.';
      }
    }
  }

  // 3. Checkov (supports CKV_ and CKV2_ across all clouds, deduplicated)
  const passedChecks = [];
  const failedChecks = [];
  const seenKeys = new Set();

  for (const ckFile of checkovFiles) {
    const rawCk = stripAnsi(fs.readFileSync(ckFile, 'utf8'));
    const checkBlocks = rawCk.split(/(?=Check:\s*CKV2?_)/);

    for (const block of checkBlocks) {
      if (!block.startsWith('Check:')) continue;

      const headerMatch = block.match(/^Check:\s*([A-Z0-9_]+):\s*"([^"]+)"/);
      if (!headerMatch) continue;

      const checkId = headerMatch[1];
      const checkDesc = headerMatch[2];
      const isPassed = block.includes('PASSED for resource:');
      const isFailed = block.includes('FAILED for resource:');

      let resource = 'Unknown';
      const resMatch = block.match(/(?:PASSED|FAILED)\s+for resource:\s*([^\n\r]+)/);
      if (resMatch) resource = resMatch[1].trim();

      let file = 'Unknown';
      const fileMatch = block.match(/File:\s*([^\n\r]+)/);
      if (fileMatch) file = fileMatch[1].trim();

      const guideMatch = block.match(/Guide:\s*(https?:\/\/[^\s\n\r]+)/);
      const guideUrl = guideMatch ? `[Checkov Guide](${guideMatch[1]})` : 'Review policy documentation';

      const dedupeKey = `${checkId}|${resource}|${file}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      if (isPassed) {
        passedChecks.push({ id: checkId, desc: checkDesc, resource, file });
      } else if (isFailed) {
        failedChecks.push({ id: checkId, desc: checkDesc, resource, file, fix: guideUrl });
      }
    }
  }

  const totalPassed = passedChecks.length;
  const totalFailed = failedChecks.length;

  let checkovStatus = '⏭️ Not executed / No report';
  let checkovBadge = '⏭️ SKIPPED';
  let checkovWarn = false;

  if (checkovFiles.length > 0) {
    if (totalFailed > 0) {
      checkovStatus = `⚠️ Policy issues: Passed: ${totalPassed}, Failed: ${totalFailed}`;
      checkovBadge = `⚠️ ${totalPassed} PASSED / ${totalFailed} FAILED`;
      checkovWarn = true;
    } else {
      checkovStatus = `✅ All checks passed (${totalPassed} passed)`;
      checkovBadge = `✅ ${totalPassed} PASSED`;
    }
  }

  const anySecurityRan = gitleaksFiles.length > 0 || trivyFiles.length > 0 || checkovFiles.length > 0;
  const hasAnyWarnings = gitleaksWarn || trivyWarn || checkovWarn;
  const securityHeaderBadge = !anySecurityRan
    ? '⏭️ Scans Skipped'
    : (hasAnyWarnings ? '⚠️ Security Warnings' : '✅ All Passed');

  // --------------------------------------------------------------------------
  // B. Collect Per-Layer Plans (Sorted Numerically in Execution Order)
  // --------------------------------------------------------------------------
  const metaFiles = findFilesRecursive(artifactsDir, 'meta.json').sort((a, b) => {
    const idxA = parseInt(path.basename(path.dirname(a)), 10);
    const idxB = parseInt(path.basename(path.dirname(b)), 10);
    if (!isNaN(idxA) && !isNaN(idxB)) return idxA - idxB;
    return a.localeCompare(b);
  });

  const layers = [];
  for (const metaPath of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      layers.push({
        name: meta.stack || meta.dir || path.basename(path.dirname(metaPath)),
        dir: path.dirname(metaPath),
        exitcode: Number(meta.exitcode ?? 0)
      });
    } catch (e) {
      // skip malformed meta
    }
  }

  const infraNames = layers.length > 0
    ? layers.map(l => l.name).join(', ')
    : (requestedStacks.length > 0 ? requestedStacks.join(', ') : 'none');

  const anyPlanFailed = layers.some(l => l.exitcode === 1);
  let pipelineStatus = '🟢 **PLAN GENERATED**';
  if (layers.length === 0) {
    pipelineStatus = '⚠️ **NO PLAN PRODUCED**';
  } else if (anyPlanFailed) {
    pipelineStatus = '🔴 **PLAN FAILED**';
  }

  // --------------------------------------------------------------------------
  // C. Build Dynamic Consolidated Markdown Report
  // --------------------------------------------------------------------------
  let commentBody = `## 🤖 Terraform Plan & Compliance Audit Report\n\n`;
  commentBody += `| **Target Environment** | **Cloud** | **Infrastructure Scope** | **Security Checks** | **Pipeline Status** |\n`;
  commentBody += `| :---: | :---: | :---: | :---: | :---: |\n`;
  commentBody += `| \`${envName}\` | \`${cloudName}\` | \`${infraNames}\` | ${securityHeaderBadge} | ${pipelineStatus} |\n\n`;
  commentBody += `---\n\n`;

  commentBody += `### 🛡️ Security & Compliance Audit\n\n`;
  commentBody += `| Security Tool | Scope | Status / Finding |\n`;
  commentBody += `| :--- | :--- | :--- |\n`;
  commentBody += `| **Gitleaks** | Repository Commits & Files | ${gitleaksStatus} |\n`;
  commentBody += `| **Trivy** | Vulnerabilities & Misconfigurations | ${trivyStatus} |\n`;
  commentBody += `| **Checkov** | ${cloudName} IaC Policies & Best Practices | ${checkovStatus} |\n\n`;

  commentBody += `<details>\n<summary><b>🔍 View Security Scans Output & Remediation Guide</b></summary>\n\n`;
  commentBody += `#### 1️⃣ Gitleaks Scan — \`${gitleaksBadge}\`\n\`\`\`text\n${gitleaksDetail}\n\`\`\`\n\n`;
  commentBody += `#### 2️⃣ Trivy Scan — \`${trivyBadge}\`\n\`\`\`text\n${trivyDetail}\n\`\`\`\n\n`;
  commentBody += `#### 3️⃣ Checkov Policies — \`${checkovBadge}\`\n`;
  commentBody += `* **Passed Checks**: \`${totalPassed}\` policies verified.\n`;

  if (failedChecks.length > 0) {
    commentBody += `\n##### ❌ Failed Checks & Fixes (${failedChecks.length})\n\n`;
    commentBody += `| Check ID | Policy Description | Impacted Resource | File | Recommended Fix |\n| :--- | :--- | :--- | :--- | :--- |\n`;
    failedChecks.forEach(f => {
      commentBody += `| **\`${f.id}\`** | ${mdCell(f.desc, 140)} | \`${mdCell(f.resource, 80)}\` | \`${mdCell(f.file, 80)}\` | ${f.fix} |\n`;
    });
    commentBody += `\n`;
  }
  commentBody += `</details>\n\n---\n\n`;

  commentBody += `### 📋 Infrastructure Execution Plan\n\n`;

  if (layers.length === 0) {
    commentBody += `*No Terraform plan artifacts were produced (check earlier stage logs).*\n\n`;
  }

  for (const layer of layers) {
    const jsonPath = path.join(layer.dir, 'tfplan.json');
    const rawPath = path.join(layer.dir, 'plan.txt');

    if (layer.exitcode === 1) {
      const rawErr = fs.existsSync(rawPath) ? stripAnsi(fs.readFileSync(rawPath, 'utf8')) : 'Execution log unavailable.';
      const safeErr = rawErr.length > 15000 ? rawErr.substring(0, 15000) + '\n...[TRUNCATED]' : rawErr;
      commentBody += `#### 🔹 Layer: **${layer.name.toUpperCase()}** (🔴 \`FAILED\`)\n\n`;
      commentBody += `<details open>\n<summary><b>❌ View Terraform Error Log</b></summary>\n\n\`\`\`text\n${safeErr}\n\`\`\`\n\n</details>\n\n`;
      continue;
    }

    const parsed = parseTerraformPlanJson(jsonPath);
    commentBody += `#### 🔹 Layer: **${layer.name.toUpperCase()}** (\`+${parsed.counts.toAdd} ~${parsed.counts.toChange} -${parsed.counts.toDestroy}\`)\n\n`;

    if (parsed.grouped.length === 0) {
      commentBody += `*No changes. Infrastructure is up-to-date.*\n\n`;
    } else {
      commentBody += `| Action | Resource Type | Count | Resource Name(s) |\n`;
      commentBody += `| :---: | :--- | :---: | :--- |\n`;
      parsed.grouped.forEach(g => {
        const namesStr = mdCell(g.names.map(n => `\`${n}\``).join(', '), 250);
        commentBody += `| ${g.action} | \`${g.type}\` | ${g.names.length} | ${namesStr} |\n`;
      });
      commentBody += `\n`;

      commentBody += `<details>\n<summary><b>🔍 View Granular Resource Details (${parsed.resources.length} resources)</b></summary>\n\n`;
      commentBody += `| Action | Address | Key Attributes |\n`;
      commentBody += `| :---: | :--- | :--- |\n`;
      parsed.resources.forEach(r => {
        commentBody += `| ${r.action} | \`${mdCell(r.address, 140)}\` | ${r.details} |\n`;
      });
      commentBody += `\n</details>\n\n`;
    }

    if (parsed.outputs.length > 0) {
      commentBody += `<details>\n<summary><b>📦 View Output Changes (${parsed.outputs.length} outputs)</b></summary>\n\n`;
      commentBody += `| Output Name | Action | Value / Preview |\n| :--- | :---: | :--- |\n`;
      parsed.outputs.forEach(o => {
        commentBody += `| \`${o.name}\` | \`${o.action}\` | \`${o.value}\` |\n`;
      });
      commentBody += `\n</details>\n\n`;
    }
  }

  commentBody += `---\n*Automated PR Comment generated by GitHub Actions Bot for Commit \`${commitSha}\`*`;

  fs.writeFileSync(outputPath, commentBody);
  console.log(`Consolidated plan report written to: ${outputPath}`);
}

main();
