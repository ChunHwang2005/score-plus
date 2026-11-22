import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.alias !== 'scoreplus' || manifest.hasFrontendOnly || !manifest.hasBackend) throw new Error('Invalid Portal manifest');
if (!fs.existsSync(path.join(root, 'out/index.html'))) throw new Error('Run npm run build first');
const routes = JSON.parse(fs.readFileSync(path.join(root, '.next/routes-manifest.json'), 'utf8'));
const builtBasePath = routes.basePath;
const target = process.env.SCOREPLUS_PACK_TARGET;
const expectedBasePath = target === 'neu' ? '/apps/embed/scoreplus'
  : target === 'local' ? '/embed/scoreplus'
    : process.env.PORTAL_BASE_PATH === undefined ? builtBasePath
      : `${process.env.PORTAL_BASE_PATH.replace(/\/+$/, '')}/embed/scoreplus`;
if (builtBasePath !== expectedBasePath) {
  throw new Error(`Build basePath ${builtBasePath} does not match package basePath ${expectedBasePath}. Rebuild with npm run pack or npm run pack:local.`);
}
const html = fs.readFileSync(path.join(root, 'out/index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="([^\"]+)"/g)]
  .map((match) => match[1]).filter((url) => url.includes('/_next/'));
if (!assets.length) throw new Error('Export is missing Next.js assets');
for (const asset of assets) {
  if (!asset.startsWith(`${expectedBasePath}/`)) throw new Error(`Incorrect asset base path: ${asset}`);
  const file = asset.slice(expectedBasePath.length + 1).split('?')[0];
  if (!fs.existsSync(path.join(root, 'out', file))) throw new Error(`Missing exported asset: ${asset}`);
}
// Gói bundled của Portal: ai-service chạy trong process backend Portal tại /api/apps/scoreplus.
const ai = path.join(root, '../ai-service');
const embed = fs.readFileSync(path.join(ai, 'portal/embed.js'), 'utf8');
// Portal từ chối gói có dist/embed.js gọi listen().
if (/\.\s*listen\s*\(/.test(embed)) throw new Error('ai-service/portal/embed.js must not call listen()');
const aiPackage = JSON.parse(fs.readFileSync(path.join(ai, 'package.json'), 'utf8'));
// Portal chạy npm install --production; ai-service chỉ dùng thư viện chuẩn của Node.
const portalPackage = {
  name: aiPackage.name, version: aiPackage.version, private: true, type: 'module', engines: aiPackage.engines,
  dependencies: aiPackage.dependencies || {}, scripts: { start: 'node dist/server.js' },
};
const zip = new AdmZip();
zip.addLocalFile(path.join(root, 'manifest.json'));
zip.addLocalFolder(path.join(root, 'out'), 'public');
zip.addFile('package.json', Buffer.from(`${JSON.stringify(portalPackage, null, 2)}\n`));
zip.addFile('dist/embed.js', Buffer.from(embed));
zip.addLocalFile(path.join(ai, 'portal/server.js'), 'dist');
zip.addLocalFolder(path.join(ai, 'app'), 'app');
zip.addLocalFolder(path.join(ai, 'models'), 'models');
// Khóa LLM: đặt ở ai-service/.env.portal (đã gitignore) để đưa vào gói, hoặc đặt SCOREPLUS_LLM_API_KEY trên server Portal.
const portalEnv = path.join(ai, '.env.portal');
if (fs.existsSync(portalEnv)) {
  zip.addFile('.env', fs.readFileSync(portalEnv));
  console.warn('Included ai-service/.env.portal as .env — the package now contains secrets; do not share it.');
} else {
  console.warn('No ai-service/.env.portal: set SCOREPLUS_LLM_API_KEY on the Portal server, otherwise tutor hints fail.');
}
const buffer = zip.toBuffer();
if (buffer.length > 50 * 1024 * 1024) throw new Error('Portal limits packages to 50 MB');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// Local packages never overwrite the default production upload.
const filename = target === 'local' ? 'scoreplus-local.zip' : 'scoreplus.zip';
fs.writeFileSync(path.join(root, 'dist', filename), buffer);
if (target === 'neu') fs.writeFileSync(path.join(root, 'dist/scoreplus-neu.zip'), buffer);
console.log(`Created dist/${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB), basePath=${builtBasePath}`);
