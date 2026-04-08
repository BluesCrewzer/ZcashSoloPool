#!/usr/bin/env node
const { spawnSync } = require('child_process');

const files = [
  'index.js',
  'lib/zcashRpc.js',
  'lib/workManager.js',
  'lib/stratumServer.js',
  'lib/apiServer.js',
  'lib/logger.js'
];

let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`OK   ${file}`);
    continue;
  }

  failed = true;
  console.error(`FAIL ${file}`);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

if (failed) {
  console.error('\nOne or more files have syntax errors.');
  console.error('If this happened after manual copy/paste, reset files from git and re-test:');
  console.error('  git restore --source=HEAD -- index.js lib/zcashRpc.js lib/workManager.js package.json scripts/doctor.js scripts/repair-core.js');
  console.error('  npm run doctor');
  process.exit(1);
}

console.log('\nSyntax checks passed for core pool files.');
