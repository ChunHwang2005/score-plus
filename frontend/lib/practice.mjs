export function unwrap(data) { return data?.metadata ?? data; }
export function chapterName(value) {
  return String(value).replace(/^chuong[_-]/i, 'Chương ').replace(/^de[_-]/i, 'Đề ').replaceAll('_', ' ');
}
export function parseQuestion(raw) {
  const text = (key) => raw.properties?.[key]?.rich_text?.map(x => x.plain_text || x.text?.content || '').join('') || '';
  const modern = raw.content && typeof raw.content === 'object';
  const options = modern ? (raw.content.options || []).map((text, i) => ({ key: String.fromCharCode(65 + i), text: String(text) }))
    : Object.keys(raw.properties || {}).filter(k => /^[A-Za-z]$/.test(k) && text(k)).sort().map(k => ({ key: k.toUpperCase(), text: text(k) }));
  return {
    id: raw._id,
    question: modern ? raw.content.question : text('question'),
    options,
    correct: modern ? (Number.isInteger(raw.correct_index) && raw.correct_index >= 0 && raw.correct_index < options.length ? String.fromCharCode(65 + raw.correct_index) : '') : text('correct').toUpperCase().trim(),
    explanation: raw.explanation || text('hint'),
    context: text('context'),
    code: modern ? raw.content.code : text('code'),
    image: modern ? raw.content.image : text('img'),
    audio: modern ? raw.content.audio : text('audio'),
  };
}
// Chế độ phản hồi ngay (đề cương mục 5): chọn sai được thử lại; câu kết thúc khi đúng hoặc hết lượt (khớp HINT_LEVEL3_ATTEMPTS của ai-service).
export const MAX_TRIES = 3;
export function questionDone(question, answer, tries = [], max = MAX_TRIES) {
  return !!answer && (answer === question.correct || tries.length >= max);
}
// Điểm lưu ScoreUp tính theo lần chọn đầu khi được thử lại, để gợi ý không làm tăng điểm luyện tập.
export function scoredAnswers(questions, answers, tries, instant) {
  if (!instant) return answers;
  return Object.fromEntries(questions.filter(q => answers[q.id]).map(q => [q.id, tries[q.id]?.[0] || answers[q.id]]));
}
export function resultPayload({ questions, answers, subject, section, start, end }) {
  const items = questions.map((q, index) => ({ question: q.id, user_ans: answers[q.id] ? [answers[q.id]] : [], correct_ans: q.correct ? [q.correct] : [], score: answers[q.id] && answers[q.id] === q.correct ? 1 : 0, index }));
  return { certificateId: certificateIdOf(subject), questions: [{ section, multi: false, questions: items }], total: items.length, correct: items.reduce((n, q) => n + q.score, 0), start, end };
}

// ---------- Lịch sử / xem lại kết quả (GET /questions/result, /questions/result/:id) ----------
// certificateId phải khớp với resultPayload để lịch sử lọc đúng môn.
export function certificateIdOf(subject) { return subject?.question_bank_id || subject?._id || ''; }

// user_ans/correct_ans có thể là chữ cái (ScorePlus, ScoreUp), chỉ số hoặc nội dung đáp án (bản cũ).
export function answerKey(value, options = []) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < options.length ? String.fromCharCode(65 + value) : '';
  const text = String(value).trim();
  const letter = /^[A-Za-z]$/.test(text) ? text.toUpperCase() : '';
  if (letter && (!options.length || options.some(option => option.key === letter))) return letter;
  return options.find(option => option.text.trim() === text)?.key || letter;
}

export function reviewItems(result) {
  return (result?.questions || []).flatMap(section => (section.questions || []).map((item, i) => {
    const raw = item.question && typeof item.question === 'object' ? item.question : null;
    const question = raw ? parseQuestion(raw) : null;
    const options = question?.options || [];
    const selected = answerKey(item.user_ans?.[0], options);
    const correct = answerKey(item.correct_ans?.[0], options) || question?.correct || '';
    return {
      id: String(raw?._id || item.question || item._id || `${section.section}-${i}`),
      section: section.section,
      question,
      selected,
      correct,
      status: !selected ? 'skipped' : item.score > 0 ? 'correct' : 'wrong',
    };
  }));
}

export function resultSummary(result) {
  const total = Number(result?.total) || 0;
  const correct = Number(result?.correct) || 0;
  const start = Date.parse(result?.start), end = Date.parse(result?.end);
  return {
    total,
    correct,
    percent: total ? Math.round(correct / total * 100) : 0,
    duration: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
    // /questions/result/mine trả `section` gọn; bản đầy đủ (/questions/result, /result/:id) để trong questions[0].
    section: result?.section || result?.questions?.[0]?.section || '', // rỗng = kết quả cũ không lưu tên chương
    hintsEnabled: result?.hints_enabled ?? null,
    hintsUsed: result?.hints_used ?? null,
    date: result?.end || result?.createdAt || result?.start || null,
  };
}

export function historyStats(results) {
  const percents = results.map(r => resultSummary(r).percent);
  return {
    count: results.length,
    average: percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : 0,
    best: percents.length ? Math.max(...percents) : 0,
  };
}

export function scoreTone(percent) { return percent >= 80 ? 'good' : percent >= 50 ? 'mid' : 'low'; }

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút${seconds % 60 ? ` ${seconds % 60} giây` : ''}`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

export function formatDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

// Nhãn chương/nội dung của một lượt — cũng là `section` lưu lên ScoreUp, nên lịch sử hiển thị lại đúng tên này.
export function sectionOf(batch) {
  return batch?.label || (batch?.chapter ? chapterName(batch.chapter) : 'Luyện ngẫu nhiên');
}

/** Dãy nút phân trang: luôn có trang đầu/cuối và các trang quanh trang hiện tại, chỗ bị lược là '…'. */
export function pageWindow(page, pages, around = 1) {
  const keep = new Set([1, pages]);
  for (let p = page - around; p <= page + around; p++) if (p >= 1 && p <= pages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  return sorted.flatMap((p, i) => i && p - sorted[i - 1] > 2 ? ['…', p] : i && p - sorted[i - 1] === 2 ? [p - 1, p] : [p]);
}

/** Trạng thái dùng gợi ý AI của một lượt; null khi không có dữ liệu (bản ghi cũ / làm trên ScoreUp). */
export function hintStatus(enabled, used) {
  if (enabled === false) return { kind: 'off', label: 'Tắt gợi ý' };
  if (enabled !== true) return null;
  return Number(used) > 0 ? { kind: 'used', label: `Đã dùng gợi ý (${used})` } : { kind: 'unused', label: 'Không dùng gợi ý' };
}
