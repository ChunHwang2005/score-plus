export const API_URL = (process.env.NEXT_PUBLIC_SCOREUP_API_URL || 'http://localhost:3006/v1/api').replace(/\/+$/, '');
const MEDIA_URL = process.env.NEXT_PUBLIC_SCOREUP_MEDIA_URL || 'http://localhost:3006/media/';
export function mediaUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, MEDIA_URL.replace(/\/?$/, '/'));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
export async function request(path, { token, body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal || AbortSignal.timeout(30000),
      credentials: 'omit',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Không kết nối được ScoreUp. Vui lòng kiểm tra kết nối và thử lại.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status === 'ERROR') {
    const error = new Error(response.status === 401 ? 'Phiên kết nối ScoreUp đã hết hạn. Hãy kết nối lại từ AI-Portal.' : data?.message || `Yêu cầu thất bại (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (data === null) throw new Error('Máy chủ trả về dữ liệu không hợp lệ.');
  return data;
}
