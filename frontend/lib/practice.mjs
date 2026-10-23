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
  return { certificateId: subject.question_bank_id || subject._id, questions: [{ section, multi: false, questions: items }], total: items.length, correct: items.reduce((n, q) => n + q.score, 0), start, end };
}
