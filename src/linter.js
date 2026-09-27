import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_LINES = 300;
export const DEFAULT_MAX_TOKENS = 3000;

const SEVERITY_RANK = { warning: 1, error: 2 };
const KNOWN_PATH_PREFIXES = [
  'src', 'lib', 'bin', 'docs', 'doc', 'test', 'tests', 'scripts', 'config',
  'examples', 'example', 'fixtures', 'fixture', 'packages', 'apps', 'public',
  'assets', '.github', '.claude'
];

export class LinterInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinterInputError';
    this.exitCode = 2;
  }
}

function displayPath(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function countLines(content) {
  if (content.length === 0) return 0;
  const parts = content.split(/\r\n|\r|\n/);
  return parts.at(-1) === '' ? parts.length - 1 : parts.length;
}

function normalizeHeading(value) {
  return value
    .replace(/\s+#+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathCandidates(line) {
  const cleaned = line
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d+(?:\.\d+){1,}\b/g, ' ')
    .replace(/--[A-Za-z0-9_-]+(?:=\S+)?/g, ' ');

  const candidates = new Set();
  const relativePattern = /(?<![A-Za-z0-9@])(?:\.\.?\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\/)?/g;
  const knownPrefixPattern = new RegExp(
    `(?<![A-Za-z0-9@])(?:${KNOWN_PATH_PREFIXES.map((value) => value.replace('.', '\\.') ).join('|')})\\/[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)*`,
    'g'
  );
  const filePattern = /(?<![A-Za-z0-9@])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}(?![A-Za-z0-9])/g;

  for (const pattern of [relativePattern, knownPrefixPattern, filePattern]) {
    for (const match of cleaned.matchAll(pattern)) {
      const value = match[0].replace(/[),.;:`'\"]+$/, '');
      if (value && !value.startsWith('-')) candidates.add(value);
    }
  }
  return [...candidates];
}

// A reference counts as existing if it resolves from the working directory or from the instruction
// file's own directory, so a nested file (e.g. packages/app/CLAUDE.md) checked from the repository
// root is not reported for paths relative to itself. Neither base may look outside the working directory.
function findBrokenPaths(content, filePath, cwd, fileDirectory) {
  const findings = [];
  const seen = new Set();
  const lines = content.split(/\r\n|\r|\n/);
  const bases = fileDirectory && fileDirectory !== cwd ? [cwd, fileDirectory] : [cwd];

  lines.forEach((line, index) => {
    for (const reference of pathCandidates(line)) {
      const resolved = bases
        .map((base) => path.resolve(base, reference))
        .filter((candidate) => isInsideRoot(candidate, cwd));
      if (resolved.length === 0 || seen.has(reference)) continue;
      seen.add(reference);
      if (!resolved.some((candidate) => fs.existsSync(candidate))) {
        findings.push({
          severity: 'error',
          rule: 'broken-path',
          file: filePath,
          line: index + 1,
          message: `Local path does not exist: ${reference}`
        });
      }
    }
  });
  return findings;
}

function findDuplicateHeadings(content, filePath) {
  const findings = [];
  const headings = new Map();
  const lines = content.split(/\r\n|\r|\n/);

  lines.forEach((line, index) => {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (!match) return;
    const normalized = normalizeHeading(match[1]);
    if (!normalized) return;
    const first = headings.get(normalized);
    if (first) {
      findings.push({
        severity: 'warning',
        rule: 'duplicate-heading',
        file: filePath,
        line: index + 1,
        message: `Duplicate heading: ${match[1].trim()} (first seen at line ${first.line})`
      });
    } else {
      headings.set(normalized, { line: index + 1 });
    }
  });
  return findings;
}

export function lintFile(fileName, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const filePath = path.resolve(cwd, fileName);
  if (!fs.existsSync(filePath)) {
    throw new LinterInputError(`Target file does not exist: ${fileName}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new LinterInputError(`Target is not a file: ${fileName}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = countLines(content);
  const approximateTokens = Math.ceil(content.length / 4);
  const shownPath = displayPath(filePath, cwd);
  const findings = [];
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const sizeSeverity = options.sizeSeverity ?? 'warning';

  if (lines > maxLines) {
    findings.push({
      severity: sizeSeverity,
      rule: 'max-lines',
      file: shownPath,
      line: null,
      message: `${lines} lines exceeds configured maximum of ${maxLines}`
    });
  }
  if (approximateTokens > maxTokens) {
    findings.push({
      severity: sizeSeverity,
      rule: 'max-tokens',
      file: shownPath,
      line: null,
      message: `${approximateTokens} approximate tokens exceeds configured maximum of ${maxTokens}`
    });
  }

  findings.push(...findBrokenPaths(content, shownPath, cwd, path.dirname(filePath)));
  findings.push(...findDuplicateHeadings(content, shownPath));

  return {
    file: shownPath,
    absoluteFile: filePath,
    bytes,
    lines,
    approximateTokens,
    findings
  };
}

export function lintFiles(fileNames, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const uniqueNames = [...new Set(fileNames)];
  if (uniqueNames.length === 0) {
    throw new LinterInputError('No target files found. Pass CLAUDE.md or AGENTS.md, or create one in the current directory.');
  }

  const files = uniqueNames.map((fileName) => lintFile(fileName, { ...options, cwd }));
  const findings = files.flatMap((file) => file.findings);
  const failOn = options.failOn ?? 'error';
  const failureFindings = findings.filter((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn]);

  return {
    cwd,
    files,
    findings,
    warnings: findings.filter((finding) => finding.severity === 'warning'),
    errors: findings.filter((finding) => finding.severity === 'error'),
    failureFindings,
    result: failureFindings.length > 0 ? 'FAIL' : 'PASS',
    exitCode: failureFindings.length > 0 ? 1 : 0,
    failOn
  };
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function formatTerminal(result) {
  const warningNote = result.warnings.length ? `; ${result.warnings.length} warning(s)` : '';
  const lines = [
    'Agent Rules Linter',
    `Result: ${result.result}${warningNote}`,
    `Failure threshold: ${result.failOn}`,
    '',
    `Scanned files (${result.files.length}):`
  ];

  for (const file of result.files) {
    lines.push(`- ${file.file}: ${file.bytes} bytes, ${file.lines} lines, ~${file.approximateTokens} tokens (estimate)`);
  }

  lines.push('', `Findings (${result.findings.length}):`);
  if (result.findings.length === 0) lines.push('- None');
  for (const finding of result.findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`- ${finding.severity.toUpperCase()} [${finding.rule}] ${location} — ${finding.message}`);
  }
  return lines.join('\n');
}

export function formatMarkdown(result) {
  const lines = [
    '# Agent Rules Linter Report',
    '',
    `- Overall result: **${result.result}**`,
    `- Failure threshold: \`${result.failOn}\``,
    `- Approximate token method: UTF-16 character count divided by 4; this is not an exact provider token count.`,
    '',
    `## Scanned files (${result.files.length})`,
    '',
    '| File | Bytes | Lines | Approx. tokens |',
    '| --- | ---: | ---: | ---: |'
  ];
  for (const file of result.files) {
    lines.push(`| ${markdownCell(file.file)} | ${file.bytes} | ${file.lines} | ~${file.approximateTokens} |`);
  }

  lines.push('', `## Findings (${result.findings.length})`, '');
  if (result.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('| Severity | Rule | Location | Message |', '| --- | --- | --- | --- |');
    for (const finding of result.findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`| ${finding.severity.toUpperCase()} | ${finding.rule} | ${markdownCell(location)} | ${markdownCell(finding.message)} |`);
    }
  }
  return lines.join('\n');
}
