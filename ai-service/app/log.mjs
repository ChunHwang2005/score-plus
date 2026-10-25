import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Log tương tác dạng JSONL theo ngày cho giai đoạn 2 (phân tích gợi ý kém). Không ghi thông tin tài khoản.
export function createHintLogger(dir) {
  if (!dir) return async () => {};
  let ready;
  return async record => {
    try {
      ready ||= mkdir(dir, { recursive: true });
      await ready;
      const time = new Date().toISOString();
      await appendFile(join(dir, `hints-${time.slice(0, 10)}.jsonl`), `${JSON.stringify({ time, ...record })}\n`);
    } catch (error) {
      console.error('[hint-log]', error.message);
    }
  };
}
