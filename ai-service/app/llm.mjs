export class UpstreamError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Hai giao thức qua Kong (xác thực bằng header x-ollama-seckey), đều không stream vì đầu ra phải được kiểm tra trọn vẹn:
// - vllm: OpenAI-compatible POST /v1/chat/completions
// - ollama: POST /api/chat
const PROTOCOLS = {
  vllm: {
    path: '/v1/chat/completions',
    body: ({ model, messages, temperature, maxTokens }) => ({
      model, messages, stream: false, temperature, max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false }, // tắt chế độ suy luận của Qwen3.x để trả lời nhanh, gọn
    }),
    content: data => data?.choices?.[0]?.message?.content,
  },
  ollama: {
    path: '/api/chat',
    body: ({ model, messages, temperature, maxTokens }) => ({ model, messages, stream: false, options: { temperature, num_predict: maxTokens } }),
    content: data => data?.message?.content,
  },
};

export async function chatCompletion({ provider = 'vllm', baseUrl, apiKey, model, messages, temperature = 0.4, maxTokens = 400, timeoutMs = 60000, fetchImpl = fetch }) {
  const protocol = PROTOCOLS[provider];
  if (!protocol) throw new UpstreamError(`LLM provider không hỗ trợ: ${provider}.`, 500);
  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${protocol.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-ollama-seckey': apiKey } : {}) },
      body: JSON.stringify(protocol.body({ model, messages, temperature, maxTokens })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new UpstreamError('Mô hình AI phản hồi quá lâu. Hãy thử lại.', 504);
    throw new UpstreamError('Không kết nối được máy chủ mô hình AI.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // Không trả nguyên lỗi upstream (có thể chứa thông tin hạ tầng) cho client; ghi log ở server.
    console.error(`[llm:${provider}] HTTP ${response.status}:`, JSON.stringify(data?.error || data?.message || ''));
    if (response.status === 401 || response.status === 403) throw new UpstreamError('AI service chưa được cấp quyền gọi mô hình.');
    if (response.status === 404) throw new UpstreamError('Mô hình AI chưa sẵn sàng trên máy chủ.');
    if (response.status === 429) throw new UpstreamError('Mô hình AI đang quá tải. Hãy thử lại sau.', 503);
    throw new UpstreamError(`Máy chủ mô hình AI trả về lỗi (${response.status}).`);
  }
  // Bỏ phần suy luận <think>…</think> nếu model vẫn trả về để chỉ hiển thị câu trả lời.
  const content = String(protocol.content(data) || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!content) throw new UpstreamError('Mô hình AI chưa tạo được nội dung. Hãy thử lại.');
  return content;
}
