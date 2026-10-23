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
    section: result?.questions?.[0]?.section || 'Luyện tập',
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
