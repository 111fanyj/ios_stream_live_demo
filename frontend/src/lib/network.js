export function normalizeBaseUrl(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) {
    return window.location.origin;
  }

  return rawValue.replace(/\/$/, '');
}

export function buildHttpUrl(baseUrl, pathname) {
  const url = new URL(normalizeBaseUrl(baseUrl), window.location.origin);
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  }
  if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  }

  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

export function buildSignalUrl(baseUrl, roomId, token) {
  return buildClientSocketUrl(baseUrl, { clientType: 'viewer', roomId, token });
}

export function buildClientSocketUrl(baseUrl, { clientType, roomId, token } = {}) {
  const url = new URL(normalizeBaseUrl(baseUrl), window.location.origin);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  url.searchParams.set('type', clientType || 'viewer');
  url.searchParams.set('roomId', roomId || 'demo-room');
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}