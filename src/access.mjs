import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COOKIE = 'xiangwa_access';
const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = value => typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';

function reject(status, message) { throw Object.assign(new Error(message), { status }); }

function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only this server writes the access store. Local management uses its bearer key. */
export function createAccessControl({ directory, now = Date.now }) {
  const file = join(resolve(directory), 'access.json');
  let state;
  function save(next) {
    const temporary = `${file}.tmp`;
    try {
      mkdirSync(resolve(directory), { recursive: true });
      writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(temporary, file);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the save error. */ }
      reject(503, '访问记录保存失败，本次验证未生效。');
    }
    state = next;
  }
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('访问记录无法读取，已停止启动以保留原文件。', { cause: error });
    save({ format: 1, adminKey: randomBytes(32).toString('base64url'), invites: [], sessions: [] });
  }
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (state?.format !== 1 || typeof state.adminKey !== 'string' || state.adminKey.length < 40
      || !Array.isArray(state.invites) || state.invites.length > 256
      || !Array.isArray(state.sessions) || state.sessions.length > 1024
      || state.invites.some(invite => !invite || typeof invite.id !== 'string' || !hex(invite.digest)
        || !Number.isSafeInteger(invite.expiresAt) || !Number.isInteger(invite.maxUses) || invite.maxUses < 1
        || invite.maxUses > 32 || !Number.isInteger(invite.uses) || invite.uses < 0 || invite.uses > invite.maxUses
        || typeof invite.revoked !== 'boolean')
      || new Set(state.invites.map(invite => invite.id)).size !== state.invites.length
      || new Set(state.invites.map(invite => invite.digest)).size !== state.invites.length
      || state.sessions.some(session => !session || !hex(session.digest) || !Number.isSafeInteger(session.expiresAt)
        || !state.invites.some(invite => invite.id === session.inviteId))) {
    throw new Error('访问记录格式无效，已停止启动以保留原文件。');
  }

  function currentSession(request) {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 128) return null;
    const found = state.sessions.find(session => session.digest === digest(token) && session.expiresAt > now());
    if (!found) return null;
    return state.invites.some(invite => invite.id === found.inviteId && !invite.revoked && invite.expiresAt > now()) ? found : null;
  }

  function admin(request, input) {
    if (!equal(request.headers.authorization, `Bearer ${state.adminKey}`)) reject(403, '仅房主的本机管理工具可以执行此操作。');
    if (input.action === 'list') {
      return { invites: state.invites.map(({ id, expiresAt, maxUses, uses, revoked }) => ({ id, expiresAt, maxUses, uses, revoked })) };
    }
    if (input.action === 'revoke') {
      if (typeof input.id !== 'string' || !state.invites.some(invite => invite.id === input.id)) reject(404, '邀请码记录不存在。');
      const next = structuredClone(state);
      next.invites.find(invite => invite.id === input.id).revoked = true;
      next.sessions = next.sessions.filter(session => session.inviteId !== input.id);
      save(next);
      return { ok: true };
    }
    if (input.action !== 'create') reject(400, '未知的邀请码管理操作。');
    const { hours = 4, maxUses = 4 } = input;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 1 / 60 || hours > 168
        || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 32) reject(400, '有效期须为1分钟至7天，验证名额须为1至32个浏览器。');
    const next = structuredClone(state);
    next.invites = next.invites.filter(invite => invite.expiresAt > now() && !invite.revoked);
    next.sessions = next.sessions.filter(session => session.expiresAt > now() && next.invites.some(invite => invite.id === session.inviteId));
    if (next.invites.length >= 256) reject(409, '有效邀请码过多，请先撤销或等待过期。');
    const raw = randomBytes(9).toString('hex').toUpperCase();
    const invite = { id: randomUUID(), digest: digest(raw), expiresAt: now() + Math.round(hours * 3600000), maxUses, uses: 0, revoked: false };
    next.invites.push(invite);
    save(next);
    return { id: invite.id, code: raw.match(/.{6}/g).join('-'), expiresAt: invite.expiresAt, maxUses };
  }

  return {
    get adminKey() { return state.adminKey; },
    status(request) { return { required: true, authorized: !!currentSession(request) }; },
    require(request) { if (!currentSession(request)) reject(401, '请先使用房主发放的有效邀请码验证，再创建或加入房间。'); },
    admin,
    redeem(request, response, code) {
      const normalized = normalize(code);
      const found = /^[A-F0-9]{18}$/.test(normalized) && state.invites.find(invite => equal(invite.digest, digest(normalized)));
      if (!found || found.revoked || found.expiresAt <= now()) reject(401, '邀请码无效、已过期或名额已用完，请向房主获取新码。');
      const existing = currentSession(request);
      if (existing?.inviteId === found.id) return { required: true, authorized: true, expiresAt: existing.expiresAt };
      if (found.uses >= found.maxUses) reject(401, '邀请码无效、已过期或名额已用完，请向房主获取新码。');
      const next = structuredClone(state);
      next.sessions = next.sessions.filter(session => session.expiresAt > now());
      if (next.sessions.length >= 1024) reject(503, '访问名额已满，请稍后再试。');
      const token = randomBytes(32).toString('base64url');
      next.invites.find(invite => invite.id === found.id).uses += 1;
      next.sessions.push({ digest: digest(token), inviteId: found.id, expiresAt: found.expiresAt });
      save(next);
      const host = new URL(`http://${request.headers.host || 'localhost'}`).hostname;
      const secure = ['localhost', '127.0.0.1', '[::1]'].includes(host) ? '' : '; Secure';
      response.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((found.expiresAt - now()) / 1000))}${secure}`);
      return { required: true, authorized: true, expiresAt: found.expiresAt };
    },
  };
}

export const DEFAULT_LIMITS = Object.freeze({
  maxRooms: 20, maxStreams: 64, streamsPerPlayer: 4, maxConnections: 128,
  requestsPerMinute: 1200, requestBurst: 160, inviteAttemptsPerMinute: 30, inviteAttemptBurst: 12,
});

/** Global budgets also cover requests arriving through the same local tunnel address. */
export function createTrafficControl({ limits = {}, now = Date.now } = {}) {
  const values = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`资源上限无效：${key}`);
  }
  const buckets = new Map();
  function take(key, rate, burst) {
    const timestamp = now();
    const bucket = buckets.get(key) || { tokens: burst, timestamp };
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, timestamp - bucket.timestamp) * rate / 60000);
    bucket.timestamp = timestamp;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) reject(429, '请求过于频繁，请稍后重试。');
    bucket.tokens -= 1;
  }
  return { limits: values,
    request() { take('all', values.requestsPerMinute, values.requestBurst); },
    invite() { take('invite', values.inviteAttemptsPerMinute, values.inviteAttemptBurst); },
  };
}
