import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_TOKENS,
  LinterInputError,
  formatMarkdown,
  formatTerminal,
  lintFiles
} from './linter.js';

function usage() {
  return `Usage:
  agent-rules-linter [options] [CLAUDE.md] [AGENTS.md]

Options:
  --max-lines <n>       Maximum lines per file (default: ${DEFAULT_MAX_LINES})
  --max-tokens <n>      Maximum approximate tokens per file (default: ${DEFAULT_MAX_TOKENS})
  --size-severity <s>   Size finding severity: warning or error (default: warning)
  --fail-on <s>         Exit 1 on warning or error (default: error)
  --format <f>          terminal or markdown (default: terminal)
  --output <file>       Write a Markdown report to a file
  --help                Show this help
`;
}

function valueFor(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new LinterInputError(`${option} requires a value`);
  return value;
}

function positiveInteger(value, option) {
  if (!/^\d+$/.test(value) || Number(value) < 0) {
    throw new LinterInputError(`${option} must be a non-negative integer`);
  }
  return Number(value);
}

export function parseArgs(args) {
  const options = { format: 'terminal' };
  const targets = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--max-lines') {
      options.maxLines = positiveInteger(valueFor(args, index, arg), arg);
      index += 1;
    } else if (arg === '--max-tokens') {
      options.maxTokens = positiveInteger(valueFor(args, index, arg), arg);
      index += 1;
    } else if (arg === '--size-severity') {
      options.sizeSeverity = valueFor(args, index, arg);
      index += 1;
    } else if (arg === '--fail-on') {
      options.failOn = valueFor(args, index, arg);
      index += 1;
    } else if (arg === '--format') {
      options.format = valueFor(args, index, arg);
      index += 1;
    } else if (arg === '--output') {
      options.output = valueFor(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new LinterInputError(`Unknown option: ${arg}`);
    } else {
      targets.push(arg);
    }
  }

  if (!['terminal', 'markdown'].includes(options.format)) {
    throw new LinterInputError('--format must be terminal or markdown');
  }
  if (options.sizeSeverity && !['warning', 'error'].includes(options.sizeSeverity)) {
    throw new LinterInputError('--size-severity must be warning or error');
  }
  if (options.failOn && !['warning', 'error'].includes(options.failOn)) {
    throw new LinterInputError('--fail-on must be warning or error');
  }
  return { options, targets };
}

function detectTargets(targets, cwd) {
  if (targets.length > 0) return targets;
  return ['CLAUDE.md', 'AGENTS.md'].filter((name) => fs.existsSync(path.join(cwd, name)));
}

export function main(args) {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      console.log(usage());
      return;
    }

    const cwd = process.cwd();
    const targets = detectTargets(parsed.targets, cwd);
    const result = lintFiles(targets, { ...parsed.options, cwd });
    const outputFormat = parsed.options.output ? 'markdown' : parsed.options.format;
    const report = outputFormat === 'markdown' ? formatMarkdown(result) : formatTerminal(result);

    if (parsed.options.output) {
      const outputPath = path.resolve(cwd, parsed.options.output);
      const outputStat = fs.statSync(outputPath, { bigint: true, throwIfNoEntry: false });
      // File identity also catches aliases and hard links to an input file.
      if (outputStat && result.files.some((file) => {
        const inputStat = fs.statSync(file.absoluteFile, { bigint: true });
        return outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino;
      })) {
        throw new LinterInputError(`--output must not overwrite an input file: ${parsed.options.output}`);
      }
      if (outputStat?.isDirectory()) {
        throw new LinterInputError(`--output is a directory, not a file: ${parsed.options.output}`);
      }
      try {
        fs.writeFileSync(outputPath, `${report}\n`, 'utf8');
      } catch (error) {
        // Name the path as the user typed it, not the absolute local path.
        if (error.code === 'ENOENT') {
          throw new LinterInputError(`--output directory does not exist: ${path.dirname(parsed.options.output)}`);
        }
        throw error;
      }
      console.log(`Wrote Markdown report: ${parsed.options.output}`);
    } else {
      console.log(report);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error('Run with --help for usage.');
    process.exitCode = error instanceof LinterInputError ? 2 : 2;
  }
}
