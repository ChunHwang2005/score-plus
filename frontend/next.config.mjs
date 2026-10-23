import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const portalBasePath = (process.env.PORTAL_BASE_PATH || '').replace(/\/+$/, '');
export default (phase) => ({
  // Local development opens at the URL printed by Next; exports retain Portal's mount path.
  ...(phase === PHASE_DEVELOPMENT_SERVER
    ? {
        async redirects() {
          return [{ source: `${portalBasePath}/embed/scoreplus`, destination: '/', permanent: false }];
        },
      }
    : { output: 'export', basePath: `${portalBasePath}/embed/scoreplus` }),
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
});
