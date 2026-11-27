#!/usr/bin/env node

/**
 * ==============================================================================
 * Terraform CD Deployment Audit Report Generator
 * Aggregates applied layers, state paths, outputs.json, and provenance metadata
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

function formatStatePath(cloud, bucket, env, stackName) {
  const prefix = `${env}/${stackName}`;
  if (cloud === 'gcp') return `gs://${bucket}/${prefix}/default.tfstate`;
  if (cloud === 'aws') return `s3://${bucket}/${prefix}/terraform.tfstate`;
  if (cloud === 'azure') {
    const key = `${env}-${stackName}.tfstate`.replace(/\//g, '-');
    return `azurerm://${bucket}/tfstate/${key}`;
  }
  return `${bucket}/${prefix}`;
}

function main() {
  const args = parseArgs();
  const artifactsDir = args.artifacts || '.cd-artifacts';
  const envRaw = args.env || 'dev';
  const envName = envRaw.toUpperCase();
  const cloud = (args.cloud || 'gcp').toLowerCase();
  const defaultBucket = args.bucket || `${envRaw}-tfstate-bucket`;
  const commitSha = args.sha || 'latest';
  const runId = args.runid || 'N/A';
  const outputPath = args.out || 'final-apply-report.md';

  const metaFiles = findFilesRecursive(artifactsDir, 'meta.json');
  const layers = [];

  for (const metaPath of metaFiles) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      layers.push({
        name: meta.stack || meta.dir || 'infrastructure',
        dir: path.dirname(metaPath),
        env: meta.env || envRaw,
        cloud: (meta.cloud || cloud).toLowerCase(),
        bucket: meta.bucket || defaultBucket,
        exitcode: Number(meta.exitcode || 0)
      });
    } catch (e) {
      // skip malformed meta
    }
  }

  const anyFailed = layers.some(l => l.exitcode !== 0) || layers.length === 0;
  const statusBadge = anyFailed ? '🔴 **DEPLOYMENT FAILED**' : '🟢 **DEPLOYMENT SUCCESSFUL**';
  const infraPath = layers.map(l => l.name).join(' ➔ ') || 'none';
  const timestamp = new Date().toISOString();

  let commentBody = `## 🚀 Terraform CD Deployment Audit Report\n\n`;
  commentBody += `| **Target Environment** | **Deployment Status** | **Applied Layers** | **Execution Trigger** |\n`;
  commentBody += `| :---: | :---: | :---: | :---: |\n`;
  commentBody += `| \`${envName}\` | ${statusBadge} | \`${infraPath}\` | Push / Merge to \`main\` |\n\n`;
  commentBody += `---\n\n`;
  commentBody += `### 📦 Applied Infrastructure Layers\n\n`;

  for (const layer of layers) {
    const statePrefix = `${layer.env}/${layer.name}`;
    const statePath = formatStatePath(layer.cloud, layer.bucket, layer.env, layer.name);
    const outputFile = path.join(layer.dir, 'outputs.json');
    const logFile = path.join(layer.dir, 'apply.log');

    commentBody += `#### 🔹 **${layer.name.toUpperCase()}** (\`${statePrefix}\`)\n`;
    commentBody += `* **State Path**: \`${statePath}\`\n`;

    if (layer.exitcode !== 0) {
      commentBody += `* **Status**: ❌ Apply failed (exit code \`${layer.exitcode}\`).\n\n`;
      const rawLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : 'Apply log unavailable.';
      const safeLog = rawLog.length > 15000 ? rawLog.substring(0, 15000) + '\n...[TRUNCATED]' : rawLog;
      commentBody += `<details open>\n<summary><b>📜 View Apply Error Log</b></summary>\n\n\`\`\`text\n${safeLog}\n\`\`\`\n\n</details>\n\n`;
      continue;
    }

    commentBody += `* **Status**: ✅ All resources successfully provisioned.\n\n`;

    if (fs.existsSync(outputFile)) {
      try {
        const outputs = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        const outEntries = Object.entries(outputs);
        if (outEntries.length > 0) {
          commentBody += `<details open>\n<summary><b>Click to View Deployed Outputs (${outEntries.length} Outputs)</b></summary>\n\n`;
          commentBody += `| Output Name | Value |\n| :--- | :--- |\n`;
          for (const [key, obj] of outEntries) {
            const valStr = typeof obj.value === 'object' ? JSON.stringify(obj.value) : String(obj.value);
            commentBody += `| \`${key}\` | \`${valStr}\` |\n`;
          }
          commentBody += `\n</details>\n\n`;
        }
      } catch (e) {
        // ignore output parse errors
      }
    }
  }

  commentBody += `---\n\n`;
  commentBody += `### 📋 Audit & Provenance Metadata\n`;
  commentBody += `* **Merged PR**: \`#__PR_NUMBER__\`\n`;
  commentBody += `* **Commit SHA**: \`${commitSha}\`\n`;
  commentBody += `* **GitHub Run ID**: \`${runId}\`\n`;
  commentBody += `* **Deployment Timestamp**: \`${timestamp}\`\n`;

  fs.writeFileSync(outputPath, commentBody);
  console.log(`Consolidated apply audit report written to: ${outputPath}`);
}

main();
