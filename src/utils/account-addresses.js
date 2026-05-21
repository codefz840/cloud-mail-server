'use strict';

const EMAIL_TOKEN_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADDRESS_KEY_RE = /(email|address|receive)/i;

function splitAddressTokens(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => EMAIL_TOKEN_RE.test(token));
}

function collectAddresses(value, keyName, out, depth = 0) {
  if (value == null || depth > 6) return;

  if (typeof value === 'string') {
    if (!ADDRESS_KEY_RE.test(String(keyName || ''))) return;
    for (const token of splitAddressTokens(value)) {
      const lower = token.toLowerCase();
      if (!out.seen.has(lower)) {
        out.seen.add(lower);
        out.list.push(token);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAddresses(item, keyName, out, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectAddresses(v, k, out, depth + 1);
    }
  }
}

function extractAccountAddresses(account) {
  const out = { list: [], seen: new Set() };
  collectAddresses(account, 'account', out, 0);
  return out.list;
}

module.exports = {
  extractAccountAddresses,
};
