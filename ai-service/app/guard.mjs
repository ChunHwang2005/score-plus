// Kiểm tra đầu ra của LLM trước khi trả về sinh viên (đề cương mục 6.2.4).
const MAX_WORDS = 220;

const normalize = value => String(value || '').normalize('NFC').toLowerCase().replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Câu khẳng định phương án đúng, vd. "đáp án đúng là B", "chọn B", "B là đáp án đúng", "phương án (B) đúng".
function revealsKey(text, key) {
  // \b của JS chỉ hiểu chữ ASCII ("chọn bổ sung" sẽ khớp nhầm "chọn B"), nên dùng lookaround Unicode.
  const k = `(?<![\\p{L}\\p{N}])${escape(key.toLowerCase())}(?![\\p{L}\\p{N}])`;
  return [
    new RegExp(`(đáp án|phương án|lựa chọn)\\s*(đúng|chính xác)?\\s*(là|:)?\\s*\\(?${k}\\)?\\s*(\\.|,|$|đúng|chính xác)`, 'u'),
    new RegExp(`(đáp án|phương án|lựa chọn)\\s*(đúng|chính xác)\\s*(là|:)?\\s*\\(?${k}`, 'u'),
    new RegExp(`(?<!\\p{L})chọn\\s*(đáp án|phương án)?\\s*\\(?${k}`, 'u'),
    new RegExp(`${k}\\)?\\s*(là|mới là)\\s*(đáp án|phương án)?\\s*(đúng|chính xác)`, 'u'),
  ].some(pattern => pattern.test(text));
}

// Số có từ 2 chữ số hoặc số thập phân trong gợi ý phải xuất hiện trong câu hỏi/phương án/lời giải.
const NUMBER = /\d+(?:[.,]\d+)*/g;
const canonical = value => value.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
function foreignNumbers(text, sources) {
  const known = new Set((sources.match(NUMBER) || []).map(canonical));
  return [...new Set((text.match(NUMBER) || []).map(canonical))]
    .filter(n => (n.replace('.', '').length >= 2 || n.includes('.')) && !known.has(n));
}

/** @returns {{ ok: boolean, reasons: string[] }} */
export function checkHint(content, input, decision) {
  const reasons = [];
  const text = normalize(content);
  if (!text) return { ok: false, reasons: ['nội dung rỗng'] };
  if (text.split(' ').length > MAX_WORDS) reasons.push(`quá dài (trên ${MAX_WORDS} từ)`);
  if (!decision.revealAnswer && input.correct) {
    if (revealsKey(text, input.correct)) reasons.push('tiết lộ chữ cái đáp án đúng');
    const answerText = normalize(input.options.find(option => option.key === input.correct)?.text);
    // Bỏ qua phương án quá ngắn hoặc đã có sẵn trong đề để tránh báo nhầm với khái niệm được nhắc khi gợi nhớ.
    if (answerText.length >= 8 && !normalize(input.question).includes(answerText) && text.includes(answerText)) reasons.push('nêu nguyên văn phương án đúng');
  }
  const sources = [input.question, input.context, input.code, input.explanation, ...input.options.map(option => option.text)].join(' ');
  const numbers = foreignNumbers(content, sources);
  if (numbers.length) reasons.push(`có số liệu ngoài căn cứ (${numbers.slice(0, 3).join(', ')})`);
  return { ok: !reasons.length, reasons };
}
