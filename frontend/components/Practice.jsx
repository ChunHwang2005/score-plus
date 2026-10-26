'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, GraduationCap, ListChecks, LogOut, Save, Send, Sparkles, Trash2, X } from 'lucide-react';
import { mediaUrl, request } from '../lib/api.mjs';
import { MAX_TRIES, answerStatus, attemptSummary, certificateIdOf, chapterName, formatDateTime, optionTag, optionWrong, parseQuestion, questionDone, resultPayload, reviewItems, sectionOf, statusLabel, unwrap } from '../lib/practice.mjs';
import { createDraftStore, newAttemptId } from '../lib/drafts.mjs';
import { loadPortalUser, loadScoreupSessionFromPortal, portalApiPath, subscribePortalUser } from '../lib/portal-auth.mjs';
import { STAGE_LABELS, openStudyStage, saveStudyDraft, submitStudyStage, activeStudy, completeExperiment, createEventQueue, instantFor, loadExperiment, lockStudy, pendingPractice, practiceAttemptId, saveConsent, sendEvents } from '../lib/experiment.mjs';
import Button from './Button';
import Dropdown from './Dropdown';
import Markdown from './Markdown';
import Modal from './Modal';
import { HistoryList, ResultReview, ScoreRing } from './History';
import { clearStandaloneSession, isStandalone, loadStandaloneSession, microsoftLoginUrl } from '../lib/microsoft-auth.mjs';

// Endpoint SSO của AI-Portal (backend routes/scoreplus.ts); env chỉ dùng khi Portal đặt endpoint ở path khác.
const SESSION_PATH = process.env.NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH || '/api/scoreplus/session';
// ScorePlus AI service (ai-service/, gọi Ollama ở server). Để trống = dùng Central LLM của AI-Portal.
const AI_URL = (process.env.NEXT_PUBLIC_SCOREPLUS_AI_URL || '').replace(/\/+$/, '');
const AI_HINTS_KEY = 'scoreplus:ai-hints';
const STUDY_LABEL = 'Bài luyện tập nghiên cứu';
// Thang Likert đánh giá gợi ý: [trường, nhãn, nghĩa của 1, nghĩa của 5].
const RATING_FIELDS = [['helpful', 'Hữu ích', 'Không hữu ích', 'Rất hữu ích'], ['clear', 'Dễ hiểu', 'Khó hiểu', 'Rất dễ hiểu']];

const HINT_SYSTEM = 'Bạn là gia sư học tập bằng tiếng Việt. Hãy giúp sinh viên tự suy luận: nêu một gợi ý cụ thể và giải thích ngắn gọn vì sao hướng suy nghĩ đó hữu ích. Không tiết lộ chữ cái hoặc nội dung đáp án đúng, không chọn đáp án hộ sinh viên. Chỉ dựa trên nội dung được cung cấp; nếu thiếu dữ kiện, hãy nói rõ điều đó. Trả lời ngắn, dễ hiểu, tối đa 120 từ.';
function hintPrompt(question, selected) {
  return [
    `Câu hỏi: ${question.question}`,
    question.context ? `Ngữ cảnh: ${question.context}` : '',
    `Các lựa chọn: ${question.options.map(option => `${option.key}. ${option.text}`).join(' | ')}`,
    selected ? `Sinh viên đã chọn: ${selected}. ${question.options.find(option => option.key === selected)?.text || ''}` : 'Sinh viên chưa chọn đáp án.',
    question.explanation ? `Giải thích/đáp án tham khảo từ ngân hàng câu hỏi: ${question.explanation}` : '',
  ].filter(Boolean).join('\n');
}

export default function Practice() {
  // 'home' (thiết lập + lịch sử) | 'exam' (trang làm bài) | 'review' — giữ trong state, không đổi URL vì app chạy trong iframe của Portal.
  const [view, setView] = useState('home');
  const [reviewId, setReviewId] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // Bài chưa nộp đang chờ xác nhận xoá (popup), null = không mở.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [successOpen, setSuccessOpen] = useState(false);
  const [draftSave, setDraftSave] = useState('idle');
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [chapter, setChapter] = useState('');
  const [count, setCount] = useState(10);
  // Chế độ học có hỗ trợ: phản hồi ngay sau mỗi câu (thử lại) + gợi ý gia sư AI. Tắt = làm như thi.
  // Chốt vào batch.instant khi bắt đầu lượt; nhớ trên trình duyệt.
  const [aiHints, setAiHints] = useState(true);
  const [session, setSession] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [batch, setBatch] = useState(null);
  const [saved, setSaved] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [hints, setHints] = useState({});
  const [hintBusy, setHintBusy] = useState({});
  // Các phương án đã chọn theo thứ tự ở từng câu: độ dài là "số lần thử" của chính sách gợi ý, phần tử đầu dùng để chấm điểm.
  const [tries, setTries] = useState({});
  // Số lần đã sai từng câu ở các lượt trước (lịch sử ScoreUp) — gia sư cộng vào số lần sai khi chọn cấp gợi ý.
  const [priorWrong, setPriorWrong] = useState({});
  // Thực nghiệm gia sư AI (ScoreUp /tutor-experiments): { experiment, group, consent } hoặc null nếu không tham gia.
  const [study, setStudy] = useState(null);
  const [consentOpen, setConsentOpen] = useState(false);
  // Đánh giá Likert theo `${câu}:${gợi ý}`; giữ trong ref để hai lần bấm liên tiếp không đọc state cũ.
  const ratings = useRef({});
  const [portalUser, setPortalUser] = useState(null);
  const [authState, setAuthState] = useState('waiting');
  const [authError, setAuthError] = useState('');
  const [authReload, setAuthReload] = useState(0);
  // Chạy riêng (không nằm dưới /embed/scoreplus của Portal) → đăng nhập Microsoft như ScoreUp.
  const [standalone, setStandalone] = useState(false);
  const portalIdentity = useRef(null);
  const authGeneration = useRef(0);
  const actionLock = useRef(false);
  const toastTimer = useRef(null);
  const subject = subjects.find(s => s._id === subjectId);
  const answered = questions.filter(q => answers[q.id]).length;
  // Chấm theo lựa chọn cuối: phản hồi ngay thì đúng trong tối đa MAX_TRIES lần thử là đúng.
  const correct = questions.filter(q => answers[q.id] && answers[q.id] === q.correct).length;
  // Chế độ có gia sư (phản hồi ngay): "nộp bài" là kết thúc lượt và xem tổng kết.
  const summaryMode = !!batch?.instant;
  const done = q => !!batch?.instant && questionDone(q, answers[q.id], tries[q.id]);
  // Điều kiện thực nghiệm đã chốt khi bắt đầu lượt (lockStudy); null = lượt ngoài thực nghiệm.
  const batchStudy = batch?.study || null;
  const canLeaveAfterSubmit = !batchStudy?.stage || batchStudy.stage === 'posttest';
  // Trong thực nghiệm nhóm quyết định: có gia sư (phản hồi ngay) hoặc làm như bài thi; ngoài thực nghiệm theo chế độ của lượt.
  const tutorEnabled = batchStudy ? batchStudy.tutorEnabled : !!batch?.instant;
  const studyForSubject = activeStudy(study, subjectId);
  // Bài luyện tập admin cấu hình cho đợt: mô tả trong hộp thoại; studyPractice chỉ có khi đã đồng ý mà chưa làm xong.
  const studyPractice = pendingPractice(study);
  const studyFlowPending = !!studyPractice?.stage;
  const practiceConfig = study?.experiment?.flow ? pendingPractice({ ...study, consent: true }) : study?.experiment?.practice;
  const practiceSubject = practiceConfig && subjects.find(s => s._id === practiceConfig.subject_id);
  const practiceInfo = study?.experiment?.flow ? `Đầu vào → Luyện tập → Đầu ra${study.stage ? ` · Tiếp theo: ${STAGE_LABELS[study.stage]}` : ''}` : practiceConfig ? `${practiceSubject?.subject_name || 'Môn của đợt'}${practiceConfig.chapter ? ` · ${chapterName(practiceConfig.chapter)}` : ''} · ${practiceConfig.question_count} câu` : '';
  const userId = session ? String(session.user._id || session.user.id) : '';

  useEffect(() => {
    try { if (localStorage.getItem(AI_HINTS_KEY) === 'off') setAiHints(false); } catch { /* mặc định bật */ }
  }, []);
  function changeAiHints(next) {
    setAiHints(next);
    try { localStorage.setItem(AI_HINTS_KEY, next ? 'on' : 'off'); } catch { /* chỉ là tuỳ chọn hiển thị */ }
  }

  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get('theme');
    if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
    if (isStandalone(window)) {
      setStandalone(true);
      const controller = new AbortController();
      setAuthState('connecting');
      loadStandaloneSession({ signal: controller.signal }).then(value => {
        if (controller.signal.aborted) return;
        if (!value) { setSession(null); setPortalUser(null); setAuthState('signed-out'); return; }
        authGeneration.current += 1;
        setSession(value);
        setPortalUser({ id: String(value.user._id || value.user.id), email: value.user.email || '', name: value.user.fullName || value.user.name || '' });
        setAuthState('ready');
      }).catch(e => {
        if (controller.signal.aborted) return;
        setAuthState('signed-out');
        setAuthError(e.message);
      });
      return () => controller.abort();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), 15000);
    let revision = 0;
    const receiveUser = user => {
      revision += 1;
      if (!user || user.id !== portalIdentity.current) {
        authGeneration.current += 1;
        setSession(null);
        setQuestions([]); setAnswers({}); setBatch(null); setSaved(null); setSubmitted(false);
        setHints({}); setHintBusy({}); setTries({}); setPriorWrong({}); setSubmitConfirmOpen(false);
        setToast(null); setError(''); setView('home'); setReviewId(''); setLeaveOpen(false); setSuccessOpen(false);
      }
      portalIdentity.current = user?.id || null;
      setPortalUser(user);
      if (!user) {
        setAuthState('error');
        setAuthError('AI-Portal chưa có phiên người dùng. Hãy mở lại công cụ từ Portal.');
      }
    };
    const unsubscribe = subscribePortalUser(window, receiveUser, value => { document.documentElement.dataset.theme = value; });
    const requestedRevision = revision;
    loadPortalUser({ signal: controller.signal }).then(user => {
      if (!controller.signal.aborted && revision === requestedRevision) receiveUser(user);
    }).catch(e => {
      // A valid context delivered by Portal can still be used if the session
      // API is unavailable. Never let a stale request override a newer message.
      if (revision !== requestedRevision || portalIdentity.current || (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError')) return;
      setAuthState('error');
      setAuthError(controller.signal.aborted ? 'Nhận phiên AI-Portal quá lâu. Hãy thử kết nối lại.' : 'Không tải được phiên AI-Portal. Hãy mở công cụ từ Portal hoặc thử kết nối lại.');
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); unsubscribe(); };
  }, [authReload]);

  useEffect(() => {
    if (!portalUser || standalone) return;
    const controller = new AbortController();
    const generation = ++authGeneration.current;
    const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), 30000);
    setSession(null);
    setAuthError('');
    setAuthState('connecting');
    loadScoreupSessionFromPortal({ path: SESSION_PATH, signal: controller.signal }).then(value => {
      if (controller.signal.aborted || generation !== authGeneration.current) return;
      setSession(value);
      setAuthState('ready');
    }).catch(e => {
      if (generation !== authGeneration.current || (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError')) return;
      setAuthState('error');
      setAuthError(controller.signal.aborted ? 'Kết nối phiên quá lâu. Hãy thử kết nối lại.' : e.message);
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [portalUser?.id, authReload, standalone]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Liquid glass: ánh sáng trên bề mặt kính đi theo con trỏ (CSS đọc --mx/--my).
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const onMove = event => {
      // Nút và dropdown tự xử lý trong components/Button.jsx, Dropdown.jsx.
      const el = event.target.closest?.('.panel,.account,.option,.palette a');
      if (!el || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
        el.style.setProperty('--my', `${event.clientY - rect.top}px`);
      });
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => { document.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame); };
  }, []);

  function notify(kind, title, message) {
    clearTimeout(toastTimer.current);
    setToast({ kind, title, message, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 4800);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoadingSubjects(true);
    request('/subjects/?visible_for_practice_only=1', { signal: controller.signal }).then(data => {
      const list = unwrap(data);
      if (!Array.isArray(list)) throw new Error('Không đọc được danh sách môn học.');
      setSubjects(list);
      const code = new URLSearchParams(window.location.search).get('subject');
      const selected = list.find(s => s.subject_code?.toLowerCase() === code?.toLowerCase());
      setSubjectId(current => current || selected?._id || list[0]?._id || '');
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoadingSubjects(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setStudy(null); setConsentOpen(false);
    if (!session) return;
    const controller = new AbortController();
    loadExperiment(session.token, { signal: controller.signal }).then(info => {
      if (controller.signal.aborted) return;
      setStudy(info);
      // Chưa trả lời → hỏi đồng ý; đã đồng ý nhưng chưa làm bài của đợt → nhắc vào làm. Làm xong thì không hiện nữa.
      if (info && !info.completed && (info.consent === null || pendingPractice(info))) setConsentOpen(true);
    }).catch(() => {});
    return () => controller.abort();
  }, [session?.token]);

  // Chỉ ghi sự kiện khi sinh viên đã đồng ý tham gia.
  const eventQueue = useMemo(() => session && study?.consent
    ? createEventQueue({ send: (events, options) => sendEvents(session.token, study.experiment.id, events, options) })
    : null, [session?.token, study?.experiment?.id, study?.consent]);
  useEffect(() => {
    if (!eventQueue) return;
    const onHide = () => { eventQueue.flush({ keepalive: true }); };
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('pagehide', onHide); eventQueue.flush({ keepalive: true }); };
  }, [eventQueue]);

  function track(type, question, data = {}, target = batch) {
    if (!eventQueue || !target?.study || target.study.experimentId !== study?.experiment?.id) return;
    eventQueue.push({
      type, attempt_id: target.id, subject_id: String(target.subject?._id || ''),
      ...(question ? { question_id: String(question.id) } : {}), client_ts: new Date().toISOString(), data,
    });
  }

  async function answerConsent(agree) {
    if (!study || !session) return;
    try {
      const result = await saveConsent(session.token, study.experiment.id, agree);
      const next = study.experiment.flow ? await loadExperiment(session.token) : { ...study, consent: result?.consent ?? agree };
      setStudy(next);
      setConsentOpen(false);
      // Đợt có bài luyện tập: đồng ý là vào làm luôn.
      if (pendingPractice(next)) { startStudyPractice(next); return; }
      notify('success', agree ? 'Cảm ơn bạn đã tham gia' : 'Đã ghi nhận lựa chọn', agree ? 'Dữ liệu luyện tập được ghi ẩn danh cho nghiên cứu.' : 'Dữ liệu luyện tập của bạn sẽ không được thu thập.');
    } catch (e) {
      notify('error', 'Chưa lưu được lựa chọn', e.message);
    }
  }

  // Bài luyện tập admin cấu hình cho đợt. Id lượt cố định theo đợt: mở lại thì làm tiếp bản nháp đã tự lưu.
  function startStudyPractice(current = study) {
    const practice = pendingPractice(current);
    if (!session || !draftStore || !practice) return;
    setConsentOpen(false);
    const selected = subjects.find(s => s._id === practice.subject_id);
    if (!selected) { notify('error', 'Chưa mở được bài nghiên cứu', loadingSubjects ? 'Đang tải danh sách môn học, hãy thử lại sau giây lát.' : 'Môn của đợt nghiên cứu không có trong danh sách luyện tập.'); return; }
    if (current.experiment.flow) {
      run('questions', async () => {
        await settleSaves();
        const data = await openStudyStage(session.token, current.experiment.id, current.stage);
        setSubjectId(selected._id); setChapter('');
        enterExam({ id: data.attempt_id, subject: selected, chapter: '', label: STAGE_LABELS[data.stage], instant: data.instant, start: data.start, hintsUsed: data.hints_used || 0, restoredTries: data.tries, userId }, data.questions, data.answers, current);
        notify('success', STAGE_LABELS[data.stage], data.instant ? 'Có gia sư AI và phản hồi ngay.' : 'Không có gia sư AI; nộp bài để xem kết quả.');
      });
      return;
    }
    const id = practiceAttemptId(current.experiment.id);
    const generation = authGeneration.current;
    run('questions', async () => {
      const draft = await draftStore.get(id).catch(() => null);
      if (generation !== authGeneration.current) return;
      setSubjectId(selected._id); setChapter(practice.chapter || '');
      if (draft?.questions?.length) {
        enterExam({ id, subject: selected, chapter: draft.chapter || '', label: STUDY_LABEL, instant: !!draft.instant, start: draft.start, hintsUsed: draft.hints_used || 0, userId }, draft.questions, draft.answers || {}, current);
        notify('success', 'Tiếp tục bài nghiên cứu', `${selected.subject_name} · ${draft.questions.length} câu hỏi`);
        return;
      }
      const parsed = await fetchQuestions(selected, practice.chapter || '', practice.question_count);
      if (generation !== authGeneration.current) return;
      enterExam({ id, subject: selected, chapter: practice.chapter || '', label: STUDY_LABEL, instant: instantFor(current, selected._id, aiHints, id), start: new Date().toISOString(), userId }, parsed, {}, current);
      notify('success', 'Đã bắt đầu bài nghiên cứu', `${selected.subject_name} · ${parsed.length} câu hỏi`);
    });
  }

  const draftStore = useMemo(() => session ? createDraftStore({ token: session.token, userId, request }) : null, [session?.token, userId]);
  const pendingSave = useRef(null);
  const activeAttempt = useRef('');

  useEffect(() => {
    setDrafts([]);
    if (!draftStore) return;
    let cancelled = false;
    draftStore.list().then(list => { if (!cancelled) setDrafts(list); }).catch(e => {
      if (cancelled) return;
      if (e.status === 401) expireSession();
      else notify('error', 'Chưa tải được bài chưa nộp', e.message);
    });
    return () => { cancelled = true; };
  }, [draftStore]);

  function upsertDraft(summary) { setDrafts(list => [summary, ...list.filter(d => d.id !== summary.id)]); }

  // Ghi nháp tuần tự: mỗi lần lưu chờ lần trước xong, để PUT cũ không tới server sau khi đã nộp/xoá.
  function persistDraft(draft) {
    const run = (pendingSave.current || Promise.resolve()).catch(() => {}).then(async () => {
      if (draft.study?.stage) {
        await saveStudyDraft(session.token, draft.study.experimentId, draft.study.stage, { answers: draft.answers, tries: draft.tries, hints_used: draft.hints_used });
        return { id: draft.id, studyDraft: true };
      }
      return draftStore.save(draft);
    });
    pendingSave.current = run;
    return run;
  }
  async function settleSaves() { await pendingSave.current?.catch(() => {}); }

  // Tự lưu nháp khi đang làm bài (chỉ khi đã trả lời ít nhất 1 câu) để rời trang / đổi thiết bị vẫn làm tiếp được.
  useEffect(() => {
    if (view !== 'exam' || submitted || !batch?.id || batch.userId !== userId || !answered || !draftStore) return;
    const timer = setTimeout(() => {
      setDraftSave('saving');
      persistDraft(draftOf()).then(summary => {
        if (activeAttempt.current !== summary.id) return;
        if (!summary.studyDraft) upsertDraft(summary); setDraftSave('saved');
      }).catch(() => { if (activeAttempt.current === batch.id) setDraftSave('error'); });
    }, 1200);
    return () => clearTimeout(timer);
  }, [view, submitted, batch, answers, questions, userId, draftStore]);

  function draftOf() {
    return { id: batch.id, subject: batch.subject, chapter: batch.chapter, label: batch.label || '', instant: batch.instant, start: batch.start, hints_enabled: tutorEnabled, hints_used: batch.hintsUsed || 0, questions, answers, tries, study: batch.study };
  }

  function clearAttempt() {
    activeAttempt.current = '';
    setQuestions([]); setAnswers({}); setBatch(null); setSaved(null); setSubmitted(false); setDraftSave('idle');
    setHints({}); setHintBusy({}); setTries({}); setPriorWrong({}); setSubmitConfirmOpen(false); setLeaveOpen(false); setSuccessOpen(false);
  }

  function goHome() { clearAttempt(); setView('home'); window.scrollTo?.({ top: 0 }); }

  // currentStudy: truyền khi vừa đổi study (vd. vừa đồng ý) mà state chưa kịp cập nhật.
  function enterExam(attempt, nextQuestions, nextAnswers = {}, currentStudy = study) {
    const nextBatch = { ...attempt, study: lockStudy(currentStudy, attempt.subject?._id, attempt.instant, attempt.id) };
    activeAttempt.current = nextBatch.id;
    setQuestions(nextQuestions); setAnswers(nextAnswers); setBatch(nextBatch); setDraftSave('idle');
    setSaved(null); setSubmitted(false); setSuccessOpen(false); setHints({}); setHintBusy({});
    // Bài nháp khôi phục: coi lựa chọn đã lưu là lần thử đầu.
    setTries(nextBatch.restoredTries || Object.fromEntries(Object.entries(nextAnswers).filter(([, key]) => key).map(([id, key]) => [id, [key]])));
    setPriorWrong(nextBatch.priorWrong || {});
    loadPriorWrong(nextBatch.id, nextQuestions);
    setView('exam'); window.scrollTo?.({ top: 0 });
    track('attempt_start', null, { question_count: nextQuestions.length, instant: !!nextBatch.instant }, nextBatch);
  }

  function leave() {
    if (submitted || !answered) {
      // Chưa làm câu nào: không giữ nháp (kể cả bản cũ khi mở lại rồi bỏ hết đáp án).
      const id = batch?.id;
      if (id && !submitted && draftStore && drafts.some(d => d.id === id)) {
        settleSaves().then(() => draftStore.remove(id)).catch(() => {});
        setDrafts(list => list.filter(d => d.id !== id));
      }
      goHome(); return;
    }
    setLeaveOpen(true);
  }

  function confirmLeave() {
    if (batch?.userId !== userId) { goHome(); return; }
    const draft = draftOf();
    run('leave', async () => {
      const summary = await persistDraft(draft);
      if (!summary.studyDraft) upsertDraft(summary);
      goHome();
      notify('success', 'Đã lưu bài chưa nộp', draft.study?.stage ? 'Vào lại đợt thực nghiệm để tiếp tục đúng giai đoạn, kể cả trên thiết bị khác.' : draftStore.mode === 'server' ? 'Bạn có thể làm tiếp trong Lịch sử làm bài, kể cả trên thiết bị khác.' : 'Bạn có thể làm tiếp trong Lịch sử làm bài trên trình duyệt này.');
    });
  }

  function resume(summary) {
    if (!session || !draftStore) return;
    if (studyFlowPending || (study?.experiment?.flow && summary.id.startsWith(`exp-${study.experiment.id}-`))) { startStudyPractice(); return; }
    run(`resume:${summary.id}`, async () => {
      const draft = await draftStore.get(summary.id);
      if (!draft.questions.length) throw new Error('Các câu hỏi của bài này không còn trong ngân hàng câu hỏi.');
      const selected = subjects.find(s => s._id === draft.subject?._id) || draft.subject;
      enterExam({ id: draft.id, subject: selected, chapter: draft.chapter || '', label: draft.label || '', instant: !!draft.instant, start: draft.start, hintsUsed: draft.hints_used || 0, userId }, draft.questions, draft.answers || {});
    });
  }

  function deleteDraft(summary) {
    if (draftStore) setDeleteTarget(summary);
  }

  function confirmDeleteDraft() {
    const summary = deleteTarget;
    if (!summary || !draftStore) return;
    run(`delete:${summary.id}`, async () => {
      await draftStore.remove(summary.id);
      setDrafts(list => list.filter(d => d.id !== summary.id));
      setDeleteTarget(null);
      notify('success', 'Đã xoá bài chưa nộp', `${summary.subjectName} · ${sectionOf(summary)}`);
    });
  }

  function signIn() {
    try { window.location.assign(microsoftLoginUrl()); }
    catch (e) { setAuthError(e.message); }
  }

  function signOut() {
    clearStandaloneSession();
    authGeneration.current += 1;
    setSession(null); setPortalUser(null);
    setQuestions([]); setAnswers({}); setBatch(null); setSaved(null); setSubmitted(false);
    setHints({}); setHintBusy({}); setTries({}); setPriorWrong({}); setSubmitConfirmOpen(false); setLeaveOpen(false); setSuccessOpen(false);
    setView('home'); setReviewId(''); setDrafts([]);
    setAuthError(''); setAuthState('signed-out');
  }

  async function run(name, action) {
    if (actionLock.current) return;
    const generation = authGeneration.current;
    actionLock.current = true;
    setBusy(name); setError('');
    try { await action(); }
    catch (e) {
      if (generation !== authGeneration.current) return;
      setError(e.message);
      notify('error', 'Có lỗi xảy ra', e.message);
      if (e.status === 401) expireSession();
    } finally { actionLock.current = false; setBusy(''); }
  }

  function expireSession() {
    setSession(null);
    authGeneration.current += 1;
    if (standalone) {
      clearStandaloneSession();
      setAuthState('signed-out');
      setAuthError('Phiên ScoreUp đã hết hạn. Hãy đăng nhập lại.');
    } else {
      setAuthState('error');
      setAuthError('Phiên kết nối đã hết hạn. Hãy thử kết nối lại hoặc mở lại công cụ từ AI-Portal.');
    }
  }

  function openReview(id) { setReviewId(id); setView('review'); }

  // Từ màn xem lại: tạo lượt mới chỉ gồm các câu sai/bỏ trống (đã có sẵn nội dung, không cần gọi API).
  function retryQuestions(result, retry) {
    if (!session) return;
    if (studyFlowPending) { startStudyPractice(); return; }
    const selected = subjects.find(s => certificateIdOf(s) === result.certificateId);
    if (!selected) { notify('error', 'Không tìm thấy môn học', 'Môn của lượt này không còn trong danh sách luyện tập.'); return; }
    setSubjectId(selected._id); setChapter('');
    // Câu đã chọn sai ở lượt đang xem tính ít nhất 1 lần sai (bỏ trống không tính); ScoreUp bổ sung đủ lịch sử sau.
    const priorWrong = Object.fromEntries(reviewItems(result).filter(item => item.status === 'wrong').map(item => [item.id, 1]));
    enterExam({ id: newAttemptId(), subject: selected, chapter: '', label: 'Ôn lại câu chưa đúng', instant: instantFor(study, selected._id, aiHints), start: new Date().toISOString(), userId, priorWrong }, retry);
    notify('success', 'Đã tạo lượt ôn lại', `${retry.length} câu chưa đúng từ lượt trước.`);
  }

  function loadPriorWrong(attemptId, list) {
    if (!session || !list.length) return;
    request('/questions/result/mine/wrong-counts', { token: session.token, body: { question_ids: list.map(q => String(q.id)) } }).then(data => {
      const counts = unwrap(data) || {};
      if (activeAttempt.current !== attemptId) return;
      setPriorWrong(current => {
        const next = { ...current };
        for (const [id, n] of Object.entries(counts)) next[id] = Math.max(next[id] || 0, Number(n) || 0);
        return next;
      });
    }).catch(() => {}); // ScoreUp chưa có API này: giữ số liệu sẵn có (vd. từ màn ôn lại)
  }

  function chooseAnswer(question, key) {
    const nextTries = [...(tries[question.id] || []), key];
    setAnswers(current => ({ ...current, [question.id]: key }));
    setTries(current => ({ ...current, [question.id]: nextTries }));
    const correct = key === question.correct;
    track('answer', question, { selected: key, correct, try_index: nextTries.length });
    if (batch?.instant && questionDone(question, key, nextTries)) track('reveal', question, { try_count: nextTries.length, correct });
  }

  function rateHint(question, field, value) {
    const hint = hints[question.id];
    if (!hint) return;
    const key = `${question.id}:${hint.index}`;
    const rating = { ...ratings.current[key], [field]: value };
    ratings.current[key] = rating;
    setHints(current => ({ ...current, [question.id]: { ...current[question.id], rating } }));
    track('hint_rating', question, { hint_index: hint.index, ...rating });
  }

  async function requestHint(question) {
    if (!tutorEnabled || hintBusy[question.id]) return;
    const generation = authGeneration.current;
    const attemptId = batch?.id;
    setHintBusy(current => ({ ...current, [question.id]: true }));
    try {
      const selected = answers[question.id];
      const attemptCount = tries[question.id]?.length || 0;
      // "Xin thêm gợi ý" chỉ tăng cấp khi xin tiếp ở cùng lần thử; chọn lại đáp án thì đếm lại từ 1 (cấp đã tăng theo số lần sai).
      const previous = hints[question.id];
      const hintCount = previous && previous.attempt === attemptCount ? previous.count + 1 : 1;
      const started = performance.now();
      const response = AI_URL
        ? await fetch(`${AI_URL}/v1/hint`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Chỉ gửi dữ liệu câu hỏi; ai-service tự dựng prompt và giữ khóa Ollama.
          body: JSON.stringify({
            subject_id: String(batch?.subject?._id || ''), subject_name: String(batch?.subject?.name || ''), chapter: batch?.chapter ? chapterName(batch.chapter) : '', question_id: String(question.id || ''),
            question: String(question.question || ''), context: String(question.context || ''), code: String(question.code || ''), options: question.options,
            selected: selected || '', correct: question.correct || '', explanation: String(question.explanation || ''),
            // revealed: sinh viên đã thấy đúng/sai chưa (chế độ hiện đáp án sau mỗi câu); nếu chưa, gia sư không được để lộ.
            revealed: !!(batch?.instant && selected), answer_shown: done(question), attempts: attemptCount, prior_wrong: priorWrong[question.id] || 0, hint_count: hintCount,
          }),
          signal: AbortSignal.timeout(75000),
          credentials: 'omit',
        })
        : await fetch(portalApiPath('/api/ai/complete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: hintPrompt(question, selected), system: HINT_SYSTEM }),
          signal: AbortSignal.timeout(45000),
          credentials: 'same-origin',
        });
      const data = await response.json().catch(() => null);
      if (generation !== authGeneration.current) return;
      if (!response.ok) {
        if (response.status === 503 && !AI_URL) throw new Error(data?.message || 'AI-Portal chưa cấu hình Central LLM.');
        throw new Error(data?.message || `${AI_URL ? 'AI service' : 'AI-Portal'} trả về lỗi (${response.status}).`);
      }
      if (!data?.content) throw new Error('AI chưa tạo được gợi ý. Hãy thử lại.');
      const label = data.status === 'insufficient' ? 'Chưa đủ căn cứ' : data.level ? `Gợi ý cấp ${data.level} · ${data.label}` : data.label || 'Gợi ý học tập';
      const hintIndex = (previous?.index || 0) + 1;
      setHints(current => ({ ...current, [question.id]: { content: data.content, label, status: data.status || 'ok', count: hintCount, attempt: attemptCount, index: hintIndex, rating: {} } }));
      // Đếm theo lượt (lưu cùng nháp và kết quả) để lịch sử biết lượt nào có dùng gợi ý.
      setBatch(current => current && current.id === attemptId ? { ...current, hintsUsed: (current.hintsUsed || 0) + 1 } : current);
      track('hint_shown', question, { level: data.level || 0, state: data.state || '', status: data.status || 'ok', hint_index: hintIndex, latency_ms: Math.round(performance.now() - started) });
      if (!data.status || data.status === 'ok') notify('success', 'Gia sư AI đã trả lời', 'Hãy dùng gợi ý để tự suy luận trước khi chọn đáp án.');
    } catch (e) {
      if (generation !== authGeneration.current) return;
      const message = e.name === 'TimeoutError'
        ? 'Yêu cầu AI quá lâu. Hãy thử lại sau.'
        : e instanceof TypeError
          ? (AI_URL ? 'Không kết nối được ScorePlus AI service. Hãy kiểm tra service đang chạy và CORS.' : 'Không kết nối được endpoint AI của AI-Portal. Hãy kiểm tra Portal/backend đang chạy và base path.')
          : e.message;
      notify('error', 'Chưa lấy được gợi ý AI', message);
    } finally {
      if (generation === authGeneration.current) setHintBusy(current => ({ ...current, [question.id]: false }));
    }
  }

  /** Lấy câu hỏi từ ScoreUp, bỏ câu lỗi và câu trùng (kể cả với `existingIds` đang có trong lượt). */
  async function fetchQuestions(selected, chapterId, limit, existingIds = []) {
    const data = unwrap(await request('/questions', { token: session.token, body: { subject_id: selected._id, chapter_id: chapterId, limit: Number(limit) } }));
    if (!Array.isArray(data)) throw new Error('Dữ liệu câu hỏi không hợp lệ.');
    const existing = new Set(existingIds);
    const parsed = data.flat().map(parseQuestion).filter(q => {
      if (!q.id || !q.question || !q.options.length || existing.has(q.id)) return false;
      existing.add(q.id); return true;
    });
    if (!parsed.length && !existingIds.length) throw new Error('Chưa có câu hỏi cho lựa chọn này. Hãy chọn chương hoặc môn khác.');
    return parsed;
  }

  function start(append = false) {
    if (!session) return;
    if (append && batchStudy?.stage) return;
    if (!append && studyFlowPending) { startStudyPractice(); return; }
    if (!subject) return;
    if (append && batch?.userId !== userId) { setError('Tài khoản đã thay đổi. Hãy bắt đầu lượt luyện tập mới.'); return; }
    const selected = append ? batch.subject : subject;
    const selectedChapter = append ? batch.chapter : chapter;
    const generation = authGeneration.current;
    run('questions', async () => {
      const parsed = await fetchQuestions(selected, selectedChapter, count, append ? questions.map(q => q.id) : []);
      if (generation !== authGeneration.current) return;
      if (!parsed.length) throw new Error(append ? 'Chưa có câu hỏi mới trong lượt này. Bạn có thể thử lại.' : 'Chưa có câu hỏi cho lựa chọn này. Hãy chọn chương hoặc môn khác.');
      if (!append) {
        // Trong thực nghiệm: nhóm có gia sư phản hồi ngay, nhóm không gia sư làm như bài thi.
        enterExam({ id: newAttemptId(), subject: selected, chapter: selectedChapter, instant: instantFor(study, selected._id, aiHints), start: new Date().toISOString(), userId }, parsed);
        notify('success', 'Đã bắt đầu luyện tập', `${selected.subject_name} · ${parsed.length} câu hỏi`);
      } else {
        setQuestions(current => [...current, ...parsed]);
        loadPriorWrong(batch.id, parsed);
        notify('success', 'Đã thêm câu hỏi', `Thêm ${parsed.length} câu mới vào lượt luyện tập.`);
      }
    });
  }

  function submit() {
    if (!session) return;
    if (submitted || !questions.length) return;
    setSubmitConfirmOpen(true);
  }

  function confirmSubmit() {
    if (!session || submitted || !questions.length) return;
    setSubmitConfirmOpen(false);
    if (batch.userId !== userId) { setError('Tài khoản đã thay đổi. Hãy bắt đầu lượt luyện tập mới.'); return; }
    const generation = authGeneration.current;
    run('submit', async () => {
      if (batch.study?.stage) {
        await settleSaves();
        const data = await submitStudyStage(session.token, batch.study.experimentId, batch.study.stage, { answers, tries: batch.instant ? tries : {} });
        if (generation !== authGeneration.current) return;
        const byId = new Map(data.result.items.map(item => [item.question_id, item]));
        setQuestions(list => list.map(q => ({ ...q, correct: byId.get(q.id)?.correct_answer || '' })));
        setAnswers(Object.fromEntries(data.result.items.filter(item => item.selected).map(item => [item.question_id, item.selected])));
        setTries(Object.fromEntries(data.result.items.map(item => [item.question_id, item.tries])));
        setStudy(data.study); setSaved(data.result); setSubmitted(true);
        track('submit', null, { correct: data.result.correct, total: data.result.total });
        eventQueue?.flush();
        activeAttempt.current = ''; setHistoryVersion(v => v + 1); setSuccessOpen(true);
        return;
      }
      const payload = resultPayload({ questions, answers, tries: batch.instant ? tries : {}, subject: batch.subject, section: sectionOf(batch), start: batch.start, end: new Date().toISOString() });
      // Chờ lần tự lưu đang chạy xong, rồi ScoreUp xoá nháp theo draftId cùng lúc lưu kết quả.
      await settleSaves();
      const result = unwrap(await request('/questions/result', { token: session.token, body: { ...payload, draftId: batch.id, idempotency_key: batch.id, hints_enabled: tutorEnabled, hints_used: batch.hintsUsed || 0 } }));
      if (generation !== authGeneration.current) return;
      setSaved(result); setSubmitted(true);
      track('submit', null, { correct, total: questions.length });
      eventQueue?.flush();
      // Nộp xong bài luyện tập của đợt → hoàn thành; từ lượt sau ScorePlus không hiện thực nghiệm nữa.
      const finished = batch.study;
      if (finished && batch.id === practiceAttemptId(finished.experimentId)) {
        setStudy(current => current?.experiment?.id === finished.experimentId ? { ...current, completed: true } : current);
        completeExperiment(session.token, finished.experimentId, batch.id).catch(() => {}); // lỗi: lần sau mở lại, nộp lại trả kết quả cũ (idempotency) rồi báo lại
      }
      activeAttempt.current = '';
      if (draftStore?.mode === 'local') draftStore.remove(batch.id).catch(() => {});
      setDrafts(list => list.filter(d => d.id !== batch.id));
      setHistoryVersion(v => v + 1);
      setSuccessOpen(true);
    });
  }

  const notices = <>
    {standalone && authState === 'signed-out' && <div className="notice" role="status"><span>Đăng nhập bằng tài khoản Microsoft NEU để làm bài và lưu kết quả.</span><Button onClick={signIn}>Đăng nhập với Microsoft (NEU)</Button></div>}
    {authError && <div className="notice error" role="alert"><span>{authError}</span>{!standalone && <Button variant="text" disabled={!!busy || authState === 'connecting'} onClick={() => { setAuthError(''); setAuthState('waiting'); setAuthReload(v => v + 1); }}>Kết nối lại</Button>}</div>}
    {error && <div className="notice error" role="alert"><span>{error}</span><Button variant="text" onClick={() => setError('')}>Đóng</Button></div>}
    {study?.experiment?.flow && study.consent === true && !study.completed && <div className="notice" role="status"><div><strong>Tiến trình thực nghiệm</strong><ol className="mt-2 flex flex-wrap gap-x-6 gap-y-2">{study.experiment.stages.map((stage, index) => <li key={stage.key}><span>{study.stage_results?.[stage.key]?.completed_at ? '✓' : `${index + 1}.`} {STAGE_LABELS[stage.key]}{study.stage === stage.key ? ' · Đang chờ hoàn thành' : ''}</span></li>)}</ol></div></div>}
    {study && !study.completed && (view === 'home' || submitted) && <div className="notice" role="status"><span>Lớp của bạn tham gia nghiên cứu <strong>{study.experiment.name}</strong> · {study.consent ? (studyPractice ? (study.experiment.flow ? `tiếp theo: ${STAGE_LABELS[study.stage]}` : 'bạn chưa làm bài luyện tập của đợt') : 'bạn đã đồng ý ghi dữ liệu ẩn danh') : study.consent === false ? 'bạn không tham gia thu thập dữ liệu' : 'bạn chưa trả lời'}.</span>{studyPractice && <Button variant="text" disabled={!!busy} onClick={() => startStudyPractice()}>Làm bài nghiên cứu</Button>}<Button variant="text" onClick={() => setConsentOpen(true)}>{study.consent ? 'Rút lại đồng ý' : 'Thay đổi lựa chọn'}</Button></div>}
  </>;
  const percent = questions.length ? Math.round(correct / questions.length * 100) : 0;

  return <main className={`workspace ${view === 'exam' ? 'exam-mode' : ''}`}>
    <div className="liquid-bg" aria-hidden="true"><span /><span /><span /><span /></div>
    {toast && <div className="toast-region" aria-live="polite" aria-atomic="true"><div key={toast.id} className={`toast ${toast.kind}`}><span className="toast-icon">{toast.kind === 'success' ? <CheckCircle2 className="icon" /> : <CircleHelp className="icon" />}</span><div className="toast-copy"><strong>{toast.title}</strong><p>{toast.message}</p></div><button className="toast-close" aria-label="Đóng thông báo" onClick={() => setToast(null)}><X className="icon" /></button></div></div>}

    {view !== 'exam' && <header className="mx-1 mt-2 mb-7 flex items-center justify-between gap-6 max-[700px]:mb-[22px] max-[700px]:flex-col max-[700px]:items-stretch max-[700px]:gap-4">
      <div className="min-w-0">
        <div className="eyebrow mb-2 inline-flex items-center gap-2 rounded-full py-1.5 pr-3 pl-[9px] text-[10px] font-bold tracking-[.14em] text-[var(--soft-text)] max-[700px]:flex-wrap"><GraduationCap className="size-4 shrink-0" aria-hidden="true" /> SCOREPLUS <span className="opacity-50">/</span> HỌC TẬP</div>
        <h1 className="practice-title w-fit max-w-full py-[.08em] text-[clamp(36px,4.4vw,48px)] leading-[1.35] tracking-[-.02em]">Luyện tập</h1>
        <p className="mt-1.5 max-w-[560px] text-[15px] leading-[1.7] text-[var(--muted)] max-[700px]:text-sm">Ôn luyện theo môn học, củng cố kiến thức qua từng câu hỏi.</p>
      </div>
      <div className="account" aria-live="polite"><span className="avatar" aria-hidden="true">{(portalUser?.name || portalUser?.email || (standalone ? 'S' : 'A')).trim().charAt(0).toUpperCase()}</span><div className="account-text"><span>{portalUser?.name || portalUser?.email || (standalone ? 'ScoreUp' : 'AI-Portal')}</span><span className={`muted small account-status ${authState}`}>{authState === 'ready' ? 'Đã kết nối' : authState === 'connecting' ? 'Đang kết nối…' : authState === 'waiting' ? 'Đang nhận tài khoản…' : authState === 'signed-out' ? 'Chưa đăng nhập' : 'Chưa kết nối ScoreUp'}</span>{standalone && authState === 'ready' && <Button variant="text" disabled={!!busy} onClick={signOut}>Đăng xuất</Button>}</div></div>
    </header>}

    {view === 'home' && <>
      {notices}
      {!studyFlowPending && <section className="panel filters" aria-labelledby="filter-title">
        <div className="panel-heading"><h2 id="filter-title">Thiết lập luyện tập</h2><span className="muted">Chọn nội dung bạn muốn ôn luyện</span></div>
        <div className="filter-grid">
          <Dropdown label="Môn học" value={subjectId} disabled={loadingSubjects || !!busy} placeholder={loadingSubjects ? 'Đang tải môn học…' : 'Chọn môn học'} options={subjects.map(s => ({ value: s._id, label: s.subject_name }))} onChange={value => { setSubjectId(value); setChapter(''); }} />
          <Dropdown label="Chương / Nội dung" value={chapter} disabled={!subject || !!busy} onChange={setChapter} options={[{ value: '', label: 'Ngẫu nhiên toàn môn' }, ...(subject?.chapters || []).map(c => (typeof c === 'string' ? c : c.chapter)).filter(Boolean).map(id => ({ value: id, label: chapterName(id) }))]} />
          <Dropdown label="Số câu hỏi" value={count} disabled={!!busy} onChange={setCount} options={[5, 10, 15, 20, 30, 50].map(n => ({ value: n, label: `${n} câu` }))} />
          <Button className="start" disabled={!subject || !!busy || !session} loading={busy === 'questions'} loadingText="Đang lấy câu hỏi…" icon={<Sparkles className="icon" />} onClick={() => start()}>Bắt đầu làm bài</Button>
        </div>
        <div className="filter-footer"><label className="checkbox assist-toggle"><input type="checkbox" checked={studyForSubject ? !!studyForSubject.group.tutor_enabled : aiHints} disabled={!!busy || !!studyForSubject} onChange={e => changeAiHints(e.target.checked)} /><span className="assist-copy"><span className="assist-title"><Sparkles className="icon" aria-hidden="true" />Gợi ý từ gia sư AI & phản hồi ngay</span><span className="muted small">{studyForSubject ? (studyForSubject.group.tutor_enabled ? `Cố định theo đợt nghiên cứu của lớp bạn: báo đúng/sai sau mỗi câu, thử lại tối đa ${MAX_TRIES} lần và xin gợi ý AI.` : 'Cố định theo đợt nghiên cứu của lớp bạn: làm như bài thi, xem kết quả sau khi nộp.') : aiHints ? `Báo đúng/sai sau mỗi câu, thử lại tối đa ${MAX_TRIES} lần và xin gợi ý AI.` : 'Đang tắt: làm như bài thi, xem đáp án sau khi nộp.'}</span></span></label></div>
        {!loadingSubjects && !subjects.length && <p className="muted setup-hint">Chưa có môn học để luyện tập.</p>}
        {!session && <p className="muted setup-hint" role="status">{authState === 'connecting' || authState === 'waiting' ? (standalone ? 'Đang kiểm tra đăng nhập…' : 'Đang kết nối tài khoản từ AI-Portal…') : standalone ? 'Cần đăng nhập Microsoft NEU để làm bài và lưu kết quả.' : 'Cần kết nối phiên AI-Portal với ScoreUp để làm bài và lưu kết quả.'}</p>}
      </section>}
      {!studyFlowPending && <HistoryList session={session} subjects={subjects} loadingSubjects={loadingSubjects} drafts={drafts} busy={busy} version={historyVersion} onOpen={openReview} onResume={resume} onDeleteDraft={deleteDraft} onUnauthorized={expireSession} />}
    </>}

    {view === 'review' && <>{notices}<ResultReview key={reviewId} session={session} resultId={reviewId} subjects={subjects} onBack={() => setView('home')} onRetry={retryQuestions} onUnauthorized={expireSession} /></>}

    {view === 'exam' && batch && <>
      <div className="panel exam-bar">
        <Button variant="text" icon={<ArrowLeft className="icon" />} disabled={busy === 'submit'} onClick={leave}>Rời khỏi</Button>
        <div className="exam-title"><span className="muted small">{submitted ? 'Đã nộp bài' : 'Đang làm bài'}</span><h2>{batch.subject.subject_name}</h2></div>
        <span className="badge"><BookOpen className="icon" /> {sectionOf(batch)}</span>
      </div>
      {notices}
      <div className="practice-layout">
        <section className="question-list" aria-label="Các câu hỏi">
          {submitted && <div className="notice success" role="status"><div><strong>{summaryMode ? 'Tổng kết' : 'Đã nộp'} · {correct}/{questions.length} câu đúng · {percent}%</strong><p>{batchStudy?.stage ? "Đáp án hiển thị bên dưới." : "Đáp án và giải thích hiển thị bên dưới."}</p></div><div className="notice-actions">{saved?._id && <Button variant="secondary" size="sm" icon={<ChevronRight className="icon" />} onClick={() => { const id = saved._id; clearAttempt(); openReview(id); }}>Xem lại chi tiết</Button>}{canLeaveAfterSubmit && <Button size="sm" icon={<LogOut className="icon" />} onClick={goHome}>Rời khỏi luyện đề</Button>}</div></div>}
          {questions.map((q, i) => {
            const reveal = submitted || done(q);
            const tried = tries[q.id] || [];
            const retrying = batch.instant && !reveal && !!answers[q.id]; // vừa chọn sai, còn lượt thử
            const status = reveal ? answerStatus(answers[q.id], q.correct) : null;
            const shown = { selected: answers[q.id], correct: q.correct, tries: batch.instant ? tried : [] };
            return <article className={`panel question ${status ? `review-${status}` : ''}`} key={q.id} id={`question-${i}`}>
              <div className="question-heading"><span className="question-number"><CircleHelp className="icon" /> Câu {i + 1}</span>{status ? <span className={`status-tag ${status}`}>{statusLabel(status, shown.tries)}</span> : <span className="muted">{retrying ? 'Chưa đúng · thử lại' : answers[q.id] ? 'Đã trả lời' : 'Chưa trả lời'}</span>}</div>
              {q.context && <Markdown>{q.context}</Markdown>}<Markdown>{q.question}</Markdown>
              {q.image && mediaUrl(q.image) && <img className="question-image" src={mediaUrl(q.image)} alt={`Hình minh họa câu ${i + 1}`} />}
              {q.audio && mediaUrl(q.audio) && <audio controls src={mediaUrl(q.audio)} />}
              {q.code && <pre><code>{q.code}</code></pre>}
              {!submitted && tutorEnabled && <div className="ai-tutor"><Button variant="secondary" size="sm" disabled={!!busy} loading={!!hintBusy[q.id]} loadingText="Gia sư đang suy nghĩ…" icon={<Sparkles className="icon" />} onClick={() => requestHint(q)}>{hints[q.id] ? 'Xin thêm gợi ý' : 'Gợi ý từ gia sư AI'}</Button>{hints[q.id] && <div className="ai-hint" role="status"><div className="ai-hint-heading"><Sparkles className="icon" /><strong>{hints[q.id].label}</strong></div><Markdown>{hints[q.id].content}</Markdown>{hints[q.id].status === 'ok' && eventQueue && batchStudy && <div className="hint-rating" role="group" aria-label="Đánh giá gợi ý"><div className="hint-rating-head"><span>Gợi ý này thế nào?</span>{RATING_FIELDS.every(([field]) => hints[q.id].rating?.[field]) && <span className="hint-rating-done"><Check className="icon" />Đã ghi nhận</span>}</div>{RATING_FIELDS.map(([field, text, low, high]) => { const value = hints[q.id].rating?.[field]; return <div key={field} className="rating-row"><span className="rating-label" id={`rate-${q.id}-${field}`}>{text}</span><div className="rating-scale" role="radiogroup" aria-labelledby={`rate-${q.id}-${field}`}>{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} – ${n === 1 ? low : n === 5 ? high : `mức ${n}/5`}`} title={n === 1 ? low : n === 5 ? high : `${n}/5`} className={value === n ? 'active' : value > n ? 'fill' : ''} onClick={() => rateHint(q, field, n)}>{n}</button>)}</div><span className="rating-ends" aria-hidden="true"><span>{low}</span><span>{high}</span></span></div>; })}</div>}{hints[q.id].status === 'ok' && <p className="ai-disclaimer">Gợi ý do AI tạo; hãy đối chiếu với nội dung môn học.</p>}</div>}</div>}
              <fieldset className="options" disabled={!!busy || !session || submitted || done(q)}><legend className="sr-only">Đáp án câu {i + 1}</legend>{q.options.map(option => {
                // Đã hiện đáp án: cùng cách đánh dấu/nhãn với màn Lịch sử. Đang thử lại: tô đỏ phương án đã thử sai.
                const wrong = reveal ? optionWrong(option.key, shown) : batch.instant && tried.includes(option.key) && option.key !== q.correct;
                const tag = reveal ? optionTag(option.key, shown) : '';
                return <label key={option.key} className={`option ${!reveal && answers[q.id] === option.key && !wrong ? 'selected' : ''} ${reveal && q.correct === option.key ? 'correct' : ''} ${wrong ? 'wrong' : ''}`}><input type="radio" name={`answer-${q.id}`} value={option.key} checked={answers[q.id] === option.key} disabled={batch.instant && tried.includes(option.key)} onChange={() => chooseAnswer(q, option.key)} /><span className="option-letter">{option.key}</span><Markdown>{option.text}</Markdown>{tag && <span className="option-tag">{tag}</span>}</label>;
              })}</fieldset>
              {retrying && <p className="retry-note" role="status">Chưa đúng. Em còn {MAX_TRIES - tried.length} lần thử — hãy xin gia sư gợi ý nếu cần.</p>}
              {reveal && <div className="explanation"><strong>Đáp án: {q.correct || 'Chưa có'}{status === 'skipped' && ' · Bạn chưa trả lời câu này'}</strong>{q.explanation && <Markdown>{q.explanation}</Markdown>}</div>}
            </article>;
          })}
          {!submitted && !batchStudy?.stage && <Button variant="secondary" full disabled={!!busy || !session} icon={<Sparkles className="icon" />} onClick={() => start(true)}>Làm tiếp · thêm {count} câu</Button>}
        </section>
        <aside className="panel progress-panel"><h2><Clock3 className="icon" /> Tiến độ làm bài</h2><div className="progress-count"><strong>{answered}<small> / {questions.length}</small></strong><span className="muted">đã trả lời</span></div><progress value={answered} max={questions.length} aria-label="Số câu đã trả lời" /><div className="palette">{questions.map((q, i) => <a key={q.id} href={`#question-${i}`} aria-label={`Đến câu ${i + 1}`} className={submitted || done(q) ? answerStatus(answers[q.id], q.correct) : answers[q.id] ? 'selected' : ''}>{i + 1}</a>)}</div><p className="muted">{submitted ? 'Chọn số để xem lại từng câu.' : draftSave === 'saving' ? 'Đang lưu nháp…' : draftSave === 'saved' ? `Đã lưu nháp${draftStore?.mode === 'server' ? ' vào tài khoản' : ' trên trình duyệt này'}.` : draftSave === 'error' ? 'Chưa lưu được nháp — sẽ thử lại khi bạn trả lời tiếp.' : 'Bài làm được tự lưu nháp khi bạn trả lời.'}</p><Button full disabled={!!busy || !session || submitted} loading={busy === 'submit'} loadingText={summaryMode ? 'Đang tổng kết…' : 'Đang lưu kết quả…'} icon={submitted ? <Check className="icon" /> : summaryMode ? <ListChecks className="icon" /> : <Send className="icon" />} onClick={submit}>{submitted ? (summaryMode ? 'Đã tổng kết' : 'Đã nộp bài') : summaryMode ? 'Xem tổng kết bài làm' : 'Nộp bài'}</Button></aside>
      </div>
    </>}

    <Modal open={consentOpen && !!study} onClose={() => setConsentOpen(false)} labelledBy="consent-title"><div className="confirm-icon"><GraduationCap className="icon-lg" /></div><h2 id="consent-title">Tham gia nghiên cứu: {study?.experiment.name}</h2>{study?.consent === true ? <p>Bạn đã đồng ý tham gia nghiên cứu.{studyPractice ? ' Hãy hoàn thành lần lượt các bài của đợt.' : ''}</p> : study?.experiment.consent_text ? <Markdown>{study.experiment.consent_text}</Markdown> : <p>Lớp học phần của bạn đang tham gia nghiên cứu về gia sư AI trong luyện tập trắc nghiệm. Nếu đồng ý, quá trình luyện tập (lựa chọn, gợi ý đã xem, đánh giá gợi ý) được ghi lại dưới mã ẩn danh, chỉ dùng cho nghiên cứu và không ảnh hưởng đến điểm học phần.</p>}{practiceConfig && (study?.consent !== true || studyPractice) && <p><strong>Quy trình:</strong> {practiceInfo}.{study?.consent !== true ? ' Đồng ý là vào làm bài ngay;' : ''} hoàn thành sau khi nộp đủ các bài của đợt.</p>}<p className="muted small">Bạn có thể rút lại đồng ý bất cứ lúc nào; khi đó dữ liệu đã ghi sẽ bị xoá.</p><div className="confirm-actions">{study?.consent === true
      ? <><Button variant="secondary" disabled={!!busy} onClick={() => answerConsent(false)}>Rút lại đồng ý</Button>{studyPractice ? <Button icon={<Sparkles className="icon" />} disabled={!!busy || loadingSubjects} onClick={() => startStudyPractice()}>Làm bài ngay</Button> : <Button onClick={() => setConsentOpen(false)}>Đóng</Button>}</>
      : <><Button variant="secondary" disabled={!!busy} onClick={() => answerConsent(false)}>Không đồng ý</Button><Button icon={<Check className="icon" />} disabled={!!busy || (!!practiceConfig && loadingSubjects)} onClick={() => answerConsent(true)}>{practiceConfig ? 'Đồng ý và làm bài' : 'Đồng ý tham gia'}</Button></>}</div></Modal>

    <Modal open={submitConfirmOpen} onClose={() => setSubmitConfirmOpen(false)} labelledBy="submit-confirm-title"><div className="confirm-icon">{summaryMode ? <ListChecks className="icon-lg" /> : <Send className="icon-lg" />}</div><h2 id="submit-confirm-title">{summaryMode ? 'Kết thúc và xem tổng kết?' : 'Xác nhận nộp bài'}</h2>{answered < questions.length ? <><p>Bạn còn <strong>{questions.length - answered} câu chưa trả lời</strong>. Những câu này sẽ được tính là chưa đúng khi lưu kết quả.</p><p>{summaryMode ? 'Bạn có muốn kết thúc lượt và xem tổng kết ngay không?' : 'Bạn có muốn nộp bài ngay bây giờ không?'}</p></> : <><p>Bạn đã trả lời đủ <strong>{questions.length} câu</strong>.</p><p>{summaryMode ? 'Kết quả được lưu vào tài khoản ScoreUp; sau đó lượt này không làm tiếp được.' : 'Kết quả sẽ được lưu vào tài khoản ScoreUp. Bạn sẽ không thể chỉnh sửa câu trả lời sau khi nộp.'}</p></>}<div className="confirm-actions"><Button variant="secondary" onClick={() => setSubmitConfirmOpen(false)}>Tiếp tục làm bài</Button><Button icon={summaryMode ? <ListChecks className="icon" /> : <Send className="icon" />} onClick={confirmSubmit}>{summaryMode ? 'Xem tổng kết' : 'Xác nhận nộp'}</Button></div></Modal>

    <Modal open={!!deleteTarget} onClose={() => busy !== `delete:${deleteTarget?.id}` && setDeleteTarget(null)} labelledBy="delete-draft-title"><div className="confirm-icon danger"><Trash2 className="icon-lg" /></div><h2 id="delete-draft-title">Xoá bài chưa nộp?</h2>{deleteTarget && <><p><strong>{deleteTarget.subjectName || 'Bài luyện tập'}</strong> · {sectionOf(deleteTarget)}</p><p>Bạn đã làm <strong>{deleteTarget.answered}/{deleteTarget.total} câu</strong>{deleteTarget.updatedAt ? `, lưu lúc ${formatDateTime(deleteTarget.updatedAt)}` : ''}. Bài sẽ bị xoá vĩnh viễn và không thể khôi phục.</p></>}<div className="confirm-actions"><Button variant="secondary" disabled={busy === `delete:${deleteTarget?.id}`} onClick={() => setDeleteTarget(null)}>Giữ lại</Button><Button variant="danger" icon={<Trash2 className="icon" />} loading={busy === `delete:${deleteTarget?.id}`} loadingText="Đang xoá…" onClick={confirmDeleteDraft}>Xoá bài</Button></div></Modal>

    <Modal open={leaveOpen} onClose={() => setLeaveOpen(false)} labelledBy="leave-title"><div className="confirm-icon"><Save className="icon-lg" /></div><h2 id="leave-title">Rời khỏi bài làm?</h2><p>Bạn đã làm <strong>{answered}/{questions.length} câu</strong>. {batchStudy?.stage ? <>Bài được lưu trong đợt thực nghiệm; vào lại ScorePlus để tiếp tục đúng giai đoạn.</> : <>Bài sẽ được lưu ở mục <strong>Chưa nộp</strong> trong Lịch sử làm bài để bạn làm tiếp sau.</>}</p><div className="confirm-actions"><Button variant="secondary" disabled={busy === 'leave'} onClick={() => setLeaveOpen(false)}>Ở lại làm bài</Button><Button icon={<LogOut className="icon" />} loading={busy === 'leave'} loadingText="Đang lưu…" onClick={confirmLeave}>Lưu và rời khỏi</Button></div></Modal>

    <Modal open={successOpen} onClose={() => setSuccessOpen(false)} labelledBy="success-title" className="success-dialog"><ScoreRing percent={percent} size="lg" /><h2 id="success-title">{summaryMode ? 'Tổng kết bài làm' : 'Nộp bài thành công!'}</h2><p>{batch?.subject?.subject_name} · {sectionOf(batch)}</p><p>Bạn trả lời đúng <strong>{correct}/{questions.length} câu</strong>. Kết quả đã được lưu vào tài khoản ScoreUp.</p>{summaryMode && (() => { const s = attemptSummary(questions, answers, tries); return <ul className="summary-stats" aria-label="Tổng kết theo số lần thử">{[['first', 'Đúng ngay lần 1'], ['retried', 'Đúng sau khi thử lại'], ['wrong', `Sai${s.wrong ? ` (tối đa ${MAX_TRIES} lần)` : ''}`], ['skipped', 'Bỏ trống']].map(([key, label]) => <li key={key} className={`stat-${key}`}><strong>{s[key]}</strong><span>{label}</span></li>)}</ul>; })()}<div className="confirm-actions">{saved?._id && <Button variant="secondary" icon={<ChevronRight className="icon" />} onClick={() => { const id = saved._id; clearAttempt(); openReview(id); }}>Xem lại chi tiết</Button>}{batchStudy?.stage && studyPractice && <Button icon={<ChevronRight className="icon" />} disabled={!!busy} onClick={() => startStudyPractice()}>Tiếp tục: {STAGE_LABELS[study.stage]}</Button>}{canLeaveAfterSubmit && <Button icon={<LogOut className="icon" />} onClick={goHome}>Rời khỏi luyện đề</Button>}</div></Modal>
  </main>;
}
