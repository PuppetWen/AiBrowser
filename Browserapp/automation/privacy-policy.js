'use strict';

// sanitizeProfile makes strict=true the default. Low-level callers can pass an
// explicitly normalized policy; legacy unit fixtures do not opt in by accident.
function isStrictPrivacy(profile) { return profile?.privacy?.strict === true; }

function protectionError(message, cause) {
  const error = new Error(message);
  error.code = 'PRIVACY_PROTECTION_FAILED';
  error.documentStartOk = false;
  if (cause) error.cause = cause;
  return error;
}

function validTimezone(value) {
  if (!value || typeof value !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch (_) { return false; }
}

function assertStrictProfile(profile) {
  if (!isStrictPrivacy(profile)) return;
  if (profile.kernel === 'firefox-reverse') throw protectionError('严格隐私模式暂不支持 Firefox 的指纹保护，请选择 Chromium。');
  if (profile.networkMode !== 'proxy' && profile.networkMode !== 'system') throw protectionError('严格隐私模式禁止直连或空代理，请配置固定代理或可解析的系统代理。');
  if (profile.advanced?.restoreSession || profile.advanced?.tabMode === 'restore') throw protectionError('严格隐私模式不允许内核提前恢复会话，请改用固定启动页面；原会话数据会保留。');
  if (profile.privacy?.fingerprintMode === 'native') throw protectionError('严格隐私模式需要自定义指纹，不能使用本机原生指纹。');
  if (profile.proxyMeta?.apiExtractUrl || profile.proxyMeta?.refreshUrl) throw protectionError('严格隐私模式禁止宿主直连提取或刷新代理，请先配置固定代理并清空提取/刷新 URL。');
  if (profile.privacy?.timezoneMode === 'custom' && !validTimezone(profile.privacy.timezone)) throw protectionError('自定义时区无效，请填写有效的 IANA 时区。');
}

function assertExitIdentity(profile, network) {
  if (!isStrictPrivacy(profile)) return;
  if (!network?.ip) throw protectionError('代理出口未验证，已阻止启动。');
  const privacy = profile.privacy || {};
  const timezone = privacy.timezoneMode === 'custom' ? privacy.timezone : network.timezone;
  if (!validTimezone(timezone)) throw protectionError('未获得有效的代理出口时区，已阻止启动；可以手动配置出口时区。');
  if (privacy.languageMode === 'ip' && !/^[A-Z]{2}$/i.test(network.countryCode || '')) throw protectionError('未获得代理出口国家，无法对齐语言，已阻止启动。');
  if (privacy.geoMode === 'ip' || privacy.geoMode === 'custom') {
    const latitude = privacy.geoMode === 'custom' ? privacy.latitude : network.latitude;
    const longitude = privacy.geoMode === 'custom' ? privacy.longitude : network.longitude;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw protectionError('定位坐标缺失或无效，已阻止启动；可以关闭网页定位。');
    }
  }
}

function strictChromeArgs() {
  return [
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--disable-quic', '--dns-prefetch-disable', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-client-side-phishing-detection',
    '--disable-domain-reliability', '--no-pings', '--metrics-recording-only',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--enforce-webrtc-ip-permission-check',
  ];
}

module.exports = { isStrictPrivacy, protectionError, validTimezone, assertStrictProfile, assertExitIdentity, strictChromeArgs };
