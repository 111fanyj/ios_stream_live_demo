import { buildHttpUrl } from './network';

async function readJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

export function fetchHealth(baseUrl) {
  return readJson(buildHttpUrl(baseUrl, '/health'));
}

export function fetchAutomationPackages(baseUrl) {
  return readJson(buildHttpUrl(baseUrl, '/api/automation/packages'));
}

export function fetchPackageDetail(baseUrl, packageId, revision) {
  return readJson(buildHttpUrl(baseUrl, `/api/automation/packages/${encodeURIComponent(packageId)}/revisions/${revision}`));
}

export function saveAutomationPackage(baseUrl, automation, images) {
  return readJson(buildHttpUrl(baseUrl, '/api/automation/packages'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ automation, images })
  });
}