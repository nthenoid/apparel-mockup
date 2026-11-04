// All settings come from environment variables (set them in the Unraid container template).
const env = process.env;
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(env.PORT, 8080),
  dataDir: env.DATA_DIR || '/data',
  ss: {
    account: (env.SS_ACCOUNT || '').trim(),
    apiKey: (env.SS_API_KEY || '').trim(),
    apiBase: (env.SS_API_BASE || 'https://api.ssactivewear.com/v2').replace(/\/+$/, ''),
    imageBase: (env.SS_IMAGE_BASE || 'https://www.ssactivewear.com').replace(/\/+$/, ''),
    // Comma-separated list: "Gildan 5000, BELLA+CANVAS 3001" or S&S style IDs.
    styles: (env.SS_STYLES || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  syncHour: Math.min(23, Math.max(0, num(env.SYNC_HOUR, 2))),
  access: {
    teamDomain: (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    aud: (env.ACCESS_AUD || '').trim(),
    disabled: bool(env.DISABLE_ACCESS_CHECK),
  },
  maxPrintWidthIn: num(env.MAX_PRINT_WIDTH_IN, 13),
  maxPrintHeightIn: num(env.MAX_PRINT_HEIGHT_IN, 16),
  maxUploadMb: num(env.MAX_UPLOAD_MB, 25),
};

export function ssEnabled() {
  return Boolean(config.ss.account && config.ss.apiKey && config.ss.styles.length);
}

// Fail closed: the server refuses to start without Cloudflare Access settings
// unless the check is explicitly turned off for local testing.
export function assertConfig() {
  const a = config.access;
  if (a.disabled) return;
  if (!a.teamDomain || !a.aud) {
    throw new Error(
      'Cloudflare Access is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD, ' +
        'or set DISABLE_ACCESS_CHECK=true for local testing only.'
    );
  }
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(a.teamDomain)) {
    throw new Error('ACCESS_TEAM_DOMAIN should look like yourteam.cloudflareaccess.com');
  }
}
