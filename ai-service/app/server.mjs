import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ValidationError, buildMessages, parseHintRequest } from './hint.mjs';
import { checkHint } from './guard.mjs';
import { createHintLogger } from './log.mjs';
import { UpstreamError, chatCompletion } from './llm.mjs';
import { DEFAULT_POLICY, decideHint } from '../models/policy.mjs';

const MAX_BODY = 64 * 1024;
const INSUFFICIENT = 'Câu hỏi này chưa có lời giải đã được xác minh nên gia sư chưa đủ căn cứ để gợi ý. Em hãy xem lại nội dung chương liên quan hoặc hỏi giảng viên.';
const BLOCKED = 'Gia sư chưa tạo được gợi ý đạt yêu cầu kiểm tra. Em hãy thử lại, hoặc xem lại khái niệm chính của chương này.';
const flag = (value, fallback) => value === undefined || value === '' ? fallback : ['1', 'true', 'yes'].includes(String(value).toLowerCase());

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8090,
    provider: env.LLM_PROVIDER || 'vllm',
    llmUrl: env.LLM_BASE_URL || 'http://101.96.66.232:8037/vllm',
    llmKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'qwen3.5-35b-a3b-int4',
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 60000,
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(origin => origin.trim()).filter(Boolean),
    rateLimit: Number(env.RATE_LIMIT_PER_MINUTE) || 20,
    logDir: env.HINT_LOG_DIR === undefined ? fileURLToPath(new URL('../logs', import.meta.url)) : env.HINT_LOG_DIR,
    policy: {
      level2Attempts: Number(env.HINT_LEVEL2_ATTEMPTS) || DEFAULT_POLICY.level2Attempts,
      level3Attempts: Number(env.HINT_LEVEL3_ATTEMPTS) || DEFAULT_POLICY.level3Attempts,
      requireSolution: flag(env.HINT_REQUIRE_SOLUTION, DEFAULT_POLICY.requireSolution),
      allowAnswerAtLevel3: flag(env.HINT_ALLOW_ANSWER_AT_LEVEL3, DEFAULT_POLICY.allowAnswerAtLevel3),
    },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ValidationError('Dữ liệu yêu cầu quá lớn.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Dữ liệu yêu cầu không phải JSON hợp lệ.'); }
}

// Giới hạn đơn giản theo IP trong bộ nhớ để một client không chiếm hết GPU.
function createRateLimiter(limit, windowMs = 60000) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(time => now - time < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

// Chọn cấp → gọi LLM → kiểm tra đầu ra; vi phạm thì yêu cầu viết lại một lần, vẫn vi phạm thì không trả nội dung đó.
export async function generateHint(input, config, fetchImpl = fetch) {
  const decision = decideHint({ ...input, hasSolution: !!input.explanation }, config.policy);
  if (decision.state === 'missing_data') return { status: 'insufficient', content: INSUFFICIENT, decision, guard: null, retried: false };
  const chat = messages => chatCompletion({
    provider: config.provider, baseUrl: config.llmUrl, apiKey: config.llmKey, model: config.model,
    messages, temperature: 0.2, maxTokens: 400, timeoutMs: config.timeoutMs, fetchImpl,
  });
  const messages = buildMessages(input, decision);
  let content = await chat(messages);
  let guard = checkHint(content, input, decision);
  let retried = false;
  if (!guard.ok) {
    retried = true;
    content = await chat([...messages, { role: 'assistant', content }, { role: 'user', content: `Bản trả lời trên vi phạm quy tắc: ${guard.reasons.join('; ')}. Hãy viết lại gợi ý mức "${decision.label}", tuân thủ đầy đủ các quy tắc.` }]);
    guard = checkHint(content, input, decision);
  }
  return guard.ok
    ? { status: 'ok', content, decision, guard, retried }
    : { status: 'blocked', content: BLOCKED, rejected: content, decision, guard, retried };
}

export function createApp(config = loadConfig(), { fetchImpl = fetch } = {}) {
  const allow = createRateLimiter(config.rateLimit);
  const log = createHintLogger(config.logDir);
  return async (req, res) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && pathname === '/health') { send(res, 200, { status: 'ok', model: config.model }); return; }
    if (pathname !== '/v1/hint') { send(res, 404, { message: 'Không tìm thấy endpoint.' }); return; }
    if (req.method !== 'POST') { send(res, 405, { message: 'Chỉ hỗ trợ POST.' }); return; }
    if (origin && !config.allowedOrigins.includes(origin)) { send(res, 403, { message: 'Origin không được phép.' }); return; }
    const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    if (!allow(clientIp)) { send(res, 429, { message: 'Bạn yêu cầu gợi ý quá nhanh. Hãy thử lại sau ít phút.' }); return; }
    try {
      const input = parseHintRequest(await readJson(req));
      const started = Date.now();
      const result = await generateHint(input, config, fetchImpl);
      const { state, level, label } = result.decision;
      await log({
        subject_id: input.subjectId, chapter: input.chapter, question_id: input.questionId,
        state, level, attempts: input.attempts, prior_wrong: input.priorWrong, hint_count: input.hintCount, revealed: input.revealed, selected: input.selected,
        status: result.status, retried: result.retried, guard_reasons: result.guard?.reasons || [],
        latency_ms: Date.now() - started, model: config.model, content: result.content, ...(result.rejected ? { rejected: result.rejected } : {}),
      });
      send(res, 200, { status: result.status, content: result.content, state, level, label, model: config.model });
    } catch (error) {
      if (error instanceof ValidationError) send(res, 400, { message: error.message });
      else if (error instanceof UpstreamError) send(res, error.status, { message: error.message });
      else { console.error('[hint]', error); send(res, 500, { message: 'Lỗi nội bộ AI service.' }); }
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch { /* .env là tùy chọn */ }
  const config = loadConfig();
  if (!config.llmKey) console.warn('[ai-service] Chưa đặt LLM_API_KEY; Kong sẽ từ chối request.');
  createServer(createApp(config)).listen(config.port, () => {
    console.log(`[ai-service] http://localhost:${config.port} → ${config.llmUrl} (${config.provider}: ${config.model})`);
  });
}
