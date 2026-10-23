import test from 'node:test';
import assert from 'node:assert/strict';
import { answerKey, formatDuration, historyStats, pageWindow, parseQuestion, resultPayload, resultSummary, reviewItems, unwrap } from '../lib/practice.mjs';
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

test('review normalizes populated ScoreUp results, including legacy answer formats', () => {
  const result = {
    total: 3, correct: 1, start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:05:30Z',
    questions: [{ section: 'Chương 1', questions: [
      { question: { _id: 'q1', content: { question: 'A?', options: ['x', 'y'] }, correct_index: 1 }, user_ans: ['B'], correct_ans: ['B'], score: 1 },
      { question: { _id: 'q2', content: { question: 'B?', options: ['x', 'y'] }, correct_index: 0 }, user_ans: [1], correct_ans: [], score: 0 },
      { question: null, user_ans: [], correct_ans: ['A'], score: 0 },
    ] }],
  };
  const items = reviewItems(result);
  assert.deepEqual(items.map(i => i.status), ['correct', 'wrong', 'skipped']);
  assert.equal(items[1].selected, 'B');
  assert.equal(items[1].correct, 'A'); // Fallback to the question's own key.
  assert.equal(items[2].question, null);
  const summary = resultSummary(result);
  assert.equal(summary.percent, 33);
  assert.equal(formatDuration(summary.duration), '5 phút 30 giây');
  assert.equal(answerKey('y', [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }]), 'B');
  assert.deepEqual(historyStats([result, { total: 2, correct: 2 }]), { count: 2, average: 67, best: 100 });
});

test('pageWindow keeps first/last pages and collapses gaps', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]); // gap of one page is shown, not '…'
  assert.deepEqual(pageWindow(5, 10), [1, '…', 4, 5, 6, '…', 10]);
  assert.deepEqual(pageWindow(10, 10), [1, '…', 9, 10]);
  assert.deepEqual(pageWindow(3, 10), [1, 2, 3, 4, '…', 10]);
});
