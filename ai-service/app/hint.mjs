// Kiểm tra request và dựng prompt theo cấp gợi ý; client không gửi prompt/system tùy ý.
const LIMITS = { question: 4000, context: 6000, code: 6000, option: 1000, explanation: 6000, options: 10, meta: 200 };

export class ValidationError extends Error {}

// Giá trị mặc định của UnifiedQuestion.explanation trong ScoreUp: không phải lời giải, coi như thiếu dữ liệu.
const PLACEHOLDER_EXPLANATIONS = new Set(['câu hỏi chưa có lời giải thích']);
const realExplanation = value => PLACEHOLDER_EXPLANATIONS.has(value.toLowerCase().replace(/[.\s]+$/, '')) ? '' : value;

function text(value, field, max, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`Thiếu trường ${field}.`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`Trường ${field} phải là chuỗi.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`Thiếu trường ${field}.`);
  if (trimmed.length > max) throw new ValidationError(`Trường ${field} quá dài (tối đa ${max} ký tự).`);
  return trimmed;
}

function count(value, field, min, max) {
  if (value === undefined || value === null) return min;
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw new ValidationError(`Trường ${field} phải là số nguyên không âm.`);
  return Math.max(min, Math.min(max, value));
}

export function parseHintRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Dữ liệu yêu cầu không hợp lệ.');
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > LIMITS.options) {
    throw new ValidationError(`Câu hỏi cần từ 2 đến ${LIMITS.options} lựa chọn.`);
  }
  const options = body.options.map((option, index) => ({
    key: text(option?.key, `options[${index}].key`, 4, true),
    text: text(option?.text, `options[${index}].text`, LIMITS.option),
  }));
  const hasKey = key => options.some(option => option.key === key);
  const selected = text(body.selected, 'selected', 4);
  if (selected && !hasKey(selected)) throw new ValidationError('Lựa chọn của sinh viên không có trong danh sách.');
  const correct = text(body.correct, 'correct', 4);
  if (correct && !hasKey(correct)) throw new ValidationError('Đáp án chuẩn không có trong danh sách.');
  for (const field of ['revealed', 'answer_shown']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') throw new ValidationError(`Trường ${field} phải là boolean.`);
  }
  return {
    subjectId: text(body.subject_id, 'subject_id', LIMITS.meta),
    subjectName: text(body.subject_name, 'subject_name', LIMITS.meta),
    chapter: text(body.chapter, 'chapter', LIMITS.meta),
    questionId: text(body.question_id, 'question_id', LIMITS.meta),
    question: text(body.question, 'question', LIMITS.question, true),
    context: text(body.context, 'context', LIMITS.context),
    code: text(body.code, 'code', LIMITS.code),
    options,
    selected,
    correct,
    revealed: body.revealed === true,
    answerShown: body.answer_shown === true,
    attempts: count(body.attempts, 'attempts', 0, 1000),
    priorWrong: count(body.prior_wrong, 'prior_wrong', 0, 1000),
    hintCount: count(body.hint_count, 'hint_count', 1, 1000),
    explanation: realExplanation(text(body.explanation, 'explanation', LIMITS.explanation)),
  };
}

const BASE_RULES = [
  'Bạn là gia sư học tập của Đại học Kinh tế Quốc dân, trả lời bằng tiếng Việt, xưng "thầy/cô" hoặc trung tính và gọi người học là "em".',
  'Mục tiêu: giúp sinh viên tự suy luận, không làm bài thay.',
  'Chỉ dựa trên câu hỏi, các phương án và lời giải tham khảo được cung cấp. Không bịa thêm số liệu, công thức, định nghĩa hay dữ kiện ngoài căn cứ; nếu căn cứ không đủ, hãy nói rõ. Mọi khái niệm em nhắc tới phải nhất quán với lời giải tham khảo.',
  'Dùng thuật ngữ chuyên ngành tiếng Việt chuẩn như trong giáo trình. Trả lời ngắn gọn, tối đa 120 từ, có thể dùng Markdown nhưng không dùng LaTeX (viết mũi tên là →).',
];

const LEVEL_RULES = {
  1: 'CẤP 1 – GỢI NHỚ: chỉ gợi nhắc khái niệm, định nghĩa, quy luật hoặc công thức liên quan bằng 1–2 câu hỏi gợi mở. Không phân tích từng phương án, không đi qua các bước suy luận.',
  2: 'CẤP 2 – ĐỊNH HƯỚNG: chỉ ra dữ kiện quan trọng hoặc bước suy luận cần xem xét, đặt câu hỏi dẫn dắt. Được nói vì sao lựa chọn sai của sinh viên chưa hợp lý (nếu sinh viên đã biết là sai), nhưng không nêu phương án đúng.',
  3: 'CẤP 3 – GIẢI THÍCH: làm rõ nguyên nhân sai trong lựa chọn của sinh viên (nhầm khái niệm, đọc sai dữ kiện, áp dụng sai quy tắc/công thức hay tính toán sai) dựa trên lời giải tham khảo, rồi trình bày cách suy luận đúng từng bước.',
};

const STATE_RULES = {
  no_answer: 'Sinh viên chưa chọn đáp án.',
  answered_hidden: 'Sinh viên đã chọn một phương án nhưng kết quả chưa được công bố. Không nhắc tới lựa chọn của sinh viên; hướng dẫn cách tự kiểm tra lại lập luận.',
  wrong_first: 'Sinh viên vừa chọn sai lần đầu. Gợi ý nên xuất phát từ lựa chọn sai đó.',
  wrong_repeated: 'Sinh viên đã chọn sai câu này nhiều lần (có thể ở các lượt luyện trước).',
  correct: 'Sinh viên đã chọn ĐÚNG. Hãy củng cố ngắn gọn (tối đa 60 từ) vì sao lập luận đó đúng và nêu một điểm dễ nhầm cần lưu ý.',
};

export function buildMessages(input, decision) {
  const canRevealAnswer = decision.revealAnswer;
  const system = [
    ...BASE_RULES,
    STATE_RULES[decision.state],
    decision.level ? LEVEL_RULES[decision.level] : '',
    canRevealAnswer ? '' : 'KHÔNG được nêu chữ cái hay nội dung phương án đúng, không khẳng định phương án nào đúng, không chọn hộ sinh viên. Nếu trình bày các bước suy luận, hãy dừng trước kết luận cuối cùng và để sinh viên tự rút ra.',
  ].filter(Boolean).join('\n');
  const { question, context, code, options, selected, correct, explanation, subjectName, chapter } = input;
  const prompt = [
    subjectName ? `Học phần: ${subjectName}${chapter ? ` – ${chapter}` : ''}` : '',
    `Câu hỏi: ${question}`,
    context ? `Ngữ cảnh: ${context}` : '',
    code ? `Đoạn mã:\n${'```'}\n${code}\n${'```'}` : '',
    `Các phương án:\n${options.map(option => `${option.key}. ${option.text}`).join('\n')}`,
    // Trạng thái chưa công bố: không đưa lựa chọn vào prompt để model không thể để lộ đúng/sai.
    decision.state === 'answered_hidden' ? '' : selected ? `Sinh viên đang chọn: ${selected}. ${options.find(option => option.key === selected)?.text || ''}` : 'Sinh viên chưa chọn đáp án.',
    `Đáp án đúng (chỉ để đối chiếu${canRevealAnswer ? '' : ', KHÔNG tiết lộ'}): ${correct}`,
    explanation ? `Lời giải tham khảo đã xác minh: ${explanation}` : 'Không có lời giải tham khảo.',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: prompt }];
}
