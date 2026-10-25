// Bài chưa nộp. Mặc định lưu trên ScoreUp (/practice-drafts) để làm tiếp ở thiết bị khác;
// nếu ScoreUp chưa có API này (404) thì lưu ở localStorage theo từng tài khoản như trước.
import { parseQuestion, unwrap } from './practice.mjs';

const MAX_DRAFTS = 20;
const keyOf = userId => `scoreplus:drafts:${userId}`;

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function loadDrafts(userId, store = browserStorage()) {
  if (!userId || !store) return [];
  try {
    const list = JSON.parse(store.getItem(keyOf(userId)) || '[]');
    return Array.isArray(list) ? list.filter(d => d?.id && Array.isArray(d.questions)) : [];
  } catch { return []; }
}

function write(userId, list, store) {
  try { store?.setItem(keyOf(userId), JSON.stringify(list)); } catch { /* hết dung lượng / bị chặn: vẫn giữ trong bộ nhớ */ }
  return list;
}

export function saveDraft(userId, draft, store = browserStorage()) {
  if (!userId || !draft?.id) return loadDrafts(userId, store);
  const list = [draft, ...loadDrafts(userId, store).filter(d => d.id !== draft.id)].slice(0, MAX_DRAFTS);
  return write(userId, list, store);
}

export function removeDraft(userId, id, store = browserStorage()) {
  return write(userId, loadDrafts(userId, store).filter(d => d.id !== id), store);
}

export function newAttemptId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Dạng thống nhất cho danh sách, dù bản nháp đến từ ScoreUp hay localStorage. */
export function draftSummary(draft) {
  const local = Array.isArray(draft.questions) && draft.questions.length && typeof draft.questions[0] === 'object';
  return {
    id: draft.id,
    subjectId: String(draft.subject_id || draft.subject?._id || ''),
    subjectName: draft.subject_name || draft.subject?.subject_name || '',
    chapter: draft.chapter || '',
    label: draft.label || '',
    instant: !!draft.instant,
    start: draft.start || null,
    updatedAt: draft.updatedAt || null,
    hintsEnabled: draft.hints_enabled ?? null,
    hintsUsed: draft.hints_used ?? null,
    answered: local ? draft.questions.filter(q => draft.answers?.[q.id]).length : Number(draft.answered_count) || 0,
    total: local ? draft.questions.length : Number(draft.total_questions) || 0,
  };
}

/** Body cho PUT /practice-drafts/:id — chỉ gửi id câu hỏi. */
export function draftBody({ subject, chapter, label, instant, start, hints_enabled, hints_used, questions, answers }) {
  const ids = questions.map(q => q.id);
  const known = new Set(ids);
  return {
    subject_id: subject._id,
    subject_name: subject.subject_name || '',
    chapter: chapter || '',
    label: label || '',
    instant: !!instant,
    start: start || null,
    ...(typeof hints_enabled === 'boolean' ? { hints_enabled } : {}),
    ...(Number.isInteger(hints_used) ? { hints_used } : {}),
    questions: ids,
    answers: Object.fromEntries(Object.entries(answers || {}).filter(([id, value]) => known.has(id) && value)),
  };
}

/**
 * @param {{ token: string, userId: string, request: Function, storage?: Storage }} options
 * Bản nháp đầy đủ (save/get): { id, subject, chapter, label, instant, start, questions: parsed[], answers }.
 */
export function createDraftStore({ token, userId, request, storage = browserStorage() }) {
  let mode = 'server';
  const path = id => `/practice-drafts/${encodeURIComponent(id)}`;
  return {
    get mode() { return mode; },
    async list() {
      if (mode === 'server') {
        try {
          const data = unwrap(await request('/practice-drafts', { token }));
          return (Array.isArray(data) ? data : []).map(draftSummary);
        } catch (e) {
          if (e.status !== 404) throw e;
          mode = 'local'; // ScoreUp bản cũ chưa có API.
        }
      }
      return loadDrafts(userId, storage).map(draftSummary);
    },
    async get(id) {
      if (mode === 'local') {
        const draft = loadDrafts(userId, storage).find(d => d.id === id);
        if (!draft) throw new Error('Không tìm thấy bài chưa nộp.');
        return draft;
      }
      const data = unwrap(await request(path(id), { token }));
      const summary = draftSummary(data);
      return {
        id: summary.id, chapter: summary.chapter, label: summary.label, instant: summary.instant, start: summary.start, hints_used: summary.hintsUsed || 0,
        subject: { _id: summary.subjectId, subject_name: summary.subjectName },
        questions: (data.questions || []).map(parseQuestion).filter(q => q.id && q.question && q.options.length),
        answers: data.answers || {},
      };
    },
    async save(draft) {
      if (mode === 'local') { saveDraft(userId, { ...draft, updatedAt: new Date().toISOString() }, storage); return draftSummary({ ...draft, updatedAt: new Date().toISOString() }); }
      return draftSummary(unwrap(await request(path(draft.id), { token, method: 'PUT', body: draftBody(draft) })));
    },
    async remove(id) {
      if (mode === 'local') { removeDraft(userId, id, storage); return; }
      await request(path(id), { token, method: 'DELETE' });
    },
  };
}
