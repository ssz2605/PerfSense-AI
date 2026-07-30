import * as core from '@actions/core';
import * as github from '@actions/github';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('api-key');
    const aiProvider = core.getInput('ai-provider') || 'openai';
    const aiModel = core.getInput('ai-model') || 'gpt-4o-mini';
    const failOnRegression = core.getInput('fail-on-regression') === 'true';
    const configPath = core.getInput('config') || './perfsense.config.json';
    const baselineRef = core.getInput('baseline-ref') || 'HEAD~1';

    const repoPath = process.env.GITHUB_WORKSPACE || process.cwd();

    // Determine changed files for caching
    const changedFiles = getChangedFiles(repoPath, baselineRef);
    core.info(`Changed files: ${changedFiles.join(', ')}`);

    if (shouldSkipBenchmark(changedFiles)) {
      core.info('No performance-relevant changes detected. Skipping benchmark.');
      return;
    }

    // Run benchmark
    core.info('Running benchmark...');
    execSync(`npx perfsense benchmark --config "${configPath}" --out results.json`, {
      cwd: repoPath,
      stdio: 'inherit',
    });

    // Load or create baseline
    const baselineFile = path.join(repoPath, 'baseline.json');
    const baselineExists = fs.existsSync(baselineFile);

    if (!baselineExists) {
      // First run: save current as baseline
      execSync(`npx perfsense baseline save --from results.json --out "${baselineFile}"`, {
        cwd: repoPath,
        stdio: 'inherit',
      });
      core.info('No baseline found. Saved current results as baseline.');
      return;
    }

    // Run check with evidence and correlation
    core.info('Running check...');
    const checkOutput = execSync(
      `npx perfsense check --baseline "${baselineFile}" --current results.json --config "${configPath}" --statistical --format json`,
      { cwd: repoPath, encoding: 'utf-8' },
    );

    const checkResult = JSON.parse(checkOutput.trim());

    if (checkResult.summary?.failed) {
      core.info('Regressions detected. Running report...');

      // Generate PR comment
      const reportOutput = execSync(
        `npx perfsense report --baseline "${baselineFile}" --current results.json --config "${configPath}" --repository "${repoPath}" --source-maps "${path.join(repoPath, 'dist')}" ${apiKey ? `--ai-provider ${aiProvider} --ai-model ${aiModel} --api-key ${apiKey}` : ''}`,
        { cwd: repoPath, encoding: 'utf-8' },
      );

      // Post PR comment
      if (github.context.payload.pull_request) {
        const octokit = github.getOctokit(core.getInput('github-token', { required: true }));
        const { owner, repo } = github.context.repo;
        const issueNumber = github.context.payload.pull_request.number;

        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: reportOutput,
        });

        core.info('PR comment posted successfully.');
      } else {
        core.info('Not a pull request. Outputting report to stdout.');
        process.stdout.write(reportOutput);
      }
    }

    // Fail if configured
    if (failOnRegression && checkResult.summary?.failed) {
      core.setFailed('Performance regressions detected.');
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

function getChangedFiles(repoPath: string, baselineRef: string): string[] {
  try {
    const output = execSync(
      `git diff --name-only ${baselineRef}...HEAD`,
      { cwd: repoPath, encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function shouldSkipBenchmark(changedFiles: string[]): boolean {
  const bundleExtensions = new Set(['.js', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.vue', '.svelte']);
  return !changedFiles.some((f) => bundleExtensions.has(path.extname(f)));
}

run();
