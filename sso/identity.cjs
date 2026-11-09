const crypto = require('node:crypto');
const {AccountError, equal} = require('../backend/account-sso.cjs');
function createIdTokenVerifier({api, issuer, clientId, fetcher = fetch, now = Date.now}) {
  let cached, validUntil = 0;
  return async (token, nonce) => {
    try {
      if (typeof token !== 'string' || token.length > 32768) throw new Error();
      const parts = token.split('.'); if (parts.length !== 3 || !parts.every(p => /^[\w-]+$/.test(p))) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url')), claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error();
      if (!cached || validUntil <= now() || !cached.some(key => key.kid === header.kid)) {
        const response = await fetcher(api + '/v1/.well-known/jwks.json', {redirect: 'error', signal: AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error();
        cached = (await response.json()).keys; if (!Array.isArray(cached)) throw new Error(); validUntil = now() + 300000;
      }
      const matches = cached.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
      if (matches.length !== 1 || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({key: matches[0], format: 'jwk'}), Buffer.from(parts[2], 'base64url'))) throw new Error();
      const seconds = now() / 1000;
      if (claims.iss !== issuer || claims.aud !== clientId || claims.token_use !== 'id' || !equal(claims.nonce, nonce) || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60)) || typeof claims.sub !== 'string') throw new Error();
      return claims;
    } catch { throw new AccountError('登录身份校验失败，请重新登录', 401); }
  };
}
module.exports = {createIdTokenVerifier};
