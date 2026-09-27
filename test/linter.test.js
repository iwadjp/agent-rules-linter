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

  it('resolves paths in a nested instruction file from its own directory too', () => {
    const directory = tempRepo();
    write(directory, 'packages/app/docs/guide.md', '# Guide\n');
    write(directory, 'docs/shared.md', '# Shared\n');
    write(directory, 'packages/app/CLAUDE.md', 'Read docs/guide.md, docs/shared.md and docs/missing.md.\n');
    const result = lintFiles(['packages/app/CLAUDE.md'], { cwd: directory });
    const broken = result.findings.filter((finding) => finding.rule === 'broken-path');
    assert.deepEqual(broken.map((finding) => finding.message), ['Local path does not exist: docs/missing.md']);
    const cliResult = runCli(directory, ['packages/app/CLAUDE.md']);
    assert.equal(cliResult.status, 1, 'the genuinely missing path still fails');
    assert.doesNotMatch(cliResult.stdout, /docs\/guide\.md/);
  });

  it('does not look outside the working directory when resolving from the file directory', () => {
    const directory = tempRepo();
    write(directory, 'CLAUDE.md', 'See ../outside.md for details.\n');
    const result = lintFiles(['CLAUDE.md'], { cwd: directory });
    assert.equal(result.findings.filter((finding) => finding.rule === 'broken-path').length, 0);
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

  for (const [name, args] of [
    ['explicit input', ['--output', 'AGENTS.md', 'AGENTS.md']],
    ['automatically detected input', ['--output', 'AGENTS.md']],
    ['normalized path alias', ['--output', './AGENTS.md', 'AGENTS.md']],
    ['one of multiple inputs', ['--output', 'AGENTS.md', 'CLAUDE.md', 'AGENTS.md']]
  ]) {
    it(`rejects an output that overwrites ${name}`, () => {
      const directory = tempRepo();
      const original = '# Rules\n\nKeep these instructions.\n';
      const input = write(directory, 'AGENTS.md', original);
      write(directory, 'CLAUDE.md', '# Claude rules\n');

      const result = runCli(directory, args);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /output.*input file/i);
      assert.doesNotMatch(result.stdout, /Wrote Markdown report/);
      assert.equal(fs.readFileSync(input, 'utf8'), original);
      assert.equal(fs.readFileSync(path.join(directory, 'CLAUDE.md'), 'utf8'), '# Claude rules\n');
    });
  }

  for (const [name, output, expected] of [
    ['a missing parent directory', 'no dir/report.md', /--output directory does not exist: no dir/],
    ['an existing directory', 'sub dir', /--output is a directory, not a file: sub dir/]
  ]) {
    it(`explains an output path with ${name} without leaking the absolute path`, () => {
      const directory = tempRepo();
      write(directory, 'AGENTS.md', '# Rules\n');
      fs.mkdirSync(path.join(directory, 'sub dir'));

      const result = runCli(directory, ['--output', output, 'AGENTS.md']);

      assert.equal(result.status, 2);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /ENOENT|EISDIR/);
      assert.ok(!result.stderr.includes(directory), 'error must not print the absolute local path');
    });
  }

  it('rejects an output that is a hard link to an input file', () => {
    const directory = tempRepo();
    const original = '# Rules\n\nKeep these instructions.\n';
    const input = write(directory, 'AGENTS.md', original);
    const output = path.join(directory, 'report.md');
    fs.linkSync(input, output);

    const result = runCli(directory, ['--output', 'report.md', 'AGENTS.md']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /output.*input file/i);
    assert.equal(fs.readFileSync(input, 'utf8'), original);
    assert.equal(fs.readFileSync(output, 'utf8'), original);
  });

  it('can replace a separate existing report without changing the input', () => {
    const directory = tempRepo();
    const original = '# Rules\n\nKeep these instructions.\n';
    const input = write(directory, 'AGENTS.md', original);
    const output = write(directory, 'report.md', 'Old report\n');

    const result = runCli(directory, ['--output', 'report.md', 'AGENTS.md']);

    assert.equal(result.status, 0);
    assert.match(fs.readFileSync(output, 'utf8'), /# Agent Rules Linter Report/);
    assert.equal(fs.readFileSync(input, 'utf8'), original);
  });
});
