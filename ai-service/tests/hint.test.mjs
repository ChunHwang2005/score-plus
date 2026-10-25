import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildMessages, parseHintRequest } from '../app/hint.mjs';
import { checkHint } from '../app/guard.mjs';
import { createApp, loadConfig } from '../app/server.mjs';
import { DEFAULT_POLICY, decideHint } from '../models/policy.mjs';

// Ví dụ trong đề cương mục 5 (Kinh tế vi mô, hàng bổ sung).
const question = {
  subject_id: 'kt-vi-mo', subject_name: 'Kinh tế vi mô', chapter: 'Chương 2', question_id: 'q1',
  question: 'Khi giá cà phê tăng, cầu về đường (hàng bổ sung) thay đổi thế nào?',
  options: [{ key: 'A', text: 'Cầu về đường tăng' }, { key: 'B', text: 'Cầu về đường giảm' }, { key: 'C', text: 'Không đổi' }],
  selected: 'A', correct: 'B', revealed: true, attempts: 1, hint_count: 1,
  explanation: 'Cà phê và đường là hàng bổ sung: giá cà phê tăng làm lượng cà phê mua giảm nên cầu về đường giảm.',
};
const decide = overrides => decideHint({ ...parseHintRequest({ ...question, ...overrides }), hasSolution: true });

async function withServer(fetchImpl, run, env = {}) {
  const config = loadConfig({ LLM_API_KEY: 'secret', CORS_ALLOWED_ORIGINS: 'http://localhost:3000', HINT_LOG_DIR: '', ...env });
  const server = createServer(createApp(config, { fetchImpl })).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const post = (base, body, headers = {}) => fetch(`${base}/v1/hint`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const reply = content => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });

test('policy follows the state table', () => {
  assert.deepEqual(decide({ selected: '', hint_count: 1 }), { state: 'no_answer', level: 1, label: 'Gợi nhớ', revealAnswer: false });
  assert.equal(decide({ selected: '', hint_count: 3 }).level, 3);
  assert.deepEqual(decide({}), { state: 'wrong_first', level: 1, label: 'Gợi nhớ', revealAnswer: false });
  assert.equal(decide({ attempts: 2 }).level, 2);
  assert.equal(decide({ attempts: 3 }).level, 3);
  assert.equal(decide({ attempts: 3 }).revealAnswer, false);
  assert.equal(decide({ attempts: 3, answer_shown: true }).revealAnswer, true); // đáp án đã hiện trên giao diện
  assert.equal(decide({ hint_count: 2 }).level, 2); // xin thêm gợi ý tăng một cấp
  assert.equal(decide({ attempts: 2, hint_count: 1 }).level, 2); // sai 2 lần: cấp 2 (frontend đếm lại hint_count sau mỗi lần chọn)
  assert.equal(decide({ attempts: 2, hint_count: 2 }).level, 3); // xin thêm khi chưa chọn lại
  // Lịch sử: đã sai 1 lần ở lượt trước, ôn lại vẫn sai → sai lần 2 → cấp 2
  assert.deepEqual(decide({ attempts: 1, prior_wrong: 1 }), { state: 'wrong_repeated', level: 2, label: 'Định hướng', revealAnswer: false });
  assert.equal(decide({ attempts: 1, prior_wrong: 2 }).level, 3);
  assert.equal(decide({ selected: '', prior_wrong: 1 }).level, 1); // chưa chọn ở lượt ôn lại: sai trước 1 lần → cấp 1
  assert.equal(decide({ selected: '', prior_wrong: 2 }).level, 2);
  assert.equal(decide({ revealed: false, prior_wrong: 5 }).level, 2); // chưa công bố: vẫn tối đa cấp 2
  assert.equal(decide({ attempts: 1, prior_wrong: 74 }).level, 3);
  assert.equal(decide({ attempts: 3, hint_count: 4 }).level, 3); // tối đa cấp 3
  assert.equal(decide({ selected: 'B' }).state, 'correct');
  assert.deepEqual(decide({ revealed: false, hint_count: 5 }), { state: 'answered_hidden', level: 2, label: 'Định hướng', revealAnswer: false });
  assert.equal(decideHint({ ...parseHintRequest(question), hasSolution: false }).state, 'missing_data');
  assert.equal(decideHint({ ...parseHintRequest(question), hasSolution: false }, { ...DEFAULT_POLICY, requireSolution: false }).state, 'wrong_first');
});

test('validates input and builds level-specific prompt without allowing answer reveal', () => {
  const input = parseHintRequest(question);
  const [system, user] = buildMessages(input, decide({}));
  assert.match(system.content, /CẤP 1 – GỢI NHỚ/);
  assert.match(system.content, /KHÔNG được nêu chữ cái/);
  assert.match(user.content, /Học phần: Kinh tế vi mô – Chương 2/);
  assert.match(user.content, /KHÔNG tiết lộ\): B/);
  assert.doesNotMatch(buildMessages(input, decide({ selected: 'B' }))[0].content, /KHÔNG được nêu/);
  assert.throws(() => parseHintRequest({ ...question, options: [{ key: 'A', text: '1' }] }), /2 đến/);
  assert.throws(() => parseHintRequest({ ...question, selected: 'Z' }), /không có trong danh sách/);
  assert.throws(() => parseHintRequest({ ...question, attempts: -1 }), /attempts/);
  assert.equal(parseHintRequest({ ...question, explanation: 'Câu hỏi chưa có lời giải thích' }).explanation, ''); // placeholder ScoreUp
});

test('guard catches answer leaks and foreign numbers', () => {
  const input = parseHintRequest(question);
  const level1 = decide({});
  assert.equal(checkHint('Hãy nhớ lại: hàng bổ sung là gì?', input, level1).ok, true);
  assert.equal(checkHint('Đây là lựa chọn bổ sung. Hãy chọn bối cảnh phù hợp.', input, level1).ok, true); // "bổ" không phải phương án B
  for (const leak of ['Đáp án đúng là B.', 'Em nên chọn B nhé.', '**B** là đáp án đúng.', 'Phương án B đúng vì...']) {
    assert.equal(checkHint(leak, input, level1).ok, false, leak);
  }
  assert.equal(checkHint('Đáp án đúng là B.', input, decide({ selected: 'B' })).ok, true); // củng cố khi đã đúng
  assert.match(checkHint('Độ co giãn bằng 2,5 nên cầu giảm 25%.', input, level1).reasons.join(), /số liệu ngoài căn cứ/);
});

test('calls vLLM chat completions with seckey and returns hint with level', async () => {
  let call;
  const fetchImpl = async (url, init) => { call = { url, init, body: JSON.parse(init.body) }; return reply('<think>x</think>Hàng bổ sung là gì?'); };
  await withServer(fetchImpl, async base => {
    const response = await post(base, question, { Origin: 'http://localhost:3000' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.deepEqual(await response.json(), { status: 'ok', content: 'Hàng bổ sung là gì?', state: 'wrong_first', level: 1, label: 'Gợi nhớ', model: 'qwen3.5-35b-a3b-int4' });
  });
  assert.equal(call.url, 'http://101.96.66.232:8037/vllm/v1/chat/completions');
  assert.equal(call.init.headers['x-ollama-seckey'], 'secret');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.model, 'qwen3.5-35b-a3b-int4');
  assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });
});

test('rewrites once on guard failure, then blocks', async () => {
  const replies = ['Đáp án đúng là B.', 'Hãy nghĩ về hàng bổ sung.'];
  let calls = 0;
  await withServer(async () => reply(replies[calls++]), async base => {
    const data = await (await post(base, question)).json();
    assert.equal(data.status, 'ok');
    assert.equal(data.content, 'Hãy nghĩ về hàng bổ sung.');
  });
  assert.equal(calls, 2);
  await withServer(async () => reply('Chọn B.'), async base => {
    const data = await (await post(base, question)).json();
    assert.equal(data.status, 'blocked');
    assert.doesNotMatch(data.content, /Chọn B/);
  });
});

test('missing solution answers insufficient without calling the model', async () => {
  let called = false;
  await withServer(async () => { called = true; return reply('x'); }, async base => {
    const data = await (await post(base, { ...question, explanation: '' })).json();
    assert.equal(data.status, 'insufficient');
    assert.equal(data.level, 0);
  });
  assert.equal(called, false);
});

test('rejects bad input, foreign origins, maps upstream errors and rate limits', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "model 'x' not found" }), { status: 404 });
  await withServer(fetchImpl, async base => {
    assert.equal((await post(base, { question: 'x' })).status, 400);
    assert.equal((await post(base, question, { Origin: 'https://evil.example' })).status, 403);
    const upstream = await post(base, question);
    assert.equal(upstream.status, 502);
    assert.match((await upstream.json()).message, /chưa sẵn sàng/);
  });
  await withServer(async () => reply('ok'), async base => {
    assert.equal((await post(base, question)).status, 200);
    assert.equal((await post(base, question)).status, 429);
  }, { RATE_LIMIT_PER_MINUTE: '1' });
});

test('ollama provider uses /api/chat protocol', async () => {
  let call;
  const fetchImpl = async (url, init) => { call = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ message: { content: 'Gợi ý.' } }), { status: 200 }); };
  await withServer(fetchImpl, async base => {
    assert.equal((await (await post(base, question)).json()).content, 'Gợi ý.');
  }, { LLM_PROVIDER: 'ollama', LLM_BASE_URL: 'http://host/ollama', LLM_MODEL: 'qwen2.5:7b' });
  assert.equal(call.url, 'http://host/ollama/api/chat');
  assert.equal(call.body.options.num_predict, 400);
});
