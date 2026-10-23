import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, loadDrafts, removeDraft, saveDraft } from '../lib/drafts.mjs';

function memoryStore() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

test('drafts are scoped per user, newest first, and replaced by id', () => {
  const store = memoryStore();
  saveDraft('u1', { id: 'a', questions: [], answers: {} }, store);
  saveDraft('u1', { id: 'b', questions: [], answers: {} }, store);
  saveDraft('u1', { id: 'a', questions: [{ id: 'q' }], answers: { q: 'A' } }, store);
  assert.deepEqual(loadDrafts('u1', store).map(d => d.id), ['a', 'b']);
  assert.equal(loadDrafts('u1', store)[0].answers.q, 'A');
  assert.deepEqual(loadDrafts('u2', store), []);
  assert.deepEqual(removeDraft('u1', 'a', store).map(d => d.id), ['b']);
});

test('corrupt or missing storage never throws', () => {
  const store = memoryStore();
  store.setItem('scoreplus:drafts:u1', '{not json');
  assert.deepEqual(loadDrafts('u1', store), []);
  assert.deepEqual(loadDrafts('u1', null), []);
  const throwing = { getItem: () => '[]', setItem: () => { throw new Error('quota'); } };
  assert.equal(saveDraft('u1', { id: 'a', questions: [] }, throwing).length, 1);
});

test('draft store uses ScoreUp API: PUT sends only question ids, GET parses populated questions', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === 'PUT') return { metadata: { id: 'attempt-1', subject_id: 's1', subject_name: 'Môn', answered_count: 1, total_questions: 2, updatedAt: 'now' } };
    if (path === '/practice-drafts/attempt-1') return { metadata: { id: 'attempt-1', subject_id: 's1', subject_name: 'Môn', chapter: 'chuong_1', answers: { q1: 'B' }, questions: [{ _id: 'q1', content: { question: '1+1?', options: ['1', '2'] }, correct_index: 1 }] } };
    return { metadata: [] };
  };
  const store = createDraftStore({ token: 't', userId: 'u1', request, storage: null });
  const draft = { id: 'attempt-1', subject: { _id: 's1', subject_name: 'Môn' }, chapter: 'chuong_1', questions: [{ id: 'q1', question: 'x' }, { id: 'q2', question: 'y' }], answers: { q1: 'B', ghost: 'A' } };
  const summary = await store.save(draft);
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body.questions, ['q1', 'q2']);
  assert.deepEqual(calls[0].body.answers, { q1: 'B' });
  assert.deepEqual([summary.answered, summary.total, summary.subjectName], [1, 2, 'Môn']);
  const full = await store.get('attempt-1');
  assert.equal(full.questions[0].correct, 'B');
  assert.equal(full.subject._id, 's1');
  assert.equal(store.mode, 'server');
});

test('draft store falls back to localStorage when ScoreUp has no /practice-drafts (404)', async () => {
  const storage = memoryStore();
  const request = async () => { const e = new Error('Not found'); e.status = 404; throw e; };
  const store = createDraftStore({ token: 't', userId: 'u1', request, storage });
  assert.deepEqual(await store.list(), []);
  assert.equal(store.mode, 'local');
  await store.save({ id: 'a', subject: { _id: 's1', subject_name: 'Môn' }, questions: [{ id: 'q1' }, { id: 'q2' }], answers: { q1: 'A' } });
  const [summary] = await store.list();
  assert.deepEqual([summary.id, summary.subjectId, summary.answered, summary.total], ['a', 's1', 1, 2]);
  assert.equal((await store.get('a')).questions.length, 2);
  await store.remove('a');
  assert.deepEqual(await store.list(), []);
});

test('other API errors are not mistaken for an old backend', async () => {
  const request = async () => { const e = new Error('boom'); e.status = 500; throw e; };
  const store = createDraftStore({ token: 't', userId: 'u1', request, storage: memoryStore() });
  await assert.rejects(store.list(), /boom/);
  assert.equal(store.mode, 'server');
});
