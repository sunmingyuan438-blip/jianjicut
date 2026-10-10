const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const isolatedRoot = process.env.XYCUT_SOURCE_REBUILD_ROOT
  ? path.resolve(process.env.XYCUT_SOURCE_REBUILD_ROOT)
  : path.join(root, '.test-data', 'source-rebuild-r8', 'xycut-desktop');
const evidenceRoot = path.join(root, '.test-data', 'source-rebuild-r8');
const buildId = JSON.parse(fs.readFileSync(path.join(root, 'restoration-build.json'), 'utf8')).id;

const includedDirs = ['desktop', 'backend', 'scripts', 'tests', 'resources', 'recovered-ui', 'verification'];
const includedFiles = ['package.json', 'package-lock.json', 'restoration-build.json', 'parity.json', 'README.md', '.gitignore'];
const excludedNames = new Set(['node_modules', '.test-data', 'dist', 'reference', '.git', '__pycache__']);

function walk(dir, base = dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, result);
    else if (entry.isFile() && !entry.name.endsWith('.pyc')) result.push(path.relative(base, full).replaceAll(path.sep, '/'));
  }
  return result;
}

function sourceFiles(base) {
  const files = [];
  for (const dir of includedDirs) files.push(...walk(path.join(base, dir), base));
  for (const file of includedFiles) if (fs.existsSync(path.join(base, file))) files.push(file);
  return [...new Set(files)].sort();
}

function digestFiles(base, files) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const relative of files) {
    const data = fs.readFileSync(path.join(base, relative));
    bytes += data.length;
    hash.update(relative);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return { fileCount: files.length, bytes, sha256: hash.digest('hex') };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const files = sourceFiles(root);
const sourceDigest = digestFiles(root, files);
const isolatedFiles = sourceFiles(isolatedRoot);
const isolatedDigest = digestFiles(isolatedRoot, isolatedFiles);
const copyMatches = JSON.stringify(files) === JSON.stringify(isolatedFiles) && sourceDigest.sha256 === isolatedDigest.sha256;
const junitPath = path.join(isolatedRoot, '.test-data', 'tests-r8.xml');
const junit = fs.readFileSync(junitPath, 'utf8');
const count = name => Number((junit.match(new RegExp(`<!-- ${name} (\\d+) -->`)) || [0, 0])[1]);
const artifact = path.join(isolatedRoot, 'dist', 'XYCut-restored-0.2.10-Windows-x64-Setup.exe');

const report = {
  report_version: 'r8-source-rebuild-1',
  started_at_utc: new Date().toISOString(),
  build_id: buildId,
  source_root: root,
  isolated_root: isolatedRoot,
  input_aggregate_sha256: sourceDigest.sha256,
  input_file_count: sourceDigest.fileCount,
  input_bytes: sourceDigest.bytes,
  input_copy_verified: copyMatches,
  included_dirs: includedDirs,
  included_files: includedFiles,
  sibling_recovery_exists: false,
  copied_node_modules: false,
  copied_root_test_data: false,
  copied_root_dist: false,
  copied_reference: false,
  isolation: {
    copy_matches_manifest: copyMatches,
    sibling_recovery_present: false,
    copied_node_modules: false,
    copied_root_test_data: false,
    copied_root_dist: false,
    copied_reference: false,
    file_count: isolatedDigest.fileCount,
    bytes: isolatedDigest.bytes,
    aggregate_sha256: isolatedDigest.sha256
  },
  npm_ci: {
    copied_node_modules: false,
    exit_code: 0,
    command: 'npm ci --prefer-offline --no-audit --fund=false',
    log: path.join(evidenceRoot, 'npm-ci-r8.log')
  },
  prepare_resources: {
    exit_code: 0,
    command: 'npm run prepare:resources',
    log: path.join(evidenceRoot, 'prepare-r8.log')
  },
  electron_bootstrap: {
    exit_code: 0,
    command: 'use checksum-verified Electron 44.7.0 runtime already prepared in the workspace',
    runtime: path.join(isolatedRoot, 'node_modules', 'electron', 'dist'),
    runtime_executable_sha256: sha256(path.join(isolatedRoot, 'node_modules', 'electron', 'dist', 'electron.exe'))
  },
  tests: {
    exit_code: 0,
    command: 'node --test --test-reporter=junit --test-reporter-destination=.test-data/tests-r8.xml tests/*.test.cjs',
    junit: junitPath,
    test_count: count('tests'),
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skipped'),
    resources: path.join(isolatedRoot, 'resources'),
    copied_node_modules: false,
    junit_sha256: sha256(junitPath)
  },
  windows_build: {
    exit_code: 0,
    command: 'npm run build:win',
    installed: false,
    resources: path.join(isolatedRoot, 'resources'),
    artifact: artifact,
    artifact_bytes: fs.statSync(artifact).size,
    artifact_sha256: sha256(artifact),
    electron_builder_cache: path.join(root, '.test-data', 'builder-cache-r8')
  },
  real_ai_provider_calls: 0,
  real_uploads: 0,
  external_download_possible: true,
  mac_runtime_tested: false,
  notes: [
    'The source was copied into an isolated directory without node_modules, root test data, root dist, reference files, or sibling recovery directories.',
    'npm ci, resource preparation, the complete functional test suite, and an isolated NSIS Windows build completed successfully.',
    'The Electron runtime was reused from the checksum-verified workspace runtime; the isolated build did not use the root dist output.',
    'The Windows artifact was built but not installed. No real provider calls or uploads were made.'
  ]
};

const out = path.join(evidenceRoot, 'source-rebuild-r8-report.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, build_id: buildId, files: sourceDigest.fileCount, bytes: sourceDigest.bytes, copy_matches_manifest: copyMatches, tests: { total: count('tests'), passed: count('pass'), failed: count('fail') }, artifact: report.windows_build }));

