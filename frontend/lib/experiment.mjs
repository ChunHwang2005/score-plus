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
