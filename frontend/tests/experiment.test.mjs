import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue, experimentFor } from '../lib/experiment.mjs';

test('experiment applies only to configured subjects', () => {
  const study = { experiment: { id: 'e1', subject_ids: ['s1'] }, group: { key: 'A', tutor_enabled: false }, consent: true };
  assert.equal(experimentFor(study, 's1'), study);
  assert.equal(experimentFor(study, 's2'), null);
  assert.equal(experimentFor({ ...study, experiment: { id: 'e1', subject_ids: [] } }, 's2')?.group.key, 'A');
  assert.equal(experimentFor(null, 's1'), null);
});

test('event queue batches, retries failures and flushes with keepalive', async () => {
  const sent = [];
  let fail = true;
  const timers = [];
  const queue = createEventQueue({
    send: async (events, options) => { if (fail) { fail = false; throw new Error('offline'); } sent.push({ n: events.length, options }); },
    schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {},
  });
  for (let i = 0; i < 60; i++) queue.push({ type: 'answer', i });
  assert.equal(timers.length, 1); // một lần hẹn giờ cho cả lô
  await queue.flush();
  await queue.flush({ keepalive: true }); // lô đầu lỗi được giữ lại và gửi lại
  assert.deepEqual(sent.map(s => s.n), [10, 50]);
  assert.equal(sent.at(-1).options.keepalive, true);
  assert.equal(queue.size, 0);
});
