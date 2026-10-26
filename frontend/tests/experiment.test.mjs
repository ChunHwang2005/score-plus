import test from 'node:test';
import assert from 'node:assert/strict';
import { activeStudy, createEventQueue, experimentFor, instantFor, lockStudy, pendingPractice, practiceAttemptId } from '../lib/experiment.mjs';

test('experiment applies only to configured subjects', () => {
  const study = { experiment: { id: 'e1', subject_ids: ['s1'] }, group: { key: 'A', tutor_enabled: false }, consent: true };
  assert.equal(experimentFor(study, 's1'), study);
  assert.equal(experimentFor(study, 's2'), null);
  assert.equal(experimentFor({ ...study, experiment: { id: 'e1', subject_ids: [] } }, 's2')?.group.key, 'A');
  assert.equal(experimentFor(null, 's1'), null);
});

test('only consenting students get experiment conditions', () => {
  const study = { experiment: { id: 'e1', subject_ids: [] }, group: { key: 'A', tutor_enabled: false }, consent: true };
  assert.equal(activeStudy(study, 's1'), study);
  assert.equal(activeStudy({ ...study, consent: false }, 's1'), null); // từ chối → ScorePlus bình thường
  assert.equal(activeStudy({ ...study, consent: null }, 's1'), null); // chưa trả lời
});

test('group decides the mode: tutor → instant feedback, no tutor → exam mode', () => {
  const tutor = { experiment: { id: 'e1', subject_ids: [] }, group: { key: 'B', tutor_enabled: true }, consent: true };
  const control = { ...tutor, group: { key: 'A', tutor_enabled: false } };
  assert.equal(instantFor(tutor, 's1', false), true);
  assert.equal(instantFor(control, 's1', true), false); // nhóm không gia sư: nộp mới biết kết quả
  assert.equal(instantFor({ ...control, consent: false }, 's1', true), true); // từ chối → theo lựa chọn của sinh viên
});

test('experiment condition is locked per attempt only when the attempt mode matches the group', () => {
  const tutor = { experiment: { id: 'e1', subject_ids: [] }, group: { key: 'B', tutor_enabled: true }, consent: true };
  const control = { ...tutor, group: { key: 'A', tutor_enabled: false } };
  assert.deepEqual(lockStudy(tutor, 's1', true), { experimentId: 'e1', group: 'B', tutorEnabled: true });
  assert.deepEqual(lockStudy(control, 's1', false), { experimentId: 'e1', group: 'A', tutorEnabled: false });
  assert.equal(lockStudy(tutor, 's1', false), null); // bài nháp chế độ bài thi tạo trước khi đợt mở
  assert.equal(lockStudy(control, 's1', true), null);
  assert.equal(lockStudy({ ...tutor, consent: false }, 's1', true), null);
});

test('study practice: pending until submitted, then the experiment disappears', () => {
  const practice = { subject_id: 's1', chapter: 'chuong_1', question_count: 10 };
  const study = { experiment: { id: 'e1', subject_ids: [], practice }, group: { key: 'B', tutor_enabled: true }, consent: true, completed: false };
  assert.equal(pendingPractice(study), practice);
  assert.equal(pendingPractice({ ...study, consent: null }), null); // chưa đồng ý: hộp thoại hỏi đồng ý trước
  assert.equal(pendingPractice({ ...study, experiment: { ...study.experiment, practice: null } }), null); // đợt luyện tự do
  const done = { ...study, completed: true };
  assert.equal(pendingPractice(done), null);
  assert.equal(activeStudy(done, 's1'), null); // làm xong → không khoá chế độ nữa
  assert.equal(instantFor({ ...done, group: { key: 'A', tutor_enabled: false } }, 's1', true), true);
  assert.equal(practiceAttemptId('64b000000000000000000001'), 'exp-64b000000000000000000001');
  assert.match(practiceAttemptId('64b000000000000000000001'), /^[A-Za-z0-9_-]{8,64}$/); // hợp lệ làm draftId/idempotency_key ở ScoreUp
});

test('experiment with a practice: only the practice attempt follows group conditions', () => {
  const control = { experiment: { id: 'e1', subject_ids: [], practice: { subject_id: 's1', chapter: '', question_count: 10 } }, group: { key: 'A', tutor_enabled: false }, consent: true, completed: false };
  const id = practiceAttemptId('e1');
  assert.equal(activeStudy(control, 's1'), null); // màn hình chọn môn: tự do
  assert.equal(instantFor(control, 's1', true), true); // lượt tự luyện: theo lựa chọn của sinh viên
  assert.equal(lockStudy(control, 's1', true, 'other-attempt-1'), null);
  assert.equal(instantFor(control, 's1', true, id), false); // bài của đợt: nhóm A làm như bài thi
  assert.deepEqual(lockStudy(control, 's1', false, id), { experimentId: 'e1', group: 'A', tutorEnabled: false });
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

test('three stages: tests disable AI in both groups and practice follows within-class assignment', () => {
  const stages = ['pretest', 'practice', 'posttest'].map(key => ({ key, title: key, question_count: 10 }));
  for (const group of ['A', 'B']) {
    for (const stage of ['pretest', 'practice', 'posttest']) {
      const study = { experiment: { id: 'e1', flow: true, subject_ids: ['s1'], stages }, stage, group: { key: group, tutor_enabled: group === 'B' }, consent: true, completed: false };
      const id = `exp-e1-${stage}`;
      const enabled = stage === 'practice' && group === 'B';
      assert.equal(pendingPractice(study).stage, stage);
      assert.equal(pendingPractice(study).subject_id, 's1');
      assert.equal(instantFor(study, 's1', true, id), enabled);
      assert.deepEqual(lockStudy(study, 's1', enabled, id), { experimentId: 'e1', group, tutorEnabled: enabled, stage });
      assert.equal(lockStudy(study, 's1', !enabled, id), null);
      assert.equal(activeStudy(study, 's1', `exp-e1-${stage === 'pretest' ? 'posttest' : 'pretest'}`), null);
      assert.equal(activeStudy({ ...study, completed: true }, 's1', id), null);
      assert.equal(pendingPractice({ ...study, completed: true }), null);
      assert.equal(pendingPractice({ ...study, consent: false }), null);
      assert.equal(lockStudy(study, 's1', true, 'regular-practice'), null);
    }
  }
});
