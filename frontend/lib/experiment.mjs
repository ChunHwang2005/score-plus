import { request } from './api.mjs';
import { unwrap } from './practice.mjs';

// Thực nghiệm gia sư AI (ScoreUp /tutor-experiments): nhóm A/B theo lớp học phần, đồng ý tham gia, log sự kiện.
// Lỗi khi tải (vd. ScoreUp chưa có API này) được coi như không tham gia thực nghiệm.
export async function loadExperiment(token, { signal } = {}) {
  const data = unwrap(await request('/tutor-experiments/me', { token, signal }));
  return data?.experiment ? data : null;
}

export async function saveConsent(token, experimentId, agree) {
  return unwrap(await request(`/tutor-experiments/${encodeURIComponent(experimentId)}/consent`, { token, body: { agree } }));
}

/** Điều kiện thực nghiệm áp dụng cho môn này không (subject_ids rỗng = mọi môn). */
export function experimentFor(study, subjectId) {
  if (!study?.experiment) return null;
  const ids = study.experiment.subject_ids || [];
  return !ids.length || ids.includes(String(subjectId)) ? study : null;
}

/**
 * Chỉ sinh viên đã đồng ý mới chịu điều kiện thực nghiệm. Từ chối/chưa trả lời → dùng ScorePlus như bình thường
 * (dữ liệu của họ cũng không được ghi, nên ép điều kiện nhóm không giúp gì cho nghiên cứu).
 */
export function activeStudy(study, subjectId, attemptId) {
  // Nộp xong bài luyện tập của đợt → hết thực nghiệm, luyện tập như bình thường.
  if (study?.consent !== true || study.completed) return null;
  if (study.experiment?.flow) return study.stage && attemptId === stageAttemptId(study.experiment.id, study.stage) ? study : null;
  // Đợt có bài luyện tập: chỉ đúng lượt đó chịu điều kiện nhóm, các lượt tự luyện khác luôn tự do.
  if (study.experiment?.practice) return attemptId === practiceAttemptId(study.experiment.id) ? study : null;
  return experimentFor(study, subjectId);
}

/** Bài luyện tập do admin cấu hình cho đợt, đang chờ sinh viên đã đồng ý làm (null nếu không có hoặc đã xong). */
export function pendingPractice(study) {
  if (study?.experiment?.flow) {
    const stage = study.experiment.stages?.find(item => item.key === study.stage);
    return study.consent === true && !study.completed && stage ? { ...stage, stage: stage.key, subject_id: study.experiment.subject_ids?.[0] } : null;
  }
  return study?.experiment?.practice && study.consent === true && !study.completed ? study.experiment.practice : null;
}

/** Id lượt cố định theo đợt: mở lại thì làm tiếp bản nháp, nộp lại không tạo kết quả trùng (idempotency_key). */
export function practiceAttemptId(experimentId) {
  return `exp-${experimentId}`;
}

export async function completeExperiment(token, experimentId, attemptId) {
  return unwrap(await request(`/tutor-experiments/${encodeURIComponent(experimentId)}/complete`, { token, body: { attempt_id: attemptId } }));
}

/**
 * Chế độ làm bài do nhóm quyết định: có gia sư → phản hồi ngay (thử lại, xin gợi ý);
 * không gia sư → làm như bài thi, nộp mới biết kết quả. Ngoài thực nghiệm theo lựa chọn của sinh viên.
 */
export function instantFor(study, subjectId, preferred, attemptId) {
  const active = activeStudy(study, subjectId, attemptId);
  return active ? (!active.experiment.flow || active.stage === 'practice') && !!active.group.tutor_enabled : !!preferred;
}

/**
 * Điều kiện thực nghiệm chốt vào lượt làm lúc bắt đầu: rút đồng ý hay tải lại đợt giữa chừng không đổi điều kiện của lượt.
 * Chỉ tính lượt có chế độ khớp nhóm (vd. bài nháp tạo trước khi đợt mở ở chế độ khác thì không).
 */
export function lockStudy(study, subjectId, instant, attemptId) {
  const active = activeStudy(study, subjectId, attemptId);
  if (!active) return null;
  const enabled = (!active.experiment.flow || active.stage === 'practice') && !!active.group.tutor_enabled;
  if (!!instant !== enabled) return null;
  return { experimentId: active.experiment.id, group: active.group.key, tutorEnabled: enabled, ...(active.experiment.flow ? { stage: active.stage } : {}) };
}

const MAX_BATCH = 50;
const MAX_QUEUE = 500;

/**
 * Hàng đợi sự kiện: gom và gửi theo lô sau `delay` ms; lỗi mạng thì giữ lại để gửi lần sau
 * (tối đa MAX_QUEUE sự kiện). flush({ keepalive: true }) dùng khi rời trang.
 */
export function createEventQueue({ send, delay = 3000, schedule = setTimeout, cancel = clearTimeout }) {
  let queue = [];
  let timer = null;
  let sending = Promise.resolve();
  function flush(options = {}) {
    if (timer) { cancel(timer); timer = null; }
    while (queue.length) {
      const batch = queue.splice(0, MAX_BATCH);
      sending = sending.then(() => send(batch, options)).catch(() => {
        queue = [...batch, ...queue].slice(0, MAX_QUEUE);
        if (!timer) timer = schedule(() => flush(), delay * 5);
      });
    }
    return sending;
  }
  return {
    push(event) {
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(event);
      if (!timer) timer = schedule(() => { timer = null; flush(); }, delay);
    },
    flush,
    get size() { return queue.length; },
  };
}

export function sendEvents(token, experimentId, events, { keepalive = false } = {}) {
  return request(`/tutor-experiments/${encodeURIComponent(experimentId)}/events`, { token, body: { events }, keepalive });
}

export const STAGE_LABELS = { pretest: 'Kiểm tra đầu vào', practice: 'Luyện tập', posttest: 'Kiểm tra đầu ra' };
export const stageAttemptId = (id, stage) => `exp-${id}-${stage}`;
export async function openStudyStage(token, id, stage) {
  return unwrap(await request(`/tutor-experiments/${encodeURIComponent(id)}/stages/${stage}/start`, { token, body: {} }));
}
export async function saveStudyDraft(token, id, stage, body) {
  return unwrap(await request(`/tutor-experiments/${encodeURIComponent(id)}/stages/${stage}/draft`, { token, method: 'PUT', body }));
}
export async function submitStudyStage(token, id, stage, body) {
  return unwrap(await request(`/tutor-experiments/${encodeURIComponent(id)}/stages/${stage}/submit`, { token, body }));
}
