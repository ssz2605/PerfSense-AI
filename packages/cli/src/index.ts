#!/usr/bin/env node
import { run as benchmark } from './commands/benchmark';
import { run as baseline } from './commands/baseline';
import { run as check } from './commands/check';
import { run as report } from './commands/report';
import { run as cache } from './commands/cache';

const args = process.argv.slice(2);

function printUsage(): void {
  console.log(
    'Usage:\n' +
    '  perfsense benchmark --pages <files> --runs <n> [--out <file>] [--config <config.json>] [--metrics <list>]\n' +
    '  perfsense baseline save --from <results.json> --out <baseline.json>\n' +
    '  perfsense baseline load --file <baseline.json>\n' +
    '  perfsense check --baseline <baseline.json> --current <results.json> [--config <config.json>] [--statistical] [--format json] [--no-evidence]\n' +
    '  perfsense report --baseline <baseline.json> --current <results.json> [--config <config.json>] [--repository <dir>] [--source-maps <dir>] [--ai-provider openai] [--ai-model gpt-4o-mini] [--format json]\n' +
    '  perfsense cache --changed-files "file1,file2,..."\n'
  );
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printUsage();
  process.exit(0);
}

const command = args[0];
const rest = args.slice(1);

if (command === 'benchmark') {
  benchmark(rest).catch((err: Error) => {
    console.error('Benchmark failed:', err.message);
    process.exit(1);
  });
} else if (command === 'baseline') {
  baseline(rest);
} else if (command === 'check') {
  check(rest).catch((err: Error) => {
    console.error('Check failed:', err.message);
    process.exit(1);
  });
} else if (command === 'report') {
  report(rest).catch((err: Error) => {
    console.error('Report failed:', err.message);
    process.exit(1);
  });
} else if (command === 'cache') {
  cache(rest).catch((err: Error) => {
    console.error('Cache check failed:', err.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
