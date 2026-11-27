#!/usr/bin/env node

/**
 * ==============================================================================
 * Terraform Plan & Compliance Audit Report Generator
 * Parses Gitleaks, Trivy, Checkov, and per-layer tfplan.json artifacts
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

    const details = [];
    if (stateObj.machine_type) details.push(`Machine: \`${stateObj.machine_type}\``);
    if (stateObj.zone) details.push(`Zone: \`${stateObj.zone}\``);
    if (stateObj.ip_cidr_range) details.push(`CIDR: \`${stateObj.ip_cidr_range}\``);
    if (stateObj.region) details.push(`Region: \`${stateObj.region}\``);
    if (stateObj.private_ip_google_access !== undefined) details.push(`PGA: \`${stateObj.private_ip_google_access}\``);
    if (stateObj.routing_mode) details.push(`Routing: \`${stateObj.routing_mode}\``);
    if (stateObj.network) details.push(`Network: \`${stateObj.network}\``);
    if (Array.isArray(stateObj.network_interface) && stateObj.network_interface[0]) {
      const ni = stateObj.network_interface[0];
      const hasPublic = Array.isArray(ni.access_config) && ni.access_config.length > 0;
      details.push(`Public IP: \`${hasPublic ? 'enabled' : 'private-only'}\``);
    }
    if (stateObj.asn) details.push(`ASN: \`${stateObj.asn}\``);
    if (stateObj.type) details.push(`Type: \`${stateObj.type}\``);

    if (stateObj.allow && Array.isArray(stateObj.allow)) {
      const ports = stateObj.allow.flatMap(a => a.ports || []).join(', ');
      if (ports) details.push(`Ports: \`${ports}\``);
    }
    if (stateObj.source_ranges && stateObj.source_ranges.length > 0) {
      details.push(`Source: \`${stateObj.source_ranges.join(', ')}\``);
    }

    resources.push({
      action: actionLabel,
      type: rType,
      name: rName,
      address: rc.address,
      details: details.join(', ') || 'Standard configuration'
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
    outputs.push({ action: op, name: key, value: valStr });
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
  const artifactsDir = args.artifacts || '.ci-artifacts';
  const envName = (args.env || 'dev').toUpperCase();
  const commitSha = args.sha || 'latest';
  const outputPath = args.out || 'final-plan-report.md';

  // --------------------------------------------------------------------------
  // A. Security Reports (Gitleaks, Trivy, Checkov)
  // --------------------------------------------------------------------------
  const gitleaksFiles = findFilesRecursive(artifactsDir, 'gitleaks_report.txt');
  const trivyFiles = findFilesRecursive(artifactsDir, 'trivy_report.txt');
  const checkovFiles = findFilesRecursive(artifactsDir, 'checkov_report.txt');

  // 1. Gitleaks
  let gitleaksStatus = '✅ No hardcoded secrets detected';
  let gitleaksDetail = 'No report available.';
  let gitleaksBadge = '✅ PASSED';

  if (gitleaksFiles.length > 0) {
    const rawGl = stripAnsi(fs.readFileSync(gitleaksFiles[0], 'utf8'));
    gitleaksDetail = rawGl.trim() || 'Clean';

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
      gitleaksDetail = rawGl.split('\n').slice(0, 40).join('\n').trim();
    }
  }

  // 2. Trivy
  let trivyStatus = '✅ 0 High/Critical vulnerabilities';
  let trivyDetail = 'Clean (0 findings)';
  let trivyBadge = '✅ PASSED';

  if (trivyFiles.length > 0) {
    const rawTr = stripAnsi(fs.readFileSync(trivyFiles[0], 'utf8'));
    if (/FATAL|unknown flag/i.test(rawTr)) {
      trivyStatus = '❌ Trivy execution error';
      trivyBadge = '❌ ERROR';
      trivyDetail = rawTr.split('\n').slice(-10).join('\n').trim();
    } else {
      const critMatch = rawTr.match(/CRITICAL:\s*(\d+)/);
      const highMatch = rawTr.match(/HIGH:\s*(\d+)/);
      const critCount = critMatch ? parseInt(critMatch[1], 10) : 0;
      const highCount = highMatch ? parseInt(highMatch[1], 10) : 0;

      if (critCount > 0 || highCount > 0) {
        trivyStatus = `⚠️ Vulnerabilities found: CRITICAL: ${critCount}, HIGH: ${highCount}`;
        trivyBadge = '⚠️ WARNING';
      }

      const boxStart = rawTr.indexOf('Report Summary');
      if (boxStart !== -1) {
        const lines = rawTr.substring(boxStart).split('\n');
        const legendEnd = lines.findIndex(l => l.includes('Clean (no security findings detected)'));
        trivyDetail = (legendEnd !== -1 ? lines.slice(0, legendEnd + 1) : lines.slice(0, 20)).join('\n').trim();
      } else {
        trivyDetail = rawTr.split('\n').slice(-20).join('\n').trim() || 'Clean (0 findings)';
      }
    }
  }

  // 3. Checkov
  const passedChecks = [];
  const failedChecks = [];

  for (const ckFile of checkovFiles) {
    const rawCk = stripAnsi(fs.readFileSync(ckFile, 'utf8'));
    const checkBlocks = rawCk.split(/(?=Check:\s*CKV_)/);

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

      if (isPassed) {
        passedChecks.push({ id: checkId, desc: checkDesc, resource, file });
      } else if (isFailed) {
        let fix = 'Review CIS benchmark recommendation';
        if (checkId === 'CKV_TF_1') {
          fix = 'Supply chain policy: Replace `version = "~> ..."` with Git commit hash, or add `--skip-check CKV_TF_1` in CI';
        }
        failedChecks.push({ id: checkId, desc: checkDesc, resource, file, fix });
      }
    }
  }

  const totalPassed = passedChecks.length;
  const totalFailed = failedChecks.length;

  let checkovStatus = `✅ All checks passed (${totalPassed} passed)`;
  let checkovBadge = `✅ ${totalPassed} PASSED`;

  if (totalFailed > 0) {
    checkovStatus = `⚠️ Policy issues: Passed: ${totalPassed}, Failed: ${totalFailed}`;
    checkovBadge = `⚠️ ${totalPassed} PASSED / ${totalFailed} FAILED`;
  }

  const hasAnyWarnings = totalFailed > 0 || gitleaksBadge.includes('FAIL') || trivyBadge.includes('WARN') || trivyBadge.includes('ERROR');

  // --------------------------------------------------------------------------
  // B. Collect Per-Layer Plans
  // --------------------------------------------------------------------------
  const metaFiles = findFilesRecursive(artifactsDir, 'meta.json');
  const layers = [];

  for (const metaPath of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const layerDir = path.dirname(metaPath);
      layers.push({
        name: meta.stack || meta.dir || 'infrastructure',
        dir: layerDir,
        exitcode: Number(meta.exitcode || 0)
      });
    } catch (e) {
      // skip malformed meta
    }
  }

  const infraNames = layers.map(l => l.name).join(', ') || 'none';
  const anyPlanFailed = layers.some(l => l.exitcode === 1);
  const pipelineStatus = anyPlanFailed ? '🔴 **PLAN FAILED**' : '🟢 **PLAN GENERATED**';

  // --------------------------------------------------------------------------
  // C. Build Consolidated Markdown Report
  // --------------------------------------------------------------------------
  let commentBody = `## 🤖 Terraform Plan & Compliance Audit Report\n\n`;
  commentBody += `| **Target Environment** | **Infrastructure Scope** | **Security Checks** | **Pipeline Status** |\n`;
  commentBody += `| :---: | :---: | :---: | :---: |\n`;
  commentBody += `| \`${envName}\` | \`${infraNames}\` | ${hasAnyWarnings ? '⚠️ Security Warnings' : '✅ All Passed'} | ${pipelineStatus} |\n\n`;
  commentBody += `---\n\n`;

  // 1. Security Summary
  commentBody += `### 🛡️ Security & Compliance Audit\n\n`;
  commentBody += `| Security Tool | Scope | Status / Finding |\n`;
  commentBody += `| :--- | :--- | :--- |\n`;
  commentBody += `| **Gitleaks** | Repository Commits & Files | ${gitleaksStatus} |\n`;
  commentBody += `| **Trivy** | Vulnerabilities & Misconfigurations | ${trivyStatus} |\n`;
  commentBody += `| **Checkov** | IaC Policies & Best Practices | ${checkovStatus} |\n\n`;

  commentBody += `<details>\n<summary><b>🔍 View Security Scans Output & Remediation Guide</b></summary>\n\n`;
  commentBody += `#### 1️⃣ Gitleaks Scan — \`${gitleaksBadge}\`\n\`\`\`text\n${gitleaksDetail}\n\`\`\`\n\n`;
  commentBody += `#### 2️⃣ Trivy Scan — \`${trivyBadge}\`\n\`\`\`text\n${trivyDetail}\n\`\`\`\n\n`;
  commentBody += `#### 3️⃣ Checkov CIS Policies — \`${checkovBadge}\`\n`;
  commentBody += `* **Passed Checks**: \`${totalPassed}\` policies verified.\n`;

  if (failedChecks.length > 0) {
    commentBody += `\n##### ❌ Failed Checks & Fixes (${failedChecks.length})\n\n`;
    commentBody += `| Check ID | Policy Description | Impacted Resource | File | Recommended Fix |\n| :--- | :--- | :--- | :--- | :--- |\n`;
    failedChecks.forEach(f => {
      commentBody += `| **\`${f.id}\`** | ${f.desc} | \`${f.resource}\` | \`${f.file}\` | ${f.fix} |\n`;
    });
    commentBody += `\n`;
  }
  commentBody += `</details>\n\n---\n\n`;

  // 2. Infrastructure Execution Plan
  commentBody += `### 📋 Infrastructure Execution Plan\n\n`;

  if (layers.length === 0) {
    commentBody += `*No Terraform plan artifacts were produced.*\n\n`;
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
        const namesStr = g.names.map(n => `\`${n}\``).join(', ');
        commentBody += `| ${g.action} | \`${g.type}\` | ${g.names.length} | ${namesStr} |\n`;
      });
      commentBody += `\n`;

      commentBody += `<details>\n<summary><b>🔍 View Granular Resource Details (${parsed.resources.length} resources)</b></summary>\n\n`;
      commentBody += `| Action | Address | Key Attributes |\n`;
      commentBody += `| :---: | :--- | :--- |\n`;
      parsed.resources.forEach(r => {
        commentBody += `| ${r.action} | \`${r.address}\` | ${r.details} |\n`;
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
