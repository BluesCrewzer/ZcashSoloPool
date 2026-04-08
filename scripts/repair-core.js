#!/usr/bin/env node
const { spawnSync } = require('child_process');

const files = [
  'index.js',
  'lib/zcashRpc.js',
  'lib/workManager.js',
  'package.json',
  'scripts/doctor.js',
  'scripts/repair-core.js'
];

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit' });
}

const hasGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (hasGit.status !== 0) {
  console.error('Not a git repository. Cannot auto-repair core files.');
  process.exit(1);
}

let restored = false;
for (const file of files) {
  const res = spawnSync('git', ['restore', '--source=HEAD', '--', file], { stdio: 'inherit' });
  if (res.status === 0) {
    restored = true;
  }
}

if (!restored) {
  console.error('Failed to restore core files from git.');
  process.exit(1);
}

console.log('\nRepaired core/tooling files from HEAD. Running syntax checks...\n');

const fs = require('fs');
if (fs.existsSync('scripts/doctor.js')) {
  const doctor = run(process.execPath, ['scripts/doctor.js']);
  process.exit(doctor.status || 0);
}

console.warn('scripts/doctor.js is missing after repair; using fallback syntax checks.');
const fallback = run(process.execPath, ['--check', 'index.js']);
if (fallback.status !== 0) {
  process.exit(fallback.status || 1);
}

const rpcCheck = run(process.execPath, ['--check', 'lib/zcashRpc.js']);
if (rpcCheck.status !== 0) {
  process.exit(rpcCheck.status || 1);
}

const workCheck = run(process.execPath, ['--check', 'lib/workManager.js']);
process.exit(workCheck.status || 0);
