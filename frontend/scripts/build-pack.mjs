import { spawnSync } from 'node:child_process';

const target = process.argv[2];
if (!['neu', 'local'].includes(target)) throw new Error('Expected pack target: neu or local');

// Explicit process env wins over .env.local when Next loads build settings.
const env = {
  ...process.env,
  PORTAL_BASE_PATH: target === 'neu' ? '/apps' : '',
  SCOREPLUS_PACK_TARGET: target,
  ...(target === 'neu' ? {
    NEXT_PUBLIC_SCOREUP_API_URL: 'https://fit.neu.edu.vn/scoreup/v1/api',
    NEXT_PUBLIC_SCOREUP_MEDIA_URL: 'https://fit.neu.edu.vn/scoreup/media/',
    // URL HTTPS của ai-service production; để trống = dùng Central LLM của Portal (không nhúng localhost từ .env.local).
    NEXT_PUBLIC_SCOREPLUS_AI_URL: process.env.SCOREPLUS_NEU_AI_URL || '',
  } : {}),
};

for (const args of [['node_modules/next/dist/bin/next', 'build', '--webpack'], ['scripts/pack.mjs']]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
