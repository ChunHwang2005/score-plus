'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CalendarClock, ChevronLeft, ChevronRight, CircleCheck, CircleDashed, CircleHelp, CircleX, History as HistoryIcon, LayoutGrid, ListChecks, Play, RotateCcw, Rows3, Sparkles, Target, Timer, Trash2, Trophy } from 'lucide-react';
import { mediaUrl, request } from '../lib/api.mjs';
import { certificateIdOf, formatDateTime, formatDuration, hintStatus, historyStats, pageWindow, resultSummary, reviewItems, scoreTone, sectionOf, unwrap } from '../lib/practice.mjs';
import Button from './Button';
import Dropdown from './Dropdown';
import Markdown from './Markdown';

const FILTERS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'wrong', label: 'Làm sai' },
  { value: 'skipped', label: 'Bỏ trống' },
  { value: 'correct', label: 'Làm đúng' },
];
const STATUS_LABEL = { correct: '✓ Chính xác', wrong: 'Sai', skipped: 'Bỏ trống' };

/** Vòng điểm kiểu kính: rãnh kính mờ + cung SVG dải màu theo mức điểm (đầu bo tròn, có quầng sáng) + lõi kính. */
export function ScoreRing({ percent, size = 'md' }) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  // useId có thể chứa ký tự không hợp lệ trong url(#…) → chỉ giữ chữ/số.
  const gradient = `ring-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return <div className={`score-ring ${size} tone-${scoreTone(value)}`} role="img" aria-label={`Đạt ${value}%`}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="ring-stop-a" /><stop offset="1" className="ring-stop-b" /></linearGradient></defs>
      <circle className="ring-track" cx="50" cy="50" r="42" />
      {value > 0 && <circle className="ring-arc" cx="50" cy="50" r="42" pathLength="100" stroke={`url(#${gradient})`} style={{ strokeDashoffset: 100 - value }} transform="rotate(-90 50 50)" />}
    </svg>
    <span className="ring-core"><span>{value}<small>%</small></span></span>
  </div>;
}

/** Tải dữ liệu ScoreUp theo token; lỗi 401 được đẩy lên Practice để xử lý phiên. */
function useScoreup(path, token, onUnauthorized, deps) {
  const [state, setState] = useState({ data: null, loading: false, error: '' });
  useEffect(() => {
    if (!token || !path) { setState({ data: null, loading: false, error: '' }); return; }
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: '' }));
    request(path, { token, signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data: unwrap(data), loading: false, error: '' });
    }).catch(e => {
      if (controller.signal.aborted || e.name === 'AbortError') return;
      setState({ data: null, loading: false, error: e.message });
      if (e.status === 401) onUnauthorized();
    });
    return () => controller.abort();
  }, [path, token, ...deps]);
  return state;
}

const STATUS_FILTERS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'draft', label: 'Chưa nộp' },
  { value: 'result', label: 'Đã nộp' },
];

const MINE_PAGE = 100;

/**
 * Lịch sử gọn mọi môn: GET /questions/result/mine (phân trang theo createdAt).
 * ScoreUp bản cũ chưa có endpoint này (route /result/:id bắt "mine" → 400/404) → gọi /questions/result theo từng môn.
 */
function useAllResults(session, subjects, onUnauthorized, deps) {
  const certificateIds = useMemo(() => [...new Set(subjects.map(certificateIdOf).filter(Boolean))], [subjects]);
  const [state, setState] = useState({ results: [], hasMore: false, loading: false, error: '' });
  const [more, setMore] = useState(null); // createdAt của mục cuối khi bấm "tải thêm"

  async function legacy(signal) {
    const settled = await Promise.allSettled(certificateIds.map(id => request(`/questions/result?certificateId=${encodeURIComponent(id)}`, { token: session.token, signal })));
    const failed = settled.filter(item => item.status === 'rejected');
    if (failed.some(item => item.reason?.status === 401)) throw failed.find(item => item.reason?.status === 401).reason;
    const results = settled.flatMap(item => item.status === 'fulfilled' && Array.isArray(unwrap(item.value)) ? unwrap(item.value) : []);
    const error = !failed.length ? '' : failed.length === settled.length ? failed[0].reason?.message || 'Không tải được lịch sử làm bài.' : `Không tải được lịch sử của ${failed.length} môn học.`;
    return { results, hasMore: false, error };
  }

  useEffect(() => {
    if (!session?.token) { setState({ results: [], hasMore: false, loading: false, error: '' }); return; }
    const controller = new AbortController();
    const append = !!more;
    setState(current => ({ ...current, loading: true, error: '' }));
    const query = `limit=${MINE_PAGE}${append ? `&before=${encodeURIComponent(more)}` : ''}`;
    request(`/questions/result/mine?${query}`, { token: session.token, signal: controller.signal })
      .then(data => { const page = unwrap(data); return { results: page?.items || [], hasMore: !!page?.hasMore, error: '' }; })
      .catch(e => {
        if (append || e.name === 'AbortError' || (e.status !== 400 && e.status !== 404)) throw e;
        return certificateIds.length ? legacy(controller.signal) : { results: [], hasMore: false, error: '' };
      })
      .then(page => {
        if (controller.signal.aborted) return;
        setState(current => ({ results: append ? [...current.results, ...page.results] : page.results, hasMore: page.hasMore, loading: false, error: page.error }));
      })
      .catch(e => {
        if (controller.signal.aborted || e.name === 'AbortError') return;
        setState(current => ({ ...current, loading: false, error: e.message }));
        if (e.status === 401) onUnauthorized();
      });
    return () => controller.abort();
  }, [session?.token, more, certificateIds.join('|'), ...deps]);

  useEffect(() => setMore(null), [session?.token, ...deps]);
  const loadMore = () => { const last = state.results[state.results.length - 1]; if (last?.createdAt) setMore(last.createdAt); };
  return { ...state, loadMore };
}

const PAGE_SIZES = { grid: 12, table: 20 };
const VIEW_KEY = 'scoreplus:history-view';

function readView() {
  try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid'; } catch { return 'grid'; }
}

function HintTag({ item }) {
  if (!item.hint) return null;
  return <span className={`hint-tag ${item.hint.kind}`} title="Sử dụng gợi ý từ gia sư AI trong lượt này"><Sparkles className="icon" aria-hidden="true" />{item.hint.label}</span>;
}

function StatusTag({ item }) {
  return <span className={`status-tag ${item.kind === 'draft' ? 'draft' : 'done'}`}>{item.kind === 'draft' ? 'Chưa nộp' : 'Đã nộp'}</span>;
}

/** Nút thao tác dùng chung cho thẻ và bảng. */
/** Nút thao tác dùng chung cho thẻ và bảng; `compact` (bảng) chỉ hiện icon, nhãn nằm ở aria-label + tooltip. */
function ItemActions({ item, busy, compact, onOpen, onResume, onDeleteDraft }) {
  const where = [item.subjectName, item.section].filter(Boolean).join(' · ');
  const iconOnly = label => compact ? { className: 'icon-btn', 'aria-label': `${label}: ${where}`, title: label } : { 'aria-label': `${label}: ${where}` };
  if (item.kind === 'result') return <Button variant="secondary" size="sm" full={!compact} {...iconOnly('Xem lại kết quả')} onClick={() => onOpen(item.id)}>{!compact && <span>Xem lại kết quả</span>}<ChevronRight className="icon" aria-hidden="true" /></Button>;
  return <div className="draft-actions">
    <Button size="sm" full={!compact} disabled={!!busy} loading={busy === `resume:${item.id}`} loadingText={compact ? undefined : 'Đang mở…'} icon={<Play className="icon" />} {...iconOnly('Làm tiếp')} onClick={() => onResume(item.draft)}>{compact ? null : 'Làm tiếp'}</Button>
    <Button variant="danger" size="sm" disabled={!!busy} loading={busy === `delete:${item.id}`} loadingText={compact ? undefined : 'Đang xoá…'} icon={<Trash2 className="icon" />} {...iconOnly('Xoá bài chưa nộp')} onClick={() => onDeleteDraft(item.draft)}>{compact ? null : 'Xoá'}</Button>
  </div>;
}

function HistoryCard({ item, ...actions }) {
  const result = item.kind === 'result';
  return <article className={`panel result-card ${item.kind} ${result ? `tone-${scoreTone(item.summary.percent)}` : ''}`}>
    <div className="tag-row"><StatusTag item={item} /><HintTag item={item} /></div>
    <div className="result-card-title">
      <h3 className="result-subject" title={item.subjectName}>{item.subjectName}</h3>
    </div>
    {result && <div className="result-score-feature">
      <ScoreRing percent={item.summary.percent} />
      <span className="result-correct-count"><strong>{item.summary.correct}<small>/{item.summary.total}</small></strong><span>câu đúng</span></span>
    </div>}
    <dl className="result-card-details">
      <div className="result-detail-row"><dt><BookOpen className="icon" aria-hidden="true" />Nội dung</dt><dd>{item.section || 'Không xác định'}</dd></div>
      {!result && <div className="result-detail-row"><dt><Target className="icon" aria-hidden="true" />Tiến độ</dt><dd><span><strong>{item.answered}/{item.total}</strong> câu đã làm</span></dd></div>}
      {!result && <progress value={item.answered} max={item.total || 1} aria-label="Tiến độ bài chưa nộp" />}
      {result && item.summary.duration !== null && <div className="result-detail-row"><dt><Timer className="icon" aria-hidden="true" />Thời lượng</dt><dd>{formatDuration(item.summary.duration)}</dd></div>}
      <div className="result-detail-row"><dt><CalendarClock className="icon" aria-hidden="true" />{result ? 'Nộp lúc' : 'Lưu lúc'}</dt><dd>{formatDateTime(item.date) || 'Không rõ thời gian'}</dd></div>
    </dl>
    <div className="result-card-footer">
      <ItemActions item={item} {...actions} />
    </div>
  </article>;
}

function HistoryTable({ items, ...actions }) {
  return <div className="panel history-table-wrap">
    <table className="history-table">
      <caption className="sr-only">Lịch sử làm bài</caption>
      <thead><tr><th scope="col">Trạng thái</th><th scope="col">Môn học</th><th scope="col">Chương / Nội dung</th><th scope="col">Kết quả</th><th scope="col">Thời gian</th><th scope="col">Thời lượng</th><th scope="col">Gợi ý AI</th><th scope="col" className="cell-actions-head">Thao tác</th></tr></thead>
      <tbody>{items.map(item => <tr key={`${item.kind}-${item.id}`} className={item.kind}>
        <td data-label="Trạng thái"><StatusTag item={item} /></td>
        <th scope="row" data-label="Môn học" className="cell-subject">{item.subjectName}</th>
        <td data-label="Chương / Nội dung" className="cell-section" title={item.section}><span className="clamp-2">{item.section || <span className="muted">Không xác định</span>}</span></td>
        <td data-label="Kết quả">{item.kind === 'result'
          ? <span className="cell-score"><strong className={`tone-${scoreTone(item.summary.percent)}`}>{item.summary.percent}%</strong> <span className="muted">{item.summary.correct}/{item.summary.total} câu đúng</span></span>
          : <span className="cell-score"><span className="muted">{item.answered}/{item.total} câu đã làm</span><progress value={item.answered} max={item.total || 1} aria-label="Tiến độ" /></span>}</td>
        <td data-label="Thời gian" className="cell-date">{item.kind === 'draft' && <span className="muted">Lưu lúc </span>}{formatDateTime(item.date) || '—'}</td>
        <td data-label="Thời lượng" className="muted">{item.kind === 'result' && item.summary.duration !== null ? formatDuration(item.summary.duration) : '—'}</td>
        <td data-label="Gợi ý AI">{item.hint ? <HintTag item={item} /> : <span className="muted">—</span>}</td>
        <td className="cell-actions"><ItemActions item={item} compact {...actions} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function Pagination({ page, pages, more, loading, onChange }) {
  const last = pages + (more ? 1 : 0);
  if (last <= 1) return null;
  return <nav className="pagination" aria-label="Phân trang lịch sử">
    <button type="button" className="page-btn" disabled={page <= 1} aria-label="Trang trước" onClick={() => onChange(page - 1)}><ChevronLeft className="icon" /></button>
    {pageWindow(Math.min(page, pages), pages).map((p, i) => p === '…'
      ? <span key={`gap-${i}`} className="page-gap" aria-hidden="true">…</span>
      : <button type="button" key={p} className={`page-btn ${p === page ? 'active' : ''}`} aria-current={p === page ? 'page' : undefined} aria-label={`Trang ${p}`} onClick={() => onChange(p)}>{p}</button>)}
    {more && <span className="page-gap" title="Còn bài cũ hơn trên máy chủ">…</span>}
    <button type="button" className="page-btn" disabled={(page >= pages && !more) || loading} aria-label="Trang sau" onClick={() => onChange(page + 1)}><ChevronRight className="icon" /></button>
  </nav>;
}

export function HistoryList({ session, subjects, loadingSubjects, drafts, busy, version, onOpen, onResume, onDeleteDraft, onUnauthorized }) {
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(1);
  const [view, setView] = useState('grid');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [status, setStatus] = useState('all');
  const top = useRef(null);
  const { results, hasMore, loading, error, loadMore } = useAllResults(session, subjects, onUnauthorized, [reload, version]);

  useEffect(() => setView(readView()), []);
  function changeView(next) {
    setView(next); setPage(1);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* chỉ là tuỳ chọn hiển thị */ }
  }

  const items = useMemo(() => {
    const byCertificate = new Map(subjects.map(s => [certificateIdOf(s), s]));
    return [
      ...results.map(result => {
        const summary = resultSummary(result);
        const subject = byCertificate.get(result.certificateId);
        return { kind: 'result', id: result._id, subjectId: subject?._id || '', subjectName: subject?.subject_name || 'Môn học không xác định', section: summary.section, date: summary.date, summary, hint: hintStatus(summary.hintsEnabled, summary.hintsUsed) };
      }),
      ...drafts.map(draft => ({
        kind: 'draft', id: draft.id, subjectId: draft.subjectId,
        subjectName: subjects.find(s => s._id === draft.subjectId)?.subject_name || draft.subjectName || 'Môn học không xác định',
        section: sectionOf(draft), date: draft.updatedAt, answered: draft.answered, total: draft.total, draft, hint: hintStatus(draft.hintsEnabled, draft.hintsUsed),
      })),
    ].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  }, [results, drafts, subjects]);

  const bySubject = items.filter(item => !subjectFilter || item.subjectId === subjectFilter);
  const counts = { all: bySubject.length, draft: bySubject.filter(i => i.kind === 'draft').length, result: bySubject.filter(i => i.kind === 'result').length };
  const shown = bySubject.filter(item => status === 'all' || item.kind === status);
  const stats = historyStats(results.filter(r => !subjectFilter || byId(subjects, subjectFilter, r)));
  const size = PAGE_SIZES[view];
  const pages = Math.max(1, Math.ceil(shown.length / size));
  // Bài đã nộp tải theo trang 100 từ server: còn nữa thì cho phép sang trang kế để tải tiếp.
  const more = hasMore && status !== 'draft';
  const pageItems = shown.slice((page - 1) * size, page * size);

  useEffect(() => setPage(1), [subjectFilter, status, reload, version]);
  useEffect(() => {
    if (page <= pages || loading) return;
    if (more) loadMore(); else setPage(pages);
  }, [page, pages, loading, more]);

  function changePage(next) {
    setPage(next);
    top.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  const actions = { busy, onOpen, onResume, onDeleteDraft };
  const from = shown.length ? (Math.min(page, pages) - 1) * size + 1 : 0;

  return <section className="history-section" aria-labelledby="history-title" ref={top}>
    <div className="history-heading">
      <div className="history-heading-intro">
        <span className="history-heading-icon" aria-hidden="true"><HistoryIcon className="icon" /></span>
        <div><h2 id="history-title">Lịch sử làm bài</h2><p className="muted">Bài đã nộp và bài đang làm dở được lưu trong tài khoản ScoreUp của bạn.</p></div>
      </div>
      <div className="history-heading-actions">
        <div className="view-switch" role="group" aria-label="Kiểu hiển thị">
          <button type="button" className={view === 'grid' ? 'active' : ''} aria-pressed={view === 'grid'} onClick={() => changeView('grid')}><LayoutGrid className="icon" /> Thẻ</button>
          <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => changeView('table')}><Rows3 className="icon" /> Bảng</button>
        </div>
      </div>
    </div>

    <div className="panel history-filters">
      <Dropdown label="Môn học" value={subjectFilter} disabled={loadingSubjects} options={[{ value: '', label: 'Tất cả môn học' }, ...subjects.map(s => ({ value: s._id, label: s.subject_name }))]} onChange={setSubjectFilter} />
      <div className="field"><span className="field-label">Trạng thái</span><div className="chips" role="group" aria-label="Lọc theo trạng thái">{STATUS_FILTERS.map(f => <button key={f.value} type="button" className={`chip ${status === f.value ? 'active' : ''}`} aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>{f.label} <span>{counts[f.value]}{hasMore && f.value !== 'draft' ? '+' : ''}</span></button>)}</div></div>
      {stats.count > 0 && <div className="history-stats">
        <div className="stat"><ListChecks className="icon" /><div><strong>{stats.count}{hasMore ? '+' : ''}</strong><span className="muted">lượt đã nộp</span></div></div>
        <div className="stat"><Target className="icon" /><div><strong>{stats.average}%</strong><span className="muted">điểm trung bình</span></div></div>
        <div className="stat"><Trophy className="icon" /><div><strong>{stats.best}%</strong><span className="muted">cao nhất</span></div></div>
      </div>}
    </div>

    {error && <div className="notice error" role="alert"><span>{error}</span><Button variant="text" onClick={() => setReload(v => v + 1)}>Thử lại</Button></div>}

    {!session ? <div className="panel empty compact"><p>Đăng nhập hoặc kết nối tài khoản để xem lịch sử làm bài.</p></div>
      : (loading || loadingSubjects) && !pageItems.length && (!items.length || page > pages) ? <div className={view === 'grid' ? 'history-grid' : 'panel history-table-wrap skeleton-table'} aria-busy="true" aria-label="Đang tải lịch sử">{view === 'grid' ? [0, 1, 2].map(i => <div key={i} className="panel result-card skeleton" />) : [0, 1, 2, 3].map(i => <div key={i} className="skeleton-row" />)}</div>
      : !shown.length ? <div className="panel empty compact"><p>{items.length ? 'Không có bài nào khớp bộ lọc.' : 'Chưa có bài luyện tập nào. Chọn môn học ở trên và bắt đầu lượt đầu tiên.'}</p></div>
      : <>
        {view === 'grid'
          ? <div className="history-grid">{pageItems.map(item => <HistoryCard key={`${item.kind}-${item.id}`} item={item} {...actions} />)}</div>
          : <HistoryTable items={pageItems} {...actions} />}
        <div className="pagination-bar">
          <span className="muted small" aria-live="polite">Hiển thị {from}–{from + pageItems.length - 1} / {shown.length}{more ? '+' : ''} bài</span>
          <Pagination page={page} pages={pages} more={more} loading={loading} onChange={changePage} />
        </div>
      </>}
  </section>;
}

function byId(subjects, subjectId, result) {
  return certificateIdOf(subjects.find(s => s._id === subjectId)) === result.certificateId;
}

export function ResultReview({ session, resultId, subjects, onBack, onRetry, onUnauthorized }) {
  const [filter, setFilter] = useState('all');
  const { data: result, loading, error } = useScoreup(resultId ? `/questions/result/${encodeURIComponent(resultId)}` : '', session?.token, onUnauthorized, []);
  const items = useMemo(() => reviewItems(result), [result]);
  const counts = useMemo(() => items.reduce((acc, item) => ({ ...acc, [item.status]: acc[item.status] + 1 }), { all: items.length, correct: 0, wrong: 0, skipped: 0 }), [items]);
  const shown = items.map((item, index) => ({ ...item, index })).filter(item => filter === 'all' || item.status === filter);
  const retryable = items.filter(item => item.status !== 'correct' && item.question);
  const summary = resultSummary(result);
  const subject = result && subjects.find(s => certificateIdOf(s) === result.certificateId);

  useEffect(() => { setFilter('all'); window.scrollTo?.({ top: 0 }); }, [resultId]);

  const back = <Button variant="text" icon={<ArrowLeft className="icon" />} onClick={onBack}>Về trang luyện tập</Button>;
  if (loading || (!result && !error && session)) return <><div className="review-nav">{back}</div><section className="panel empty" aria-busy="true"><h2>Đang tải kết quả…</h2></section></>;
  if (!result) return <><div className="review-nav">{back}</div><section className="panel empty"><div className="book-icon" aria-hidden="true"><CircleHelp className="icon-lg" /></div><h2>Không tìm thấy kết quả</h2><p>{error || 'Kết quả có thể đã bị xoá hoặc không thuộc tài khoản này.'}</p><Button onClick={onBack}>Về trang luyện tập</Button></section></>;

  return <>
    <div className="review-nav">{back}</div>
    <section className="panel review-summary" aria-labelledby="review-title">
      <ScoreRing percent={summary.percent} size="lg" />
      <div className="review-summary-copy">
        <span className="muted">{subject?.subject_name || 'Kết quả luyện tập'}</span>
        <h2 id="review-title">{summary.section || 'Kết quả luyện tập'}</h2>
        <div className="review-meta muted small">{formatDateTime(summary.date) && <span><CalendarClock className="icon" /> {formatDateTime(summary.date)}</span>}{summary.duration !== null && <span><Timer className="icon" /> {formatDuration(summary.duration)}</span>}</div>
        <div className="review-counts">
          <span className="count correct"><CircleCheck className="icon" /> {counts.correct} đúng</span>
          <span className="count wrong"><CircleX className="icon" /> {counts.wrong} sai</span>
          <span className="count skipped"><CircleDashed className="icon" /> {counts.skipped} bỏ trống</span>
        </div>
      </div>
    </section>

    <div className="practice-layout">
      <section className="question-list" aria-label="Xem lại câu hỏi">
        <div className="chips" role="group" aria-label="Lọc câu hỏi">{FILTERS.map(f => <button key={f.value} type="button" className={`chip ${filter === f.value ? 'active' : ''}`} aria-pressed={filter === f.value} disabled={!counts[f.value] && f.value !== 'all'} onClick={() => setFilter(f.value)}>{f.label} <span>{counts[f.value]}</span></button>)}</div>
        {!shown.length && <section className="panel empty compact"><p>Không có câu nào trong mục này.</p></section>}
        {shown.map(({ question: q, selected, correct, status, id, index }) => <article className={`panel question review-${status}`} key={id} id={`review-${index}`}>
          <div className="question-heading"><span className="question-number"><CircleHelp className="icon" /> Câu {index + 1}</span><span className={`status-tag ${status}`}>{STATUS_LABEL[status]}</span></div>
          {!q ? <p className="muted">Câu hỏi này không còn trong ngân hàng câu hỏi. {selected && `Bạn đã chọn ${selected}.`} {correct && `Đáp án đúng: ${correct}.`}</p> : <>
            {q.context && <Markdown>{q.context}</Markdown>}<Markdown>{q.question}</Markdown>
            {q.image && mediaUrl(q.image) && <img className="question-image" src={mediaUrl(q.image)} alt={`Hình minh họa câu ${index + 1}`} />}
            {q.audio && mediaUrl(q.audio) && <audio controls src={mediaUrl(q.audio)} />}
            {q.code && <pre><code>{q.code}</code></pre>}
            <ul className="options review-options" aria-label={`Đáp án câu ${index + 1}`}>{q.options.map(option => {
              const isCorrect = option.key === correct, isPicked = option.key === selected;
              return <li key={option.key} className={`option ${isCorrect ? 'correct' : ''} ${isPicked && !isCorrect ? 'wrong' : ''}`}><span className="option-letter">{option.key}</span><Markdown>{option.text}</Markdown>{(isPicked || isCorrect) && <span className="option-tag">{isPicked && isCorrect ? 'Bạn chọn · Đúng' : isPicked ? 'Bạn chọn' : 'Đáp án đúng'}</span>}</li>;
            })}</ul>
            <div className="explanation"><strong>Đáp án: {correct || 'Chưa có'}{status === 'skipped' && ' · Bạn chưa trả lời câu này'}</strong>{q.explanation && <Markdown>{q.explanation}</Markdown>}</div>
          </>}
        </article>)}
      </section>
      <aside className="panel progress-panel">
        <h2><ListChecks className="icon" /> Tổng quan</h2>
        <div className="progress-count"><strong>{summary.correct}<small> / {summary.total}</small></strong><span className="muted">câu đúng</span></div>
        <progress value={summary.correct} max={summary.total || 1} aria-label="Số câu đúng" />
        <div className="palette">{shown.map(item => <a key={item.id} href={`#review-${item.index}`} aria-label={`Đến câu ${item.index + 1}`} className={item.status}>{item.index + 1}</a>)}</div>
        <p className="muted">Xanh: đúng · Đỏ: sai · Viền đứt: bỏ trống.</p>
        <div className="review-actions">
          {retryable.length > 0 && <Button full icon={<RotateCcw className="icon" />} onClick={() => onRetry(result, retryable.map(item => item.question))}>Luyện lại {retryable.length} câu chưa đúng</Button>}
          <Button variant="secondary" full icon={<ArrowLeft className="icon" />} onClick={onBack}>Về trang luyện tập</Button>
        </div>
      </aside>
    </div>
  </>;
}
