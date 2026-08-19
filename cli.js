#!/usr/bin/env node
'use strict';

/**
 * go-digital-twin-page-skills CLI
 *
 * Usage:
 *   npx github:go-code-bot/go-digital-twin-page-skills             # install into ./
 *   npx github:go-code-bot/go-digital-twin-page-skills add ./path  # install into target dir
 *   npx github:go-code-bot/go-digital-twin-page-skills sync ./path # re-sync (overwrite)
 *
 * Zero npm dependencies — uses Node built-ins only.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = 'go-code-bot';
const REPO = 'go-digital-twin-page-skills';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const API_BASE = `https://api.github.com`;

// CLI infrastructure files — excluded from skill install
const CLI_FILES = new Set(['cli.js', 'install.sh', 'package.json', 'README.md', '.gitignore', '.npmignore']);

// ─── helpers ────────────────────────────────────────────────────────────────

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'go-digital-twin-page-skills-cli/1.0',
        Accept: 'application/vnd.github.v3+json',
        ...(opts.headers || {}),
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location, opts).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'go-digital-twin-page-skills-cli/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg, level = 'info') {
  const colors = { info: '\x1b[36m', success: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
  const prefix = { info: '  →', success: '  ✓', warn: '  ⚠', error: '  ✗' };
  console.log(`${colors[level]}${prefix[level]} ${msg}${colors.reset}`);
}

// ─── core logic ─────────────────────────────────────────────────────────────

async function listRepoFiles() {
  const url = `${API_BASE}/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
  const body = await fetch(url);
  const data = JSON.parse(body);
  if (!data.tree) throw new Error('Could not list repo files from GitHub API.');
  return data.tree.filter((item) => item.type === 'blob').map((item) => item.path);
}

async function installSkills(targetDir, { overwrite = false } = {}) {
  const absTarget = path.resolve(process.cwd(), targetDir);

  console.log(`\n\x1b[1m🔧 gabriel-operator AI Persona skills\x1b[0m`);
  console.log(`   Source : https://github.com/${OWNER}/${REPO}`);
  console.log(`   Target : ${absTarget}\n`);

  let files;
  try {
    files = await listRepoFiles();
  } catch (err) {
    console.error(`\x1b[31m✗ Failed to list repo files: ${err.message}\x1b[0m`);
    process.exit(1);
  }

  const skillFiles = files.filter((f) => {
    const base = f.split('/')[0];
    return !CLI_FILES.has(base) && !CLI_FILES.has(f);
  });

  console.log(`   Found ${skillFiles.length} skill files to install.\n`);

  let written = 0;
  let skipped = 0;

  for (const relPath of skillFiles) {
    const destPath = path.join(absTarget, relPath);

    if (!overwrite && fs.existsSync(destPath)) {
      log(`Skipped (exists): ${relPath}`, 'warn');
      skipped++;
      continue;
    }

    try {
      const rawUrl = `${RAW_BASE}/${relPath}`;
      const content = await fetchBuffer(rawUrl);
      ensureDir(destPath);
      fs.writeFileSync(destPath, content);
      log(relPath, 'success');
      written++;
    } catch (err) {
      log(`Failed: ${relPath} — ${err.message}`, 'error');
    }
  }

  console.log(`\n\x1b[1m\x1b[32m✔ Done!\x1b[0m  ${written} files written, ${skipped} skipped.\n`);

  if (written > 0) {
    console.log(`\x1b[90mNext steps:\x1b[0m`);
    console.log(`  1. Read SKILL.md for the chat-config.json contract.`);
    console.log(`  2. assets/chat-config.json is normally synced from the platform after you bind git.\n`);
  }
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const [, , command, targetArg] = process.argv;

async function main() {
  if (!command || command === 'add' || command === 'install') {
    await installSkills(targetArg || '.', { overwrite: false });
  } else if (command === 'sync') {
    await installSkills(targetArg || '.', { overwrite: true });
  } else if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    console.log(pkg.version);
  } else if (command === '--help' || command === '-h') {
    console.log(`
\x1b[1mgabriel-operator AI Persona skills CLI\x1b[0m

Usage:
  npx github:go-code-bot/go-digital-twin-page-skills [command] [target-dir]

Commands:
  add [dir]     Install skill files into target dir (default: current dir). Skips existing files.
  sync [dir]    Re-sync skill files, overwriting existing files.
  install [dir] Alias for add.

Examples:
  npx github:go-code-bot/go-digital-twin-page-skills
  npx github:go-code-bot/go-digital-twin-page-skills add ./my-page-repo
  npx github:go-code-bot/go-digital-twin-page-skills sync .

Or with curl:
  curl -fsSL https://raw.githubusercontent.com/go-code-bot/go-digital-twin-page-skills/main/install.sh | bash
`);
  } else {
    console.error(`\x1b[31mUnknown command: ${command}\x1b[0m  (run with --help for usage)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
