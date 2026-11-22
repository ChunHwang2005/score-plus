// Điểm vào khi nhúng trong AI-Portal (đóng gói thành dist/embed.js). Portal gọi createEmbedRouter() một lần,
// mount tại /api/apps/scoreplus và tự chặn mọi lệnh mở cổng: file này chỉ trả handler, không tự chạy server.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createApp, loadConfig } from '../app/server.mjs';

const PREFIX = 'SCOREPLUS_';

// App nhúng chạy chung process với Portal nên không đọc biến chung (PORT, LLM_API_KEY...) của Portal.
// Nguồn cấu hình: .env ở gốc gói (Portal không phục vụ file ngoài public/), rồi biến SCOREPLUS_<TÊN> của Portal ghi đè.
export function embedEnv(env = process.env, envFile = new URL('../.env', import.meta.url)) {
  let file = {};
  try { file = parseEnv(readFileSync(envFile, 'utf8')); } catch { /* .env là tùy chọn */ }
  const prefixed = Object.fromEntries(Object.keys(env).filter(key => key.startsWith(PREFIX)).map(key => [key.slice(PREFIX.length), env[key]]));
  return {
    // Portal xoá thư mục app mỗi lần cài lại: log mặc định ở data/app-logs/scoreplus (cạnh data/apps/scoreplus).
    HINT_LOG_DIR: fileURLToPath(new URL('../../../app-logs/scoreplus', import.meta.url)),
    ...file,
    ...prefixed,
  };
}

export function createEmbedRouter() {
  const config = { ...loadConfig(embedEnv()), embedded: true };
  if (!config.llmKey) console.warn('[scoreplus] Chưa đặt LLM_API_KEY (.env trong gói hoặc SCOREPLUS_LLM_API_KEY); Kong sẽ từ chối request.');
  const handle = createApp(config);
  return (req, res, next) => { handle(req, res).catch(next); };
}

export default createEmbedRouter;
