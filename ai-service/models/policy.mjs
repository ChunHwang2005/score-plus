// Chính sách chọn cấp gợi ý (giai đoạn 1: rule-based, đề cương mục 5).
export const LEVEL_LABELS = { 1: 'Gợi nhớ', 2: 'Định hướng', 3: 'Giải thích' };

export const DEFAULT_POLICY = {
  level2Attempts: 2, // sai từ lần thử thứ 2 → cấp 2
  level3Attempts: 3, // sai từ lần thử thứ 3 → cấp 3
  requireSolution: true, // thiếu lời giải đã xác minh → báo chưa đủ căn cứ
  allowAnswerAtLevel3: false, // cấp 3 có được nêu đáp án hay không
};

const clampLevel = level => Math.max(1, Math.min(3, level));

/**
 * @param {{ selected: string, correct: string, revealed: boolean, answerShown: boolean, attempts: number, priorWrong: number, hintCount: number, hasSolution: boolean }} input
 *   revealed: sinh viên đã được biết đúng/sai của lựa chọn hiện tại chưa.
 *   answerShown: đáp án đúng đã hiện trên giao diện (vd. hết số lần thử).
 *   priorWrong: số lần đã sai câu này ở các lượt trước (lịch sử trả lời, vd. khi ôn lại câu sai).
 *   hintCount: lần xin gợi ý thứ mấy kể từ lần chọn đáp án gần nhất (≥ 1); chọn lại thì đếm lại từ 1
 *   để không cộng hai lần (số lần sai đã nâng cấp gợi ý).
 * @returns {{ state: string, level: number, label: string, revealAnswer: boolean }}
 *   revealAnswer: gợi ý có được nêu đáp án đúng hay không.
 */
export function decideHint(input, policy = DEFAULT_POLICY) {
  const decision = chooseLevel(input, policy);
  const revealAnswer = decision.state === 'correct' || (decision.level === 3 && (policy.allowAnswerAtLevel3 || !!input.answerShown));
  return { ...decision, revealAnswer };
}

function chooseLevel({ selected, correct, revealed, attempts, priorWrong = 0, hintCount, hasSolution }, policy) {
  if (!correct || (policy.requireSolution && !hasSolution)) return { state: 'missing_data', level: 0, label: 'Chưa đủ căn cứ' };
  const extra = Math.max(0, hintCount - 1); // mỗi lần xin thêm khi chưa chọn lại tăng một cấp
  const levelForWrong = wrong => wrong >= policy.level3Attempts ? 3 : wrong >= policy.level2Attempts ? 2 : 1;
  if (!selected) {
    const level = clampLevel(levelForWrong(priorWrong) + extra);
    return { state: 'no_answer', level, label: LEVEL_LABELS[level] };
  }
  if (!revealed) {
    // Kết quả chưa công bố (chưa nộp): không giải thích lỗi vì sẽ lộ đúng/sai, tối đa cấp 2.
    const level = Math.min(2, levelForWrong(priorWrong) + extra);
    return { state: 'answered_hidden', level, label: LEVEL_LABELS[level] };
  }
  if (selected === correct) return { state: 'correct', level: 0, label: 'Củng cố' };
  // Số lần sai tính cả các lượt trước: sai ở lượt ôn lại sau khi đã sai một lần là "tiếp tục sai".
  const wrong = priorWrong + attempts;
  const level = clampLevel(levelForWrong(wrong) + extra);
  return { state: wrong <= 1 ? 'wrong_first' : 'wrong_repeated', level, label: LEVEL_LABELS[level] };
}
