import path from 'path';

const bundleExtensions = new Set(['.js', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.vue', '.svelte']);

export function shouldSkipBenchmark(changedFiles: string[]): boolean {
  return !changedFiles.some((f) => bundleExtensions.has(path.extname(f)));
}

export async function run(argv: string[]): Promise<void> {
  let changedFilesArg = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--changed-files' && i + 1 < argv.length) {
      changedFilesArg = argv[++i];
    }
  }

  if (!changedFilesArg) {
    console.error('Usage: perfsense cache --changed-files "file1,file2,file3"');
    process.exit(1);
  }

  const changedFiles = changedFilesArg.split(',').map((f) => f.trim()).filter(Boolean);

  if (shouldSkipBenchmark(changedFiles)) {
    console.log('No performance-relevant changes detected.');
    process.exit(0);
  } else {
    console.log('Performance-relevant changes detected.');
    process.exit(0);
  }
}
