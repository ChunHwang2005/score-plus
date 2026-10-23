import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestion, resultPayload, unwrap } from '../lib/practice.mjs';
import { request } from '../lib/api.mjs';

test('parses ScoreUp unified and legacy questions', () => {
  const q = parseQuestion({ _id: 'q1', content: { question: '1 + 1?', options: ['1', '2'] }, correct_index: 1 });
  assert.equal(q.correct, 'B');
  assert.deepEqual(q.options, [{ key: 'A', text: '1' }, { key: 'B', text: '2' }]);
  const rich = value => ({ rich_text: [{ plain_text: value }] });
  const legacy = parseQuestion({ _id: 'q2', properties: { question: rich('Question'), A: rich('Yes'), B: rich('No'), correct: rich('a') } });
  assert.equal(legacy.correct, 'A');
  assert.equal(legacy.options.length, 2);
});

test('submission matches nested ScoreUp result schema and counts unanswered as zero', () => {
  const payload = resultPayload({ questions: [{ id: 'q1', correct: 'B' }, { id: 'q2', correct: 'A' }], answers: { q1: 'B' }, subject: { _id: 'subject', question_bank_id: 'bank' }, section: 'Chương 1', start: 'start', end: 'end' });
  assert.equal(payload.certificateId, 'bank');
  assert.equal(payload.correct, 1);
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.questions[0].questions[1].user_ans, []);
  assert.equal(payload.questions[0].questions[1].score, 0);
  assert.equal(payload.questions[0].questions[0].index, 0);
  assert.equal(payload.user, undefined); // Backend derives identity from Bearer.
});

test('API sends ScoreUp Bearer and preserves raw question arrays', async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    assert.ok(url.endsWith('/questions'));
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body), { subject_id: 'subject', limit: 10 });
    return new Response(JSON.stringify([{ _id: 'q1' }]));
  };
  try { assert.deepEqual(unwrap(await request('/questions', { token: 'test-token', body: { subject_id: 'subject', limit: 10 } })), [{ _id: 'q1' }]); }
  finally { global.fetch = original; }
});

test('API surfaces expired sessions instead of treating them as success', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ message: 'Invalid token' }), { status: 401 });
  try { await assert.rejects(request('/questions'), error => error.status === 401); }
  finally { global.fetch = original; }
});
