'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, GraduationCap, LogOut, RefreshCw, Save, Send, Sparkles, X } from 'lucide-react';
import { mediaUrl, request } from '../lib/api.mjs';
import { certificateIdOf, chapterName, parseQuestion, resultPayload, sectionOf, unwrap } from '../lib/practice.mjs';
import { createDraftStore, newAttemptId } from '../lib/drafts.mjs';
import { loadPortalUser, loadScoreupSessionFromPortal, portalApiPath, subscribePortalUser } from '../lib/portal-auth.mjs';
import Button from './Button';
import Dropdown from './Dropdown';
import Markdown from './Markdown';
import Modal from './Modal';
import { HistoryList, ResultReview, ScoreRing } from './History';
import { clearStandaloneSession, isStandalone, loadStandaloneSession, microsoftLoginUrl } from '../lib/microsoft-auth.mjs';

// Endpoint SSO của AI-Portal (backend routes/scoreplus.ts); env chỉ dùng khi Portal đặt endpoint ở path khác.
const SESSION_PATH = process.env.NEXT_PUBLIC_PORTAL_SCOREUP_SESSION_PATH || '/api/scoreplus/session';

export default function Practice() {
  // 'home' (thiết lập + lịch sử) | 'exam' (trang làm bài) | 'review' — giữ trong state, không đổi URL vì app chạy trong iframe của Portal.
  const [view, setView] = useState('home');
  const [reviewId, setReviewId] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [draftSave, setDraftSave] = useState('idle');
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [chapter, setChapter] = useState('');
  const [count, setCount] = useState(10);
  const [instant, setInstant] = useState(false);
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
  const [portalUser, setPortalUser] = useState(null);
  const [authState, setAuthState] = useState('waiting');
  const [authError, setAuthError] = useState('');
  const [authReload, setAuthReload] = useState(0);
  // Chạy riêng (không nằm dưới /embed/scoreplus của Portal) → đăng nhập Microsoft như ScoreUp.
  const [standalone, setStandalone] = useState(false);
  const portalIdentity = useRef(null);
  const authGeneration = useRef(0);
  const [reload, setReload] = useState(0);
  const actionLock = useRef(false);
  const toastTimer = useRef(null);
  const subject = subjects.find(s => s._id === subjectId);
  const answered = questions.filter(q => answers[q.id]).length;
  const correct = questions.filter(q => answers[q.id] && answers[q.id] === q.correct).length;
  const userId = session ? String(session.user._id || session.user.id) : '';

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
        setHints({}); setHintBusy({}); setSubmitConfirmOpen(false);
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
  }, [reload]);

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
    const run = (pendingSave.current || Promise.resolve()).catch(() => {}).then(() => draftStore.save(draft));
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
        upsertDraft(summary); setDraftSave('saved');
      }).catch(() => { if (activeAttempt.current === batch.id) setDraftSave('error'); });
    }, 1200);
    return () => clearTimeout(timer);
  }, [view, submitted, batch, answers, questions, userId, draftStore]);

  function draftOf() {
    return { id: batch.id, subject: batch.subject, chapter: batch.chapter, label: batch.label || '', instant: batch.instant, start: batch.start, questions, answers };
  }

  function clearAttempt() {
    activeAttempt.current = '';
    setQuestions([]); setAnswers({}); setBatch(null); setSaved(null); setSubmitted(false); setDraftSave('idle');
    setHints({}); setHintBusy({}); setSubmitConfirmOpen(false); setLeaveOpen(false); setSuccessOpen(false);
  }

  function goHome() { clearAttempt(); setView('home'); window.scrollTo?.({ top: 0 }); }

  function enterExam(nextBatch, nextQuestions, nextAnswers = {}) {
    activeAttempt.current = nextBatch.id;
    setQuestions(nextQuestions); setAnswers(nextAnswers); setBatch(nextBatch); setDraftSave('idle');
    setSaved(null); setSubmitted(false); setHints({}); setHintBusy({});
    setView('exam'); window.scrollTo?.({ top: 0 });
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
      upsertDraft(summary);
      goHome();
      notify('success', 'Đã lưu bài chưa nộp', draftStore.mode === 'server' ? 'Bạn có thể làm tiếp trong Lịch sử làm bài, kể cả trên thiết bị khác.' : 'Bạn có thể làm tiếp trong Lịch sử làm bài trên trình duyệt này.');
    });
  }

  function resume(summary) {
    if (!session || !draftStore) return;
    run(`resume:${summary.id}`, async () => {
      const draft = await draftStore.get(summary.id);
      if (!draft.questions.length) throw new Error('Các câu hỏi của bài này không còn trong ngân hàng câu hỏi.');
      const selected = subjects.find(s => s._id === draft.subject?._id) || draft.subject;
      enterExam({ id: draft.id, subject: selected, chapter: draft.chapter || '', label: draft.label || '', instant: !!draft.instant, start: draft.start, userId }, draft.questions, draft.answers || {});
    });
  }

  function deleteDraft(summary) {
    if (!draftStore || !window.confirm(`Xoá bài chưa nộp "${summary.subjectName} · ${sectionOf(summary)}"? Không thể khôi phục.`)) return;
    run(`delete:${summary.id}`, async () => {
      await draftStore.remove(summary.id);
      setDrafts(list => list.filter(d => d.id !== summary.id));
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
    setHints({}); setHintBusy({}); setSubmitConfirmOpen(false); setLeaveOpen(false); setSuccessOpen(false);
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
    const selected = subjects.find(s => certificateIdOf(s) === result.certificateId);
    if (!selected) { notify('error', 'Không tìm thấy môn học', 'Môn của lượt này không còn trong danh sách luyện tập.'); return; }
    setSubjectId(selected._id); setChapter('');
    enterExam({ id: newAttemptId(), subject: selected, chapter: '', label: 'Ôn lại câu chưa đúng', instant, start: new Date().toISOString(), userId }, retry);
    notify('success', 'Đã tạo lượt ôn lại', `${retry.length} câu chưa đúng từ lượt trước.`);
  }

  async function requestHint(question) {
    if (hintBusy[question.id]) return;
    const generation = authGeneration.current;
    setHintBusy(current => ({ ...current, [question.id]: true }));
    try {
      const selected = answers[question.id];
      const prompt = [
        `Câu hỏi: ${question.question}`,
        question.context ? `Ngữ cảnh: ${question.context}` : '',
        `Các lựa chọn: ${question.options.map(option => `${option.key}. ${option.text}`).join(' | ')}`,
        selected ? `Sinh viên đã chọn: ${selected}. ${question.options.find(option => option.key === selected)?.text || ''}` : 'Sinh viên chưa chọn đáp án.',
        question.explanation ? `Giải thích/đáp án tham khảo từ ngân hàng câu hỏi: ${question.explanation}` : '',
      ].filter(Boolean).join('\n');
      const response = await fetch(portalApiPath('/api/ai/complete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          system: 'Bạn là gia sư học tập bằng tiếng Việt. Hãy giúp sinh viên tự suy luận: nêu một gợi ý cụ thể và giải thích ngắn gọn vì sao hướng suy nghĩ đó hữu ích. Không tiết lộ chữ cái hoặc nội dung đáp án đúng, không chọn đáp án hộ sinh viên. Chỉ dựa trên nội dung được cung cấp; nếu thiếu dữ kiện, hãy nói rõ điều đó. Trả lời ngắn, dễ hiểu, tối đa 120 từ.',
        }),
        signal: AbortSignal.timeout(45000),
        credentials: 'same-origin',
      });
      const data = await response.json().catch(() => null);
      if (generation !== authGeneration.current) return;
      if (!response.ok) {
        if (response.status === 503) throw new Error(data?.message || 'AI-Portal chưa cấu hình Central LLM.');
        throw new Error(data?.message || `AI-Portal trả về lỗi (${response.status}).`);
      }
      if (!data?.content) throw new Error('AI chưa tạo được gợi ý. Hãy thử lại.');
      setHints(current => ({ ...current, [question.id]: data.content }));
      notify('success', 'Gia sư AI đã trả lời', 'Hãy dùng gợi ý để tự suy luận trước khi chọn đáp án.');
    } catch (e) {
      if (generation !== authGeneration.current) return;
      const message = e.name === 'TimeoutError'
        ? 'Yêu cầu AI quá lâu. Kiểm tra Central LLM rồi thử lại.'
        : e instanceof TypeError
          ? 'Không kết nối được endpoint AI của AI-Portal. Hãy kiểm tra Portal/backend đang chạy và base path.'
          : e.message;
      notify('error', 'Chưa lấy được gợi ý AI', message);
    } finally {
      if (generation === authGeneration.current) setHintBusy(current => ({ ...current, [question.id]: false }));
    }
  }

  function start(append = false) {
    if (!session) return;
    if (!subject) return;
    if (append && batch?.userId !== userId) { setError('Tài khoản đã thay đổi. Hãy bắt đầu lượt luyện tập mới.'); return; }
    const selected = append ? batch.subject : subject;
    const selectedChapter = append ? batch.chapter : chapter;
    const generation = authGeneration.current;
    run('questions', async () => {
      const data = unwrap(await request('/questions', { token: session.token, body: { subject_id: selected._id, chapter_id: selectedChapter, limit: Number(count) } }));
      if (generation !== authGeneration.current) return;
      if (!Array.isArray(data)) throw new Error('Dữ liệu câu hỏi không hợp lệ.');
      const existing = new Set(append ? questions.map(q => q.id) : []);
      const parsed = data.flat().map(parseQuestion).filter(q => {
        if (!q.id || !q.question || !q.options.length || existing.has(q.id)) return false;
        existing.add(q.id); return true;
      });
      if (!parsed.length) throw new Error(append ? 'Chưa có câu hỏi mới trong lượt này. Bạn có thể thử lại.' : 'Chưa có câu hỏi cho lựa chọn này. Hãy chọn chương hoặc môn khác.');
      if (!append) {
        enterExam({ id: newAttemptId(), subject: selected, chapter: selectedChapter, instant, start: new Date().toISOString(), userId }, parsed);
        notify('success', 'Đã bắt đầu luyện tập', `${selected.subject_name} · ${parsed.length} câu hỏi`);
      } else {
        setQuestions(current => [...current, ...parsed]);
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
      const payload = resultPayload({ questions, answers, subject: batch.subject, section: sectionOf(batch), start: batch.start, end: new Date().toISOString() });
      // Chờ lần tự lưu đang chạy xong, rồi ScoreUp xoá nháp theo draftId cùng lúc lưu kết quả.
      await settleSaves();
      const result = unwrap(await request('/questions/result', { token: session.token, body: { ...payload, draftId: batch.id } }));
      if (generation !== authGeneration.current) return;
      setSaved(result); setSubmitted(true);
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
  </>;
  const percent = questions.length ? Math.round(correct / questions.length * 100) : 0;

  return <main className={`workspace ${view === 'exam' ? 'exam-mode' : ''}`}>
    <div className="liquid-bg" aria-hidden="true"><span /><span /><span /><span /></div>
    {toast && <div className="toast-region" aria-live="polite" aria-atomic="true"><div key={toast.id} className={`toast ${toast.kind}`}><span className="toast-icon">{toast.kind === 'success' ? <CheckCircle2 className="icon" /> : <CircleHelp className="icon" />}</span><div className="toast-copy"><strong>{toast.title}</strong><p>{toast.message}</p></div><button className="toast-close" aria-label="Đóng thông báo" onClick={() => setToast(null)}><X className="icon" /></button></div></div>}

    {view !== 'exam' && <header className="page-heading">
      <div className="title-block"><div className="eyebrow"><GraduationCap className="icon" /> SCOREPLUS <span>/</span> HỌC TẬP</div><h1>Luyện tập</h1><p>Ôn luyện theo môn học, củng cố kiến thức qua từng câu hỏi.</p></div>
      <div className="account" aria-live="polite"><span className="avatar" aria-hidden="true">{(portalUser?.name || portalUser?.email || (standalone ? 'S' : 'A')).trim().charAt(0).toUpperCase()}</span><div className="account-text"><span>{portalUser?.name || portalUser?.email || (standalone ? 'ScoreUp' : 'AI-Portal')}</span><span className={`muted small account-status ${authState}`}>{authState === 'ready' ? 'Đã kết nối' : authState === 'connecting' ? 'Đang kết nối…' : authState === 'waiting' ? 'Đang nhận tài khoản…' : authState === 'signed-out' ? 'Chưa đăng nhập' : 'Chưa kết nối ScoreUp'}</span>{standalone && authState === 'ready' && <Button variant="text" disabled={!!busy} onClick={signOut}>Đăng xuất</Button>}</div></div>
    </header>}

    {view === 'home' && <>
      {notices}
      <section className="panel filters" aria-labelledby="filter-title">
        <div className="panel-heading"><h2 id="filter-title">Thiết lập luyện tập</h2><span className="muted">Chọn nội dung bạn muốn ôn luyện</span></div>
        <div className="filter-grid">
          <Dropdown label="Môn học" value={subjectId} disabled={loadingSubjects || !!busy} placeholder={loadingSubjects ? 'Đang tải môn học…' : 'Chọn môn học'} options={subjects.map(s => ({ value: s._id, label: s.subject_name }))} onChange={value => { setSubjectId(value); setChapter(''); }} />
          <Dropdown label="Chương / Nội dung" value={chapter} disabled={!subject || !!busy} onChange={setChapter} options={[{ value: '', label: 'Ngẫu nhiên toàn môn' }, ...(subject?.chapters || []).map(c => (typeof c === 'string' ? c : c.chapter)).filter(Boolean).map(id => ({ value: id, label: chapterName(id) }))]} />
          <Dropdown label="Số câu hỏi" value={count} disabled={!!busy} onChange={setCount} options={[5, 10, 15, 20, 30, 50].map(n => ({ value: n, label: `${n} câu` }))} />
          <Button className="start" disabled={!subject || !!busy || !session} loading={busy === 'questions'} loadingText="Đang lấy câu hỏi…" icon={<Sparkles className="icon" />} onClick={() => start()}>Bắt đầu làm bài</Button>
        </div>
        <div className="filter-footer"><label className="checkbox"><input type="checkbox" checked={instant} disabled={!!busy} onChange={e => setInstant(e.target.checked)} />Hiện đáp án sau mỗi câu</label><Button variant="text" disabled={loadingSubjects || !!busy} icon={<RefreshCw className="icon" />} onClick={() => { setError(''); setReload(v => v + 1); }}>Tải lại môn học</Button></div>
        {!loadingSubjects && !subjects.length && <p className="muted setup-hint">Chưa có môn học để luyện tập. Hãy thử tải lại danh sách.</p>}
        {!session && <p className="muted setup-hint" role="status">{authState === 'connecting' || authState === 'waiting' ? (standalone ? 'Đang kiểm tra đăng nhập…' : 'Đang kết nối tài khoản từ AI-Portal…') : standalone ? 'Cần đăng nhập Microsoft NEU để làm bài và lưu kết quả.' : 'Cần kết nối phiên AI-Portal với ScoreUp để làm bài và lưu kết quả.'}</p>}
      </section>
      <HistoryList session={session} subjects={subjects} loadingSubjects={loadingSubjects} drafts={drafts} busy={busy} version={historyVersion} onOpen={openReview} onResume={resume} onDeleteDraft={deleteDraft} onUnauthorized={expireSession} />
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
          {submitted && <div className="notice success" role="status"><div><strong>Đã nộp · {correct}/{questions.length} câu đúng · {percent}%</strong><p>Đáp án và giải thích hiển thị bên dưới.</p></div><div className="notice-actions">{saved?._id && <Button variant="secondary" size="sm" icon={<ChevronRight className="icon" />} onClick={() => { const id = saved._id; clearAttempt(); openReview(id); }}>Xem lại chi tiết</Button>}<Button size="sm" icon={<LogOut className="icon" />} onClick={goHome}>Rời khỏi luyện đề</Button></div></div>}
          {questions.map((q, i) => {
            const reveal = submitted || (batch.instant && !!answers[q.id]);
            return <article className="panel question" key={q.id} id={`question-${i}`}>
              <div className="question-heading"><span className="question-number"><CircleHelp className="icon" /> Câu {i + 1}</span><span className="muted">{reveal ? answers[q.id] === q.correct ? '✓ Chính xác' : 'Cần ôn lại' : answers[q.id] ? 'Đã trả lời' : 'Chưa trả lời'}</span></div>
              {q.context && <Markdown>{q.context}</Markdown>}<Markdown>{q.question}</Markdown>
              {q.image && mediaUrl(q.image) && <img className="question-image" src={mediaUrl(q.image)} alt={`Hình minh họa câu ${i + 1}`} />}
              {q.audio && mediaUrl(q.audio) && <audio controls src={mediaUrl(q.audio)} />}
              {q.code && <pre><code>{q.code}</code></pre>}
              {!submitted && <div className="ai-tutor"><Button variant="secondary" size="sm" disabled={!!busy} loading={!!hintBusy[q.id]} loadingText="Gia sư đang suy nghĩ…" icon={<Sparkles className="icon" />} onClick={() => requestHint(q)}>{hints[q.id] ? 'Hỏi gia sư gợi ý khác' : 'Gợi ý từ gia sư AI'}</Button>{hints[q.id] && <div className="ai-hint" role="status"><div className="ai-hint-heading"><Sparkles className="icon" /><strong>Gợi ý học tập</strong></div><Markdown>{hints[q.id]}</Markdown><p className="ai-disclaimer">Gợi ý do AI tạo; hãy đối chiếu với nội dung môn học.</p></div>}</div>}
              <fieldset className="options" disabled={!!busy || !session || submitted || (batch.instant && !!answers[q.id])}><legend className="sr-only">Đáp án câu {i + 1}</legend>{q.options.map(option => <label key={option.key} className={`option ${answers[q.id] === option.key ? 'selected' : ''} ${reveal && q.correct === option.key ? 'correct' : ''} ${reveal && answers[q.id] === option.key && q.correct !== option.key ? 'wrong' : ''}`}><input type="radio" name={`answer-${q.id}`} value={option.key} checked={answers[q.id] === option.key} onChange={() => setAnswers(current => ({ ...current, [q.id]: option.key }))} /><span className="option-letter">{option.key}</span><Markdown>{option.text}</Markdown></label>)}</fieldset>
              {reveal && <div className="explanation"><strong>Đáp án: {q.correct || 'Chưa có'}</strong>{q.explanation && <Markdown>{q.explanation}</Markdown>}</div>}
            </article>;
          })}
          {!submitted && <Button variant="secondary" full disabled={!!busy || !session} icon={<Sparkles className="icon" />} onClick={() => start(true)}>Làm tiếp · thêm {count} câu</Button>}
        </section>
        <aside className="panel progress-panel"><h2><Clock3 className="icon" /> Tiến độ làm bài</h2><div className="progress-count"><strong>{answered}<small> / {questions.length}</small></strong><span className="muted">đã trả lời</span></div><progress value={answered} max={questions.length} aria-label="Số câu đã trả lời" /><div className="palette">{questions.map((q, i) => <a key={q.id} href={`#question-${i}`} aria-label={`Đến câu ${i + 1}`} className={submitted ? answers[q.id] === q.correct ? 'correct' : 'wrong' : answers[q.id] ? 'selected' : ''}>{i + 1}</a>)}</div><p className="muted">{submitted ? 'Chọn số để xem lại từng câu.' : draftSave === 'saving' ? 'Đang lưu nháp…' : draftSave === 'saved' ? `Đã lưu nháp${draftStore?.mode === 'server' ? ' vào tài khoản' : ' trên trình duyệt này'}.` : draftSave === 'error' ? 'Chưa lưu được nháp — sẽ thử lại khi bạn trả lời tiếp.' : 'Bài làm được tự lưu nháp khi bạn trả lời.'}</p><Button full disabled={!!busy || !session || submitted} loading={busy === 'submit'} loadingText="Đang lưu kết quả…" icon={submitted ? <Check className="icon" /> : <Send className="icon" />} onClick={submit}>{submitted ? 'Đã nộp bài' : 'Nộp bài'}</Button></aside>
      </div>
    </>}

    <Modal open={submitConfirmOpen} onClose={() => setSubmitConfirmOpen(false)} labelledBy="submit-confirm-title"><div className="confirm-icon"><Send className="icon-lg" /></div><h2 id="submit-confirm-title">Xác nhận nộp bài</h2>{answered < questions.length ? <><p>Bạn còn <strong>{questions.length - answered} câu chưa trả lời</strong>. Những câu này sẽ được tính là chưa đúng khi lưu kết quả.</p><p>Bạn có muốn nộp bài ngay bây giờ không?</p></> : <><p>Bạn đã trả lời đủ <strong>{questions.length} câu</strong>.</p><p>Kết quả sẽ được lưu vào tài khoản ScoreUp. Bạn sẽ không thể chỉnh sửa câu trả lời sau khi nộp.</p></>}<div className="confirm-actions"><Button variant="secondary" onClick={() => setSubmitConfirmOpen(false)}>Tiếp tục làm bài</Button><Button icon={<Send className="icon" />} onClick={confirmSubmit}>Xác nhận nộp</Button></div></Modal>

    <Modal open={leaveOpen} onClose={() => setLeaveOpen(false)} labelledBy="leave-title"><div className="confirm-icon"><Save className="icon-lg" /></div><h2 id="leave-title">Rời khỏi bài làm?</h2><p>Bạn đã làm <strong>{answered}/{questions.length} câu</strong>. Bài sẽ được lưu ở mục <strong>Chưa nộp</strong> trong Lịch sử làm bài để bạn làm tiếp sau.</p><div className="confirm-actions"><Button variant="secondary" disabled={busy === 'leave'} onClick={() => setLeaveOpen(false)}>Ở lại làm bài</Button><Button icon={<LogOut className="icon" />} loading={busy === 'leave'} loadingText="Đang lưu…" onClick={confirmLeave}>Lưu và rời khỏi</Button></div></Modal>

    <Modal open={successOpen} onClose={() => setSuccessOpen(false)} labelledBy="success-title" className="success-dialog"><ScoreRing percent={percent} size="lg" /><h2 id="success-title">Nộp bài thành công!</h2><p>{batch?.subject?.subject_name} · {sectionOf(batch)}</p><p>Bạn trả lời đúng <strong>{correct}/{questions.length} câu</strong>. Kết quả đã được lưu vào tài khoản ScoreUp.</p><div className="confirm-actions">{saved?._id && <Button variant="secondary" icon={<ChevronRight className="icon" />} onClick={() => { const id = saved._id; clearAttempt(); openReview(id); }}>Xem lại chi tiết</Button>}<Button icon={<LogOut className="icon" />} onClick={goHome}>Rời khỏi luyện đề</Button></div><Button variant="text" className="dialog-dismiss" onClick={() => setSuccessOpen(false)}>Xem đáp án tại đây</Button></Modal>
  </main>;
}
