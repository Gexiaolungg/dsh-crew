import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

test('modern DSH selects the complete model and effort before waking the worker', async () => {
  const listeners = new Map();
  let selected;
  const agent = {
    session: {},
    model: {
      async select(selection) {
        await Promise.resolve();
        selected = selection;
      },
    },
    async whenIdle() {},
    followup() {
      assert.deepEqual(selected, {
        provider: 'fixture-provider',
        model: 'fixture-model',
        reasoningEffort: 'off',
      });
      assert.equal(listeners.has('agent/request'), false);
      listeners.get('session/event')(null, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    },
  };
  const ctx = {
    get() {},
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on(name, callback) { listeners.set(name, callback); } }, agent);
        return { agent };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({
    task: 'fixture only',
    cwd: '/fixture',
    tier: 'flash',
    effort: 'off',
    provider: 'fixture-provider',
    model: 'fixture-model',
  });
  await job.promise;
  assert.equal(job.status, 'done', job.error);
});

test('the hub preserves needs_input after disposal and exposes the unresolved question', async () => {
  let disposed = false, idle = Promise.resolve(), handler;
  const agent = { session: {}, async whenIdle() { await idle; }, followup() {
    idle = handler({ questions: [{ id: 'q', question: 'May I overwrite the existing file?' }] }).catch(() => {
      assert.equal(disposed, true, 'runtime must be stopped before another step could run');
    });
  } };
  const ctx = { get() {}, sessions: { async flush() {} }, agents: { async create(options) {
    await options.setup({ on(name, fn) { if (name === 'user-questions/request') handler = fn; } });
    return { agent, dispose() { disposed = true; } };
  } } };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({ task: 'fixture only', cwd: '/fixture', tier: 'flash' });
  await job.promise;
  assert.equal(job.status, 'needs_input');
  assert.equal(registry.view(job, true).questions[0].id, 'q');
  assert.equal(JSON.parse(job.result).needs_input, true);
});
