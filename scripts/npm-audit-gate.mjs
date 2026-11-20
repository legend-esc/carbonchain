#!/usr/bin/env node
// scripts/npm-audit-gate.mjs
//
// Runs `npm audit --omit=dev --json` in the specified workspace directory,
// then applies the workspace-local .audit-allowlist.json to suppress
// acknowledged advisories.
//
// Exit codes:
//   0 — no unallowlisted high/critical advisories
//   1 — one or more unallowlisted high/critical advisories found
//
// Usage:
//   node scripts/npm-audit-gate.mjs <workspace-dir>
//   e.g.  node scripts/npm-audit-gate.mjs api
//         node scripts/npm-audit-gate.mjs frontend
//
// The script prints a GitHub Actions annotation (::error::) for every
// blocking advisory so the PR diff shows inline failure reasons.

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const workspaceArg = process.argv[2];
if (!workspaceArg) {
  console.error('Usage: node scripts/npm-audit-gate.mjs <workspace-dir>');
  process.exit(1);
}

const workspaceDir = resolve(__dirname, '..', workspaceArg);
const allowlistPath = join(workspaceDir, '.audit-allowlist.json');

// ── Load allowlist ──────────────────────────────────────────────────────────
let allowlistedIds = new Set();
try {
  const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  allowlistedIds = new Set((raw.allowlist ?? []).map((e) => e.id ?? e));
} catch {
  // No allowlist file is fine — nothing is suppressed.
}

// ── Run npm audit ────────────────────────────────────────────────────────────
let auditJson;
try {
  const output = execSync('npm audit --omit=dev --json', {
    cwd: workspaceDir,
    // npm audit exits 1 when vulnerabilities exist; we handle that ourselves.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  auditJson = JSON.parse(output.toString('utf8'));
} catch (err) {
  // npm audit exits non-zero if vulnerabilities were found — parse stdout.
  if (err.stdout) {
    try {
      auditJson = JSON.parse(err.stdout.toString('utf8'));
    } catch {
      console.error('Failed to parse npm audit JSON output.');
      console.error(err.stderr?.toString('utf8') ?? err.message);
      process.exit(1);
    }
  } else {
    console.error('npm audit failed unexpectedly:', err.message);
    process.exit(1);
  }
}

// ── Evaluate results ─────────────────────────────────────────────────────────
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const ANNOTATE_SEVERITIES = new Set(['moderate']);

const vulns = auditJson.vulnerabilities ?? {};
let blockingCount = 0;
let moderateCount = 0;

for (const [pkgName, vuln] of Object.entries(vulns)) {
  const severity = vuln.severity;
  // Collect all advisory IDs for this vulnerability.
  const advisoryIds = (vuln.via ?? [])
    .filter((v) => typeof v === 'object' && v.source)
    .map((v) => String(v.source));

  const allAllowlisted =
    advisoryIds.length > 0 && advisoryIds.every((id) => allowlistedIds.has(id));

  if (BLOCKING_SEVERITIES.has(severity)) {
    if (allAllowlisted) {
      console.log(
        `[ALLOWLISTED] ${pkgName} (${severity}) — advisory IDs: ${advisoryIds.join(', ')}`,
      );
    } else {
      blockingCount++;
      const ids = advisoryIds.length > 0 ? ` (advisory: ${advisoryIds.join(', ')})` : '';
      console.error(`::error::${workspaceArg}: ${pkgName} has a ${severity} vulnerability${ids}`);
      // Print fix suggestion if available.
      if (vuln.fixAvailable) {
        const fix =
          typeof vuln.fixAvailable === 'object'
            ? `npm install ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
            : 'npm audit fix';
        console.error(`  → Fix: ${fix}`);
      }
    }
  } else if (ANNOTATE_SEVERITIES.has(severity)) {
    moderateCount++;
    const ids = advisoryIds.length > 0 ? ` (advisory: ${advisoryIds.join(', ')})` : '';
    console.log(
      `::warning::${workspaceArg}: ${pkgName} has a ${severity} vulnerability${ids}`,
    );
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
const meta = auditJson.metadata ?? {};
const totalVulns = meta.vulnerabilities ?? {};
console.log(
  `\nnpm audit summary for ${workspaceArg}/: ` +
    `critical=${totalVulns.critical ?? 0} high=${totalVulns.high ?? 0} ` +
    `moderate=${totalVulns.moderate ?? 0} low=${totalVulns.low ?? 0}`,
);

if (blockingCount > 0) {
  console.error(
    `\n✖ ${blockingCount} unallowlisted high/critical advisory(s) found in ${workspaceArg}/. ` +
      `Fix them or add them to ${workspaceArg}/.audit-allowlist.json with a justification.`,
  );
  process.exit(1);
}

if (moderateCount > 0) {
  console.log(
    `⚠  ${moderateCount} moderate advisory(s) annotated (non-blocking). ` +
      `Address them in a follow-up.`,
  );
}

console.log(`✔ npm audit gate passed for ${workspaceArg}/.`);
process.exit(0);
