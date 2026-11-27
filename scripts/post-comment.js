#!/usr/bin/env node
const fs = require('fs');
const https = require('https');

const token = process.env.GITHUB_TOKEN;
const repo = process.env.REPO;
let prNumber = process.env.PR_NUMBER;
const reportPath = process.env.REPORT_PATH;
const mode = (process.env.MODE || 'PLAN').toUpperCase();
const targetEnv = process.env.TARGET_ENV || 'default';
const stackName = process.env.STACK_NAME || 'root';
const commitSha = process.env.COMMIT_SHA || 'N/A';

let content = '';
if (reportPath && fs.existsSync(reportPath)) {
  content = fs.readFileSync(reportPath, 'utf8');
} else {
  content = `### Terraform ${mode} Report [\`${targetEnv}\` | \`${stackName}\`]\n\n- Commit: \`${commitSha}\`\n- Status: Completed (No explicit report file produced)`;
}

const safeStackId = stackName.replace(/[^a-zA-Z0-9_-]/g, '_');
const safeEnvId = targetEnv.replace(/[^a-zA-Z0-9_-]/g, '_');
const commentIdentifier = `<!-- TF-CENTRAL-BOT-${mode}-${safeEnvId}-${safeStackId} -->`;

let commentBody = `${commentIdentifier}\n${content}\n\n*Automated status posted by Centralized Terraform Bot • ${new Date().toISOString()}*`;
if (commentBody.length > 64000) {
  commentBody = commentBody.substring(0, 63950) + '\n\n...[TRUNCATED DUE TO GITHUB COMMENT LIMIT]';
}

function githubRequest(path, method, body = null) {
  return new Promise((resolve, reject) => {
    if (!token) {
      return reject(new Error("No GITHUB_TOKEN provided."));
    }

    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'Terraform-CI-CD-Bot',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function resolveMergedPrNumber() {
  if (prNumber && prNumber !== 'null' && prNumber !== 'undefined') {
    return prNumber;
  }
  if (!commitSha || commitSha === 'N/A' || !repo) {
    return null;
  }
  try {
    const res = await githubRequest(`/repos/${repo}/commits/${commitSha}/pulls`, 'GET');
    if (res.statusCode === 200 && Array.isArray(res.data) && res.data.length > 0) {
      return String(res.data[0].number);
    }
  } catch (e) {
    console.warn("Could not resolve associated PR for commit:", e.message);
  }
  return null;
}

async function run() {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile && fs.existsSync(summaryFile)) {
    try {
      fs.appendFileSync(summaryFile, `\n\n${commentBody}`);
    } catch (e) {
      console.warn("Failed to write to GITHUB_STEP_SUMMARY:", e.message);
    }
  }

  const resolvedPr = await resolveMergedPrNumber();
  if (!resolvedPr) {
    console.log("No Pull Request associated with this run. Output recorded in Actions Summary.");
    return;
  }

  try {
    const commentsRes = await githubRequest(`/repos/${repo}/issues/${resolvedPr}/comments?per_page=100`, 'GET');

    if (commentsRes.statusCode === 403 || commentsRes.statusCode === 401) {
      console.warn(`::warning::Bot lacks write permissions for PR #${resolvedPr}. Output logged to Actions Summary.`);
      return;
    }

    const existingComment = Array.isArray(commentsRes.data)
      ? commentsRes.data.find(c => c.body && c.body.includes(commentIdentifier))
      : null;

    let writeRes;
    if (existingComment) {
      console.log(`Updating existing sticky comment #${existingComment.id} on PR #${resolvedPr}`);
      writeRes = await githubRequest(`/repos/${repo}/issues/comments/${existingComment.id}`, 'PATCH', { body: commentBody });
    } else {
      console.log(`Creating new sticky comment on PR #${resolvedPr}`);
      writeRes = await githubRequest(`/repos/${repo}/issues/${resolvedPr}/comments`, 'POST', { body: commentBody });
    }

    if (writeRes.statusCode >= 400) {
      console.warn(`::warning::GitHub API returned status ${writeRes.statusCode}: ${JSON.stringify(writeRes.data)}`);
    }
  } catch (err) {
    console.warn("::warning::Encountered non-fatal error while communicating with GitHub API:", err.message);
  }
}

run().catch(err => {
  console.warn("::warning::Bot script exited with warning:", err.message);
  process.exit(0);
});
