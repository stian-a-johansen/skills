#!/usr/bin/env node
// AgentList vote CLI.
//
// Usage: node vote.mjs <listing-id>
//
// Auto-creates a Nostr identity on first run (stored at ~/.agentlist/config,
// mode 0600). No separate setup step needed. To import an existing key
// instead, run bootstrap.mjs --import nsec1... before voting.
//
// Identity source priority:
//   1. $NOSTR_NSEC env var (if set)
//   2. ~/.agentlist/config
//   3. fresh identity (generated and saved automatically)
//
// Prints a single JSON line to stdout. Exit codes:
//   0 — vote counted, or KEYPAIR_TOO_YOUNG (expected for new keys)
//   1 — real failure (network, malformed nsec, HTTP 4xx/5xx)
//   2 — usage error (missing listing id)

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { signAndVote, generateNsec } = await import(join(here, 'sign.mjs'));

const listingId = process.argv[2];
if (!listingId) {
  console.error(JSON.stringify({ ok: false, error: 'USAGE: node vote.mjs <listing-id>' }));
  process.exit(2);
}

const configDir = join(homedir(), '.agentlist');
const configFile = join(configDir, 'config');

function loadFromConfig() {
  if (!existsSync(configFile)) return null;
  const line = readFileSync(configFile, 'utf8')
    .split('\n').find(l => l.startsWith('NOSTR_NSEC='));
  return line ? line.slice('NOSTR_NSEC='.length).trim() : null;
}

function createFreshIdentity() {
  const nsec = generateNsec();
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
  return nsec;
}

// Resolve identity: env > config > fresh
const nsec = (process.env.NOSTR_NSEC?.trim()) || loadFromConfig() || createFreshIdentity();

const result = await signAndVote(listingId, nsec);
console.log(JSON.stringify(result));
process.exit(result.ok || result.error === 'KEYPAIR_TOO_YOUNG' ? 0 : 1);
