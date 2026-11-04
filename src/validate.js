'use strict';
const { AppError } = require('./errors');

const SAN_RE = /^[A-Za-z0-9=+#\-]{2,12}$/;
const JOB_ID_RE = /^[a-f0-9]{32}$/;

function bad(msg) { return new AppError('VALIDATION', msg, { status: 400 }); }

function validateJobId(id) {
  if (!JOB_ID_RE.test(String(id))) throw bad('Invalid job id.');
  return id;
}

/**
 * overrides: { "<wordIndex>": { san?: "Nbd2", skip?: true, insertBefore?: ["Nc6", ...] } }
 * Only these shapes are accepted; everything else is rejected (no silent coercion).
 */
function validateOverrides(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object.');
  const ov = body.overrides == null ? {} : body.overrides;
  if (typeof ov !== 'object' || Array.isArray(ov)) throw bad('"overrides" must be an object.');
  const keys = Object.keys(ov);
  if (keys.length > 200) throw bad('Too many overrides (max 200).');
  const clean = {};
  for (const k of keys) {
    if (!/^\d{1,7}$/.test(k)) throw bad(`Override key "${k}" must be a word index.`);
    const v = ov[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`Override "${k}" must be an object.`);
    const allowed = new Set(['san', 'skip', 'insertBefore']);
    for (const f of Object.keys(v)) if (!allowed.has(f)) throw bad(`Override "${k}" has unknown field "${f}".`);
    const out = {};
    if (v.san !== undefined) {
      if (typeof v.san !== 'string' || !SAN_RE.test(v.san)) throw bad(`Override "${k}".san is not a valid move.`);
      out.san = v.san;
    }
    if (v.skip !== undefined) {
      if (v.skip !== true) throw bad(`Override "${k}".skip must be true.`);
      out.skip = true;
    }
    if (v.insertBefore !== undefined) {
      if (!Array.isArray(v.insertBefore) || v.insertBefore.length === 0 || v.insertBefore.length > 10
        || !v.insertBefore.every(s => typeof s === 'string' && SAN_RE.test(s))) {
        throw bad(`Override "${k}".insertBefore must be 1-10 valid moves.`);
      }
      out.insertBefore = v.insertBefore;
    }
    if (out.san && out.skip) throw bad(`Override "${k}" cannot use both san and skip.`);
    if (Object.keys(out).length === 0) throw bad(`Override "${k}" is empty.`);
    clean[k] = out;
  }
  return clean;
}

module.exports = { validateJobId, validateOverrides, SAN_RE };
