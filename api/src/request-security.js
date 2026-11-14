const CROSS_SITE_ERROR = {
  error: '다른 사이트에서 보낸 API 요청은 허용되지 않습니다. MapDule에서 다시 시도해 주세요.',
  code: 'CROSS_SITE_REQUEST'
};

function browserRequestAllowed(fetchSite) {
  // Server integrations and older browsers may omit Fetch Metadata; authentication still applies.
  return fetchSite == null || fetchSite === 'same-origin' || fetchSite === 'none';
}

module.exports = { browserRequestAllowed, CROSS_SITE_ERROR };
