#!/usr/bin/env node
// AgentList identity bootstrap.
//
// Usage:
//   node scripts/bootstrap.mjs                  — generate identity if missing (idempotent)
//   node scripts/bootstrap.mjs --import <nsec>  — import an existing key
//   node scripts/bootstrap.mjs --force          — regenerate even if one exists
//
// Writes ~/.agentlist/config with mode 0600. Prints a single JSON line.

import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { generateNsec, nsecToPrivkey } = await import(join(here, 'sign.mjs'));

const configDir = join(homedir(), '.agentlist');
const configFile = join(configDir, 'config');

const args = process.argv.slice(2);
const importIdx = args.indexOf('--import');
const importNsec = importIdx >= 0 ? args[importIdx + 1] : null;
const force = args.includes('--force');

if (existsSync(configFile) && !force && !importNsec) {
  console.log(JSON.stringify({ ok: true, status: 'already_configured', path: configFile }));
  process.exit(0);
}

let nsec;
if (importNsec) {
  try { nsecToPrivkey(importNsec); }
  catch (e) {
    console.error(JSON.stringify({ ok: false, error: 'INVALID_NSEC: ' + e.message }));
    process.exit(1);
  }
  nsec = importNsec;
} else {
  nsec = generateNsec();
}

mkdirSync(configDir, { recursive: true });
const content = [
  '# AgentList identity — used for voting on skills you load and use.',
  '# To import a different key: node scripts/bootstrap.mjs --import <nsec>',
  '# Keep this file private. Never commit it.',
  `NOSTR_NSEC=${nsec}`,
  '',
].join('\n');

writeFileSync(configFile, content, { mode: 0o600 });
try { chmodSync(configFile, 0o600); } catch {}

console.log(JSON.stringify({
  ok: true,
  status: importNsec ? 'imported' : 'generated',
  path: configFile,
  note: importNsec ? null : 'Fresh keypair: ~30 days of relay history required before votes are accepted. Vote anyway; failures are silent.',
}));
