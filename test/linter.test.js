import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { lintFiles } from '../src/linter.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cli = path.join(repoRoot, 'bin', 'agent-rules-linter.js');
const tempDirectories = [];

function tempRepo() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rules-linter-'));
  tempDirectories.push(directory);
  return directory;
}

function write(directory, name, content) {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function runCli(directory, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: 'utf8'
  });
}

afterEach(() => {
  while (tempDirectories.length) fs.rmSync(tempDirectories.pop(), { recursive: true, force: true });
});

describe('Agent Rules Linter MVP', () => {
  it('reports a missing target file as CLI misuse', () => {
    const directory = tempRepo();
    const result = runCli(directory, ['missing.md']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not exist/);
  });

  it('passes a valid small instruction file', () => {
    const directory = tempRepo();
    write(directory, 'CLAUDE.md', '# Rules\n\nUse the repository scripts.\n');
    const result = runCli(directory, []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Result: PASS/);
    assert.match(result.stdout, /~\d+ tokens \(estimate\)/);
  });

  it('checks line and approximate-token thresholds', () => {
    const directory = tempRepo();
    const file = write(directory, 'CLAUDE.md', 'one\ntwo\nthree\n');
    const result = lintFiles([file], { cwd: directory, maxLines: 2, maxTokens: 1 });
    assert.deepEqual(result.findings.map((finding) => finding.rule), ['max-lines', 'max-tokens']);
    assert.equal(result.exitCode, 0, 'warnings do not fail the default error threshold');
    const strict = lintFiles([file], { cwd: directory, maxLines: 2, maxTokens: 1, failOn: 'warning' });
    assert.equal(strict.exitCode, 1);
  });

  it('reports broken and existing local path references', () => {
    const directory = tempRepo();
    write(directory, 'docs/guide.md', '# Guide\n');
    const file = write(directory, 'AGENTS.md', 'Read docs/guide.md and docs/missing.md.\nSee https://example.com/docs/missing.md.\n');
    const result = lintFiles([file], { cwd: directory });
    assert.equal(result.findings.filter((finding) => finding.rule === 'broken-path').length, 1);
    assert.match(result.findings[0].message, /docs\/missing\.md/);
  });

  it('reports duplicate normalized headings', () => {
    const directory = tempRepo();
    const file = write(directory, 'CLAUDE.md', '## Testing\n\n##  testing  \n');
    const result = lintFiles([file], { cwd: directory });
    assert.equal(result.findings.filter((finding) => finding.rule === 'duplicate-heading').length, 1);
    assert.equal(result.findings[0].line, 3);
  });

  it('supports multiple input files and Markdown output', () => {
    const directory = tempRepo();
    write(directory, 'CLAUDE.md', '# Claude rules\n');
    write(directory, 'AGENTS.md', '# Agent rules\n');
    const result = runCli(directory, ['--format', 'markdown', 'CLAUDE.md', 'AGENTS.md']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /# Agent Rules Linter Report/);
    assert.match(result.stdout, /Scanned files \(2\)/);
  });

  it('writes a Markdown report and exposes CI exit codes', () => {
    const directory = tempRepo();
    write(directory, 'CLAUDE.md', '# Rules\n\n## Rules\n');
    const output = runCli(directory, ['--output', 'report.md', 'CLAUDE.md']);
    assert.equal(output.status, 0, 'duplicate headings are warnings by default');
    assert.match(fs.readFileSync(path.join(directory, 'report.md'), 'utf8'), /duplicate-heading/);
    const strict = runCli(directory, ['--fail-on', 'warning', 'CLAUDE.md']);
    assert.equal(strict.status, 1);
  });
});
