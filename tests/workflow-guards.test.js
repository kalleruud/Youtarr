const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const workflow = (name) => readFileSync(`.github/workflows/${name}.yml`, 'utf8');
const upstream = "github.repository == 'DialmasterOrg/Youtarr'";

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing job ${name}`);
  return match[1];
}

test('release publishing jobs require the upstream repository on all triggers', () => {
  for (const [file, name] of [['release', 'release'], ['release-rc', 'release-rc']]) {
    assert.match(job(workflow(file), name), new RegExp(`^    if: ${upstream} && !contains\\(`, 'm'));
  }
});

test('Pages and badge publishing require upstream, including manual dispatch', () => {
  assert.ok(job(workflow('publish-docs'), 'build').includes(`    if: ${upstream}\n`));
  assert.match(job(workflow('publish-docs'), 'deploy'), /^    needs: build$/m);
  assert.ok(job(workflow('coverage-badges'), 'update-badges').includes(`${upstream} &&\n      (github.event_name == 'workflow_dispatch' ||`));
});

test('both upstream Claude jobs require the repository guard', () => {
  const source = workflow('claude');
  assert.ok(job(source, 'auto-review').includes(`if: ${upstream} && github.event_name == 'pull_request'`));
  assert.ok(job(source, 'manual-claude').includes(`${upstream} &&\n      (github.event_name == 'issue_comment'`));
});

test('fork PR checks and coverage reporting remain enabled', () => {
  const ci = workflow('ci');
  assert.match(ci, /pull_request:\n    branches: \[ main, dev \]/);
  for (const name of ['lint', 'test-backend', 'test-frontend', 'check-all']) {
    assert.ok(!job(ci, name).includes(upstream));
  }
  assert.ok(job(workflow('coverage-comment'), 'post-coverage-comment').includes("github.event.workflow_run.event == 'pull_request'"));
});
