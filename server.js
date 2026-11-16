const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { Agent } = require('undici');
const { createStorage } = require('./storage');

// ---------------------------------------------------------------------------
// 1. Environment & Cryptographic Key Initialization
// ---------------------------------------------------------------------------
function parseEnvString(content) {
  const result = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    require('dotenv').config({ path: filePath });
  } catch (_) {
    const parsed = parseEnvString(fs.readFileSync(filePath, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, 'canvas_api.env'));

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '.data'));
const SECRET_FILE = path.join(DATA_DIR, 'master.key');
let STORAGE = null;
let STORAGE_INITIALIZATION_ERROR = null;
let PERSISTENCE = 'unavailable';
try {
  STORAGE = createStorage({ dataDir: DATA_DIR });
  PERSISTENCE = STORAGE.mode;
} catch (error) {
  STORAGE_INITIALIZATION_ERROR = error;
  console.error('Persistent storage initialization failed:', error.message);
}
const CANVAS_HTTP_AGENT = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      const host = String(hostname).replace(/^\[|\]$/g, '');
      const family = net.isIP(host);
      if (family) {
        if (!isPublicIp(host)) {
          callback(new Error('Canvas URL resolves to a non-public address.'));
          return;
        }
        if (options && options.all) callback(null, [{ address: host, family }]);
        else callback(null, host, family);
        return;
      }

      dns.lookup(
        host,
        {
          family: options && options.family ? options.family : 0,
          hints: options && options.hints ? options.hints : 0,
          all: true,
          verbatim: true,
        },
        (error, addresses) => {
          if (error) {
            callback(error);
            return;
          }
          if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
            callback(new Error('Canvas hostname resolves to a non-public address.'));
            return;
          }
          if (options && options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }
      );
    },
  },
});
let masterKeyCache = null;

function getOrCreateMasterKey() {
  const configuredKey = process.env.APP_ENCRYPTION_KEY;
  if (configuredKey) {
    if (!/^[a-f0-9]{64}$/i.test(configuredKey)) {
      throw new Error('APP_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
    }
    return Buffer.from(configuredKey, 'hex');
  }
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return crypto.scryptSync(process.env.SESSION_SECRET, 'canvas-hub-master-salt-v1', 32);
  }
  if (PERSISTENCE === 'postgres') {
    throw new Error(
      'SESSION_SECRET (at least 32 characters) or APP_ENCRYPTION_KEY (64 hex characters) is required for PostgreSQL storage.'
    );
  }
  if (fs.existsSync(SECRET_FILE)) {
    const hex = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
    throw new Error('The local master key is invalid; refusing to replace it.');
  }
  const newKey = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRET_FILE, newKey.toString('hex'), { mode: 0o600 });
  return newKey;
}

function getMasterKey() {
  if (!masterKeyCache) masterKeyCache = getOrCreateMasterKey();
  return masterKeyCache;
}

function getCookieSignKey() {
  return crypto.createHmac('sha256', getMasterKey()).update('cookie-sign-v1').digest();
}

function getVaultEncryptionKey() {
  return crypto.createHmac('sha256', getMasterKey()).update('vault-aes-256-gcm-v1').digest();
}

// ---------------------------------------------------------------------------
// 2. AES-256-GCM Encryption & Per-User Credential Vault
// ---------------------------------------------------------------------------
function encryptPayload(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptPayload(tokenStr) {
  const parts = String(tokenStr || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid IV or auth tag length');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function hashPassphrase(passphrase, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(passphrase), salt, 32);
  return { saltHex: salt.toString('hex'), hashHex: derived.toString('hex') };
}

function verifyPassphrase(passphrase, saltHex, expectedHashHex) {
  const { hashHex } = hashPassphrase(passphrase, saltHex);
  const a = Buffer.from(hashHex, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function authenticateOrRegisterUser(email, passphrase, displayName) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }
  const secret = String(passphrase || '').trim();
  if (secret.length < 6) {
    const error = new Error('Passphrase must be at least 6 characters.');
    error.status = 400;
    throw error;
  }

  const userId = `acct:${crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 24)}`;
  const existing = await STORAGE.get('users', userId);
  if (existing) {
    const record = decryptPayload(existing);
    if (!verifyPassphrase(secret, record.saltHex, record.hashHex)) {
      const err = new Error('Incorrect passphrase for this email.');
      err.status = 401;
      throw err;
    }
    return {
      sub: userId,
      email: record.email,
      name: displayName || record.name || cleanEmail.split('@')[0],
      authProvider: 'encrypted-account',
    };
  }

  const { saltHex, hashHex } = hashPassphrase(secret);
  const newRecord = {
    userId,
    email: cleanEmail,
    name: displayName || cleanEmail.split('@')[0],
    saltHex,
    hashHex,
    createdAt: new Date().toISOString(),
  };
  const encryptedRecord = encryptPayload(newRecord);
  const created = await STORAGE.setIfAbsent('users', userId, encryptedRecord);
  if (!created) {
    const record = decryptPayload(await STORAGE.get('users', userId));
    if (!verifyPassphrase(secret, record.saltHex, record.hashHex)) {
      const err = new Error('Incorrect passphrase for this email.');
      err.status = 401;
      throw err;
    }
    return {
      sub: userId,
      email: record.email,
      name: displayName || record.name || cleanEmail.split('@')[0],
      authProvider: 'encrypted-account',
    };
  }

  return {
    sub: userId,
    email: newRecord.email,
    name: newRecord.name,
    authProvider: 'encrypted-account',
  };
}

const memoryVault = new Map();

async function setUserCredentials(
  userId,
  { canvasBaseUrl, canvasApiToken, persistMode = 'encrypted_disk', studentName = null }
) {
  if (!['encrypted_disk', 'memory'].includes(persistMode)) {
    throw new Error('Invalid credential persistence mode.');
  }
  if (PERSISTENCE === 'postgres' && persistMode === 'memory') {
    const error = new Error('Memory-only credentials are unavailable with durable server storage.');
    error.status = 400;
    throw error;
  }
  const encrypted = encryptPayload({
    canvasBaseUrl,
    canvasApiToken,
    studentName,
    updatedAt: new Date().toISOString(),
    persistMode,
  });
  if (persistMode === 'encrypted_disk') {
    await STORAGE.set('vault', userId, encrypted);
    memoryVault.delete(userId);
    return;
  }

  await STORAGE.remove('vault', userId);
  memoryVault.set(userId, encrypted);
}

async function getUserCredentials(userId) {
  let enc = memoryVault.get(userId);
  if (!enc) {
    enc = await STORAGE.get('vault', userId);
  }
  if (!enc) return null;
  try {
    return decryptPayload(enc);
  } catch (cause) {
    throw new Error('Stored Canvas credentials are invalid or cannot be decrypted.', { cause });
  }
}

async function deleteUserCredentials(userId) {
  memoryVault.delete(userId);
  await STORAGE.remove('vault', userId);
}

function maskToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (t.length <= 10) return '••••••••';
  return `${t.slice(0, 5)}••••••••${t.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 3. URL & SSRF Validation
// ---------------------------------------------------------------------------
function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      return false;
    }
    return true;
  }

  if (family !== 6) return false;
  const groups = address.split('%')[0].toLowerCase().split(':').filter(Boolean);
  const first = Number.parseInt(groups[0] || '0', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (
    first === 0x2002 ||
    (first === 0x2001 &&
      (second <= 0x01ff || second === 0x0db8 || second === 0x0010 || second === 0x0020))
  ) {
    return false;
  }
  return true;
}

async function fetchCanvas(url, options = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (cause) {
    const error = new Error('Canvas request URL is invalid.', { cause });
    error.status = 400;
    throw error;
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password ||
    (parsedUrl.port && parsedUrl.port !== '443')
  ) {
    const error = new Error('Canvas request must use a standard HTTPS URL.');
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(parsedUrl, {
      ...options,
      dispatcher: CANVAS_HTTP_AGENT,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error('Canvas redirected the API request; verify the Canvas base URL.');
      error.status = 502;
      throw error;
    }
    const maxResponseBytes = 8 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      controller.abort();
      const error = new Error('Canvas response exceeded the allowed size.');
      error.status = 502;
      throw error;
    }
    const chunks = [];
    let responseBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > maxResponseBytes) {
          controller.abort();
          const error = new Error('Canvas response exceeded the allowed size.');
          error.status = 502;
          throw error;
        }
        chunks.push(Buffer.from(value));
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      async text() {
        return text;
      },
      async json() {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (cause) {
          const error = new Error('Canvas returned an invalid JSON response.', { cause });
          error.status = 502;
          throw error;
        }
      },
    };
  } catch (cause) {
    if (Number.isInteger(cause.status)) throw cause;
    const error = controller.signal.aborted
      ? new Error('Canvas request timed out.')
      : new Error('Could not reach Canvas.');
    error.status = controller.signal.aborted ? 504 : 502;
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAndValidateCanvasUrl(rawUrl) {
  const fallback = 'https://wcpss.instructure.com';
  const invalidUrl = (message) => {
    const error = new Error(message);
    error.status = 400;
    return error;
  };
  let cleaned = String(rawUrl || fallback).trim();
  if (!cleaned) cleaned = fallback;
  cleaned = cleaned.replace(/^(https?):\/([^/])/i, '$1://$2');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch (_) {
    throw invalidUrl('Invalid Canvas school URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw invalidUrl('Canvas URL must use HTTPS (https://).');
  }
  if (parsed.username || parsed.password) {
    throw invalidUrl('URL must not contain embedded credentials.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw invalidUrl('URL must use standard HTTPS port 443.');
  }

  const host = parsed.hostname.toLowerCase();
  const literalHost = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literalHost) && !isPublicIp(literalHost)) {
    throw invalidUrl('SSRF Protection: Private, loopback, or internal network hosts are blocked.');
  }
  const forbiddenHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
  if (
    forbiddenHosts.includes(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw invalidUrl('SSRF Protection: Private, loopback, or internal network hosts are blocked.');
  }

  return `${parsed.protocol}//${parsed.hostname}`;
}

// ---------------------------------------------------------------------------
// 4. Session Management
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days convenience for students

function signSessionId(sessionId) {
  const sig = crypto.createHmac('sha256', getCookieSignKey()).update(sessionId).digest('base64url');
  return `${sessionId}.${sig}`;
}

function sessionCookieHeader(req, value, maxAge) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const secure = process.env.NODE_ENV === 'production' || forwardedProto === 'https';
  return `canvas_hub_session=${encodeURIComponent(
    value
  )}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

async function verifySignedSessionCookie(cookieVal) {
  if (!cookieVal || typeof cookieVal !== 'string') return null;
  const idx = cookieVal.indexOf('.');
  if (idx === -1) return null;
  const sessionId = cookieVal.slice(0, idx);
  const sig = cookieVal.slice(idx + 1);
  const expectedSig = crypto.createHmac('sha256', getCookieSignKey()).update(sessionId).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const session = await STORAGE.get('sessions', sessionId);
  if (!session) return null;
  if (
    typeof session.userId !== 'string' ||
    !session.userId ||
    !Number.isFinite(Number(session.expiresAt)) ||
    Date.now() >= Number(session.expiresAt)
  ) {
    await STORAGE.remove('sessions', sessionId);
    return null;
  }
  return { sessionId, ...session };
}

async function createSession(userProfile) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const sessionData = {
    userId: userProfile.sub,
    email: userProfile.email || '',
    name: userProfile.name || 'Student',
    picture: userProfile.picture || '',
    authProvider: userProfile.authProvider || 'token-vault',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  const signedCookie = signSessionId(sessionId);
  await STORAGE.set('sessions', sessionId, sessionData, {
    expiresAt: new Date(sessionData.expiresAt),
  });
  return { sessionId, signedCookie, sessionData };
}

async function deleteSession(sessionId) {
  if (sessionId) await STORAGE.remove('sessions', sessionId);
}

function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (error) {
      console.warn('Ignoring malformed cookie value:', error.message);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Per-User Isolated 5-Minute In-Memory Cache
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
const apiCache = new Map();
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;
let apiCacheBytes = 0;
let lastCachePruneAt = 0;

function deleteCached(cacheKey) {
  const entry = apiCache.get(cacheKey);
  if (!entry) return;
  apiCache.delete(cacheKey);
  apiCacheBytes -= entry.sizeBytes;
}

function pruneApiCache(now) {
  if (now - lastCachePruneAt < 60_000 && apiCache.size < MAX_CACHE_ENTRIES) return;
  lastCachePruneAt = now;
  for (const [key, entry] of apiCache.entries()) {
    if (now > entry.expiresAt) deleteCached(key);
  }
}

function makeUserCacheKey(userId, canvasBaseUrl, canvasApiToken, endpoint) {
  const tokenFingerprint = crypto
    .createHmac('sha256', getMasterKey())
    .update(String(canvasApiToken || ''))
    .digest('hex')
    .slice(0, 16);
  return `${userId}|${canvasBaseUrl}|${tokenFingerprint}|${endpoint}`;
}

function getCached(cacheKey) {
  const entry = apiCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    deleteCached(cacheKey);
    return null;
  }
  apiCache.delete(cacheKey);
  apiCache.set(cacheKey, entry);
  return entry;
}

function setCached(cacheKey, userId, data, source = 'canvas') {
  const now = Date.now();
  const sizeBytes = Buffer.byteLength(JSON.stringify(data));
  const entry = {
    userId,
    data,
    source,
    timestamp: now,
    expiresAt: now + CACHE_TTL_MS,
    sizeBytes,
  };
  pruneApiCache(now);
  deleteCached(cacheKey);
  if (sizeBytes <= MAX_CACHE_ENTRY_BYTES) {
    while (
      apiCache.size >= MAX_CACHE_ENTRIES ||
      apiCacheBytes + sizeBytes > MAX_CACHE_BYTES
    ) {
      const oldestKey = apiCache.keys().next().value;
      if (oldestKey === undefined) break;
      deleteCached(oldestKey);
    }
    apiCache.set(cacheKey, entry);
    apiCacheBytes += sizeBytes;
  }
  return entry;
}

function clearUserCache(userId) {
  for (const [k, v] of apiCache.entries()) {
    if (v.userId === userId || k.startsWith(`${userId}|`)) {
      deleteCached(k);
    }
  }
}

async function fetchUserCanvasApi(userId, creds, endpoint, forceRefresh = false) {
  if (!creds || !creds.canvasBaseUrl || !creds.canvasApiToken) {
    const err = new Error('Canvas API token not configured.');
    err.code = 'TOKEN_MISSING';
    throw err;
  }

  const cacheKey = makeUserCacheKey(userId, creds.canvasBaseUrl, creds.canvasApiToken, endpoint);
  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const baseUrl = new URL(creds.canvasBaseUrl);
  let nextUrl = new URL(endpoint, baseUrl);
  const seenPages = new Set();
  const items = [];
  let pages = 0;
  while (nextUrl) {
    if (
      nextUrl.origin !== baseUrl.origin ||
      !nextUrl.pathname.startsWith('/api/v1/') ||
      nextUrl.username ||
      nextUrl.password
    ) {
      const error = new Error('Canvas returned an invalid pagination URL.');
      error.status = 502;
      throw error;
    }
    if (seenPages.has(nextUrl.href)) {
      const error = new Error('Canvas pagination contains a repeated page.');
      error.status = 502;
      throw error;
    }
    seenPages.add(nextUrl.href);
    pages += 1;
    if (pages > 100) {
      const error = new Error('Canvas pagination exceeded the 100-page limit.');
      error.status = 502;
      throw error;
    }

    const response = await fetchCanvas(nextUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.canvasApiToken}`,
        Accept: 'application/json',
        'User-Agent': 'Atelier-Canvas/4.0',
      },
    });
    if (!response.ok) {
      const error = new Error(`Canvas API request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    const pageData = await response.json();
    if (!Array.isArray(pageData)) {
      const error = new Error('Canvas returned an invalid list response.');
      error.status = 502;
      throw error;
    }

    items.push(...pageData);
    if (items.length > 10000) {
      const error = new Error('Canvas pagination exceeded the 10,000-item limit.');
      error.status = 502;
      throw error;
    }
    const linkHeader = response.headers.get('link') || '';
    const nextLink = linkHeader
      .split(',')
      .map((link) => link.match(/<([^>]+)>\s*;\s*rel=["']?next["']?/i))
      .find(Boolean);
    if (nextLink) {
      try {
        nextUrl = new URL(nextLink[1], nextUrl);
      } catch (cause) {
        const error = new Error('Canvas returned an invalid pagination URL.', { cause });
        error.status = 502;
        throw error;
      }
    } else {
      nextUrl = null;
    }
  }

  const saved = setCached(cacheKey, userId, items, 'canvas');
  return { ...saved, cached: false };
}

// ---------------------------------------------------------------------------
// 6. Rate Limiting, Security Headers & Data Enrichers
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
const MAX_RATE_BUCKETS = 10000;
let lastRateBucketPruneAt = 0;

function checkRateLimit(ip, bucket = 'api', maxPerMin = 240) {
  const now = Date.now();
  if (now - lastRateBucketPruneAt >= 60_000 || rateBuckets.size >= MAX_RATE_BUCKETS) {
    lastRateBucketPruneAt = now;
    for (const [key, entry] of rateBuckets.entries()) {
      if (now > entry.resetAt) rateBuckets.delete(key);
    }
  }
  const key = `${ip}:${bucket}`;
  let item = rateBuckets.get(key);
  if (!item && rateBuckets.size >= MAX_RATE_BUCKETS) return false;
  item = item || { count: 0, resetAt: now + 60_000 };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + 60_000;
  }
  item.count += 1;
  rateBuckets.set(key, item);
  return item.count <= maxPerMin;
}

function isAllowedLocalOrigin(originHeader) {
  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:' || origin.username || origin.password) return false;
  const hostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '::1') return true;
  const octets = hostname.split('.').map(Number);
  return net.isIP(hostname) === 4 && octets[0] === 127;
}

function getSecurityHeaders(isApi = false, originHeader = '') {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; font-src 'self' https://fonts.gstatic.com; frame-src https://accounts.google.com; connect-src 'self' http://localhost:3000 https://*.instructure.com https://accounts.google.com https://www.googleapis.com https://*.canvas-user-content.com; img-src 'self' data: https://*.googleusercontent.com https://*.instructure.com https://*.canvas-user-content.com;",
  };
  if (originHeader && isAllowedLocalOrigin(originHeader)) {
    headers['Access-Control-Allow-Origin'] = originHeader;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Requested-With, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
  }
  if (isApi) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private';
    headers['Pragma'] = 'no-cache';
  }
  return headers;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (req && req.body && typeof req.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(req.body)) > maxBytes) {
        const error = new Error('Payload too large.');
        error.status = 413;
        return reject(error);
      }
      return resolve(req.body);
    }
    if (req && typeof req.rawBody === 'string') {
      if (Buffer.byteLength(req.rawBody) > maxBytes) {
        const error = new Error('Payload too large.');
        error.status = 413;
        return reject(error);
      }
      try {
        return resolve(req.rawBody ? JSON.parse(req.rawBody) : {});
      } catch (cause) {
        const error = new Error('Invalid JSON payload.', { cause });
        error.status = 400;
        return reject(error);
      }
    }
    if (!req || typeof req.on !== 'function') {
      return resolve({});
    }
    let total = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error('Payload too large.');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (cause) {
        const error = new Error('Invalid JSON payload.', { cause });
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function isLoopbackRequest(req) {
  const remote = req?.socket?.remoteAddress || '127.0.0.1';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function normalizeCanvasAssignment(a, groupMap = null) {
  if (!a || typeof a !== 'object') return null;
  const sub = a.submission || {};
  const subTypes = Array.isArray(a.submission_types) ? a.submission_types : [];
  const noOnlineSubmission =
    subTypes.includes('none') || subTypes.includes('not_graded') || subTypes.includes('on_paper');
  const isSubmitted = Boolean(
    sub.workflow_state === 'submitted' ||
      sub.workflow_state === 'graded' ||
      sub.submitted_at ||
      sub.score != null ||
      sub.excused === true ||
      a.has_submitted_submissions === true
  );
  const groupName =
    (groupMap && a.assignment_group_id && groupMap.get(String(a.assignment_group_id))) ||
    a.group_name ||
    null;

  const rubricSummary = Array.isArray(a.rubric)
    ? a.rubric.slice(0, 6).map((r) => ({
        description: r.description || r.long_description || 'Criterion',
        points: r.points,
      }))
    : null;

  const comments = Array.isArray(sub.submission_comments)
    ? sub.submission_comments.map((c) => ({
        author: c.author_name || 'Teacher',
        comment: c.comment || '',
        created_at: c.created_at || null,
      }))
    : [];

  const embeddedFiles = extractEmbeddedAttachmentsFromHtml(a.description || '', a.attachments || []);

  return {
    id: a.id,
    course_id: a.course_id,
    name: a.name,
    due_at: a.due_at || null,
    created_at: a.created_at || null,
    updated_at: a.updated_at || null,
    unlock_at: a.unlock_at || null,
    lock_at: a.lock_at || null,
    points_possible: a.points_possible,
    assignment_group_id: a.assignment_group_id || null,
    group_name: groupName,
    html_url: a.html_url,
    description: stripHtmlServer(a.description || '').slice(0, 260),
    attachments: embeddedFiles,
    submission_types: subTypes,
    no_online_submission: noOnlineSubmission,
    is_submitted: isSubmitted,
    submission_status: sub.workflow_state || (isSubmitted ? 'submitted' : 'unsubmitted'),
    submitted_at: sub.submitted_at || null,
    graded_at: sub.graded_at || null,
    score: sub.score != null ? Number(sub.score) : null,
    grade: sub.grade || null,
    late: Boolean(sub.late),
    excused: Boolean(sub.excused),
    missing: Boolean(sub.missing),
    rubric: rubricSummary,
    submission_comments: comments,
  };
}

function stripHtmlServer(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function extractEmbeddedAttachmentsFromHtml(rawHtml, existingAttachments = []) {
  const out = [];
  const seenUrls = new Set();

  if (Array.isArray(existingAttachments)) {
    for (const f of existingAttachments) {
      const url = String(f.url || f.download_url || '').replace(/&amp;/g, '&');
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      out.push({
        id: f.id || url,
        display_name: f.display_name || f.filename || 'Attachment',
        url,
      });
    }
  }

  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(String(rawHtml || ''))) !== null) {
    const rawHref = match[1].replace(/&amp;/g, '&').trim();
    const linkText = stripHtmlServer(match[2]).trim();
    if (!rawHref || seenUrls.has(rawHref)) continue;
    const isFileOrResourceLink =
      /\/files\/\d+/i.test(rawHref) ||
      /\.(docx?|pdf|pptx?|xlsx?|csv|zip)(\?|$)/i.test(rawHref) ||
      /\.(docx?|pdf|pptx?|xlsx?|csv|zip)$/i.test(linkText) ||
      /forms\.gle\/|docs\.google\.com\/(forms|document|presentation|spreadsheets)/i.test(rawHref) ||
      /reviewecon\.com|studyspanish\.com/i.test(rawHref);
    if (isFileOrResourceLink) {
      seenUrls.add(rawHref);
      let label = linkText || 'Course Resource';
      if (/forms\.gle|docs\.google\.com\/forms/i.test(rawHref) && (!linkText || /^here|link|form$/i.test(linkText))) {
        label = 'Google Form Assessment';
      } else if (/reviewecon\.com/i.test(rawHref) && (!linkText || /^here|link$/i.test(linkText))) {
        label = 'ReviewEcon Practice Game';
      }
      out.push({
        id: rawHref,
        display_name: label,
        url: rawHref,
      });
    }
  }

  return out;
}

function summarizeAnnouncementServer(ann) {
  const rawHtml = String(ann.message || '');
  const cleanText = stripHtmlServer(rawHtml);
  const attachments = extractEmbeddedAttachmentsFromHtml(rawHtml, ann.attachments);

  const lines = cleanText
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 3 &&
        !/^(hi|hello|dear|good morning|good afternoon|hey|students,?)\b/i.test(l) &&
        !/^(ok\.?\s*time for a quiz!?|what'?s on the quiz\??|\d+\.\s*minor assessments and retests)$/i.test(
          l
        )
    );

  const title = String(ann.title || 'Class Announcement').trim();
  const combinedLower = `${title} ${cleanText}`.toLowerCase();

  let category = 'Class Update';
  if (/\b(quiz|test|exam|assessment|midterm|frq)\b/i.test(combinedLower)) {
    category = 'Quiz / Test Alert';
  } else if (/\b(due date|deadline|naa|submit|extended|extension)\b/i.test(combinedLower)) {
    category = 'Due Date Update';
  } else if (/\b(grade|infinite campus|retest|exempt|missing assignment|q1|quarter)\b/i.test(combinedLower)) {
    category = 'Grade Policy';
  } else if (
    attachments.length > 0 ||
    /\b(solution|key|practice problems|worksheet|notes)\b/i.test(combinedLower)
  ) {
    category = 'Study Key & Handout';
  }

  const bullets = [];
  const seen = new Set();
  const pushBullet = (str) => {
    const cleaned = String(str || '').replace(/^[-•*]\s*/, '').trim();
    if (cleaned.length < 10 || cleaned.length > 220) return;
    // Skip lines that are just bare filenames already shown as download buttons
    if (/\.(docx?|pdf|pptx?)$/i.test(cleaned) && cleaned.split(/\s+/).length <= 2) return;
    const key = cleaned.slice(0, 42).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    bullets.push(cleaned);
  };

  // Combine A-Day / B-Day schedule lines if present
  const aDayLine = lines.find((l) => /^A-Day:/i.test(l));
  const bDayLine = lines.find((l) => /^B-Day:/i.test(l));
  if (aDayLine && bDayLine) {
    pushBullet(`Schedule: ${aDayLine} • ${bDayLine}`);
  }

  // Extract bold topic headers (e.g. "3.1 — Aggregate Demand (AD)")
  const strongHeaders = [...rawHtml.matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/gi)]
    .map((m) => stripHtmlServer(m[1]))
    .filter((s) => /^\d+\.\d+\s*[-—–]/.test(s));
  if (strongHeaders.length > 0) {
    pushBullet(`Topics Covered: ${strongHeaders.join(' • ')}`);
  }

  const liMatches = [...rawHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripHtmlServer(m[1]))
    .filter((t) => t.length >= 12 && t.length <= 210);

  const actionSentences = lines.filter(
    (l) =>
      !/^(A-Day|B-Day):/i.test(l) &&
      /\b(quiz|test|due|monday|tuesday|wednesday|thursday|friday|11\/\d+|nov|rule|multiplier|aggregate|retest|exempt|submit|screenshot|homework|hw|sec\s*\d|naa)\b/i.test(
        l
      )
  );

  for (const candidate of [...actionSentences, ...liMatches, ...lines]) {
    if (bullets.length >= 4) break;
    if (/^(A-Day|B-Day):/i.test(candidate) && aDayLine && bDayLine) continue;
    pushBullet(candidate);
  }

  if (bullets.length === 0 && cleanText.length >= 10) {
    pushBullet(cleanText.slice(0, 210));
  }

  const tldr =
    bullets.length > 0
      ? bullets.slice(0, 2).join(' • ')
      : lines.slice(0, 2).join(' ') || title;

  return {
    id: ann.id,
    title,
    message: ann.message || '',
    clean_text: cleanText,
    posted_at: ann.posted_at || ann.created_at || null,
    context_code: ann.context_code || '',
    author_name: (ann.author && ann.author.display_name) || ann.user_name || 'Teacher',
    read_state: ann.read_state || 'unread',
    html_url: ann.html_url || '',
    is_long: cleanText.length > 260,
    char_count: cleanText.length,
    category,
    tldr: tldr.slice(0, 260),
    bullets,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// 7. Unified API Request Handler
// ---------------------------------------------------------------------------
async function handleApiRequest(reqOrUrl, res) {
  const req =
    typeof reqOrUrl === 'string'
      ? {
          url: reqOrUrl,
          method: 'GET',
          headers: { 'x-requested-with': 'CanvasHub' },
          socket: { remoteAddress: '127.0.0.1' },
        }
      : reqOrUrl;

  const method = (req.method || 'GET').toUpperCase();
  const originHeader = req.headers?.origin || '';

  if (method === 'OPTIONS') {
    res.writeHead(204, getSecurityHeaders(true, originHeader));
    return res.end();
  }

  const parsed = new URL(req.originalUrl || req.url || '/', `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const forceRefresh = parsed.searchParams.get('refresh') === 'true';
  const clientIp = req.socket?.remoteAddress || '127.0.0.1';

  const sendJson = (status, payload, extraHeaders = {}) => {
    res.writeHead(status, {
      ...getSecurityHeaders(true, originHeader),
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
  };

  if (pathname === '/api/health' && method === 'GET') {
    try {
      getMasterKey();
      await STORAGE.check();
    } catch (error) {
      console.error('Health check could not verify persistent storage:', error.message);
      return sendJson(error.status || 503, {
        status: 'error',
        error: 'Persistent storage is unavailable.',
      });
    }
    return sendJson(200, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      service: 'Slated 24/7 Academic OS',
      version: '4.2.0',
      persistence: PERSISTENCE,
    });
  }

  if (
    !checkRateLimit(
      clientIp,
      pathname.startsWith('/api/auth') ? 'auth' : 'api',
      pathname.startsWith('/api/auth') ? 60 : 300
    )
  ) {
    return sendJson(429, { error: 'Too many requests. Please wait a moment and try again.' });
  }

  if (method === 'POST' || method === 'DELETE' || method === 'PUT') {
    const csrfHeader = req.headers?.['x-requested-with'];
    if (csrfHeader !== 'CanvasHub') {
      return sendJson(403, { error: 'CSRF protection: missing required X-Requested-With header.' });
    }
  }

  let cookies;
  let currentSession = null;

  try {
    cookies = parseCookies(req);
    currentSession = await verifySignedSessionCookie(cookies.canvas_hub_session);
    // -----------------------------------------------------------------------
    // A. Session Status (with automatic localhost .env provisioning if requested)
    // -----------------------------------------------------------------------
    if (pathname === '/api/auth/session' && method === 'GET') {
      const hasLocalEnvFileToken = Boolean(
        process.env.CANVAS_BASE_URL && process.env.CANVAS_API_TOKEN && isLoopbackRequest(req)
      );

      // If running on localhost and no session cookie exists yet, but local .env has a token,
      // automatically create an encrypted local session when ?auto=1 is passed so the student
      // doesn't face unnecessary walls on their own local server!
      if (!currentSession && hasLocalEnvFileToken && parsed.searchParams.get('auto') === '1') {
        const validatedUrl = normalizeAndValidateCanvasUrl(process.env.CANVAS_BASE_URL);
        const cleanedToken = String(process.env.CANVAS_API_TOKEN).trim();
        const userId = `token:${crypto
          .createHmac('sha256', getMasterKey())
          .update(cleanedToken)
          .digest('hex')
          .slice(0, 24)}`;
        await setUserCredentials(userId, {
          canvasBaseUrl: validatedUrl,
          canvasApiToken: cleanedToken,
          persistMode: 'encrypted_disk',
          studentName: 'Student Workspace',
        });
        const created = await createSession({
          sub: userId,
          email: 'local-workspace@canvas',
          name: 'Student Workspace',
          authProvider: 'local-env',
        });
        currentSession = { sessionId: created.sessionId, ...created.sessionData };
        const creds = await getUserCredentials(currentSession.userId);
        return sendJson(
          200,
          {
            authenticated: true,
            hasLocalEnvFileToken,
            user: currentSession,
            credentials: {
              configured: true,
              canvasBaseUrl: creds.canvasBaseUrl,
              maskedToken: maskToken(creds.canvasApiToken),
              persistMode: creds.persistMode,
            },
          },
          {
            'Set-Cookie': sessionCookieHeader(req, created.signedCookie, SESSION_TTL_MS / 1000),
          }
        );
      }

      if (!currentSession) {
        return sendJson(200, {
          authenticated: false,
          hasLocalEnvFileToken,
          defaultBaseUrl: normalizeAndValidateCanvasUrl(
            process.env.CANVAS_BASE_URL || 'https://wcpss.instructure.com'
          ),
        });
      }

      const creds = await getUserCredentials(currentSession.userId);
      return sendJson(200, {
        authenticated: true,
        hasLocalEnvFileToken,
        user: {
          userId: currentSession.userId,
          email: currentSession.email,
          name: currentSession.name,
          picture: currentSession.picture,
          authProvider: currentSession.authProvider,
        },
        credentials: {
          configured: Boolean(creds && creds.canvasBaseUrl && creds.canvasApiToken),
          canvasBaseUrl: creds ? creds.canvasBaseUrl : null,
          maskedToken: creds ? maskToken(creds.canvasApiToken) : null,
          persistMode: creds ? creds.persistMode : 'memory',
          updatedAt: creds ? creds.updatedAt : null,
        },
      });
    }

    // -----------------------------------------------------------------------
    // B. 1-Step Frictionless Token Connect (Paste Token -> Verify -> Done!)
    // -----------------------------------------------------------------------
    if (pathname === '/api/auth/connect-token' && method === 'POST') {
      const body = await readJsonBody(req);
      let rawUrl = body.canvasBaseUrl || 'https://wcpss.instructure.com';
      let rawToken = body.canvasApiToken || '';
      const requestedMode = body.persistMode ?? 'encrypted_disk';
      if (!['encrypted_disk', 'memory'].includes(requestedMode)) {
        return sendJson(400, { error: 'Invalid persistMode.' });
      }
      if (PERSISTENCE === 'postgres' && requestedMode === 'memory') {
        return sendJson(400, {
          error: 'Memory-only credentials are unavailable with durable server storage.',
        });
      }
      const persistMode = requestedMode;

      if (body.envFileContent && typeof body.envFileContent === 'string') {
        const parsedEnv = parseEnvString(body.envFileContent);
        if (parsedEnv.CANVAS_BASE_URL) rawUrl = parsedEnv.CANVAS_BASE_URL;
        if (parsedEnv.CANVAS_API_TOKEN) rawToken = parsedEnv.CANVAS_API_TOKEN;
      }

      if (body.importWorkspaceEnv === true) {
        if (!isLoopbackRequest(req)) {
          return sendJson(403, { error: 'Workspace .env import is only allowed on localhost.' });
        }
        rawUrl = process.env.CANVAS_BASE_URL || 'https://wcpss.instructure.com';
        rawToken = process.env.CANVAS_API_TOKEN || '';
      }

      // Also handle if a student pasted the entire .env file content into the token box!
      if (rawToken.includes('CANVAS_API_TOKEN=')) {
        const parsedInline = parseEnvString(rawToken);
        if (parsedInline.CANVAS_BASE_URL) rawUrl = parsedInline.CANVAS_BASE_URL;
        if (parsedInline.CANVAS_API_TOKEN) rawToken = parsedInline.CANVAS_API_TOKEN;
      }

      const validatedUrl = normalizeAndValidateCanvasUrl(rawUrl);
      const cleanedToken = String(rawToken || '')
        .trim()
        .replace(/^["']|["']$/g, '');

      if (!cleanedToken || cleanedToken.length < 12) {
        return sendJson(400, { error: 'Please paste a valid Canvas access token.' });
      }

      let verifiedUser = null;
      if (body.verifyWithCanvas !== false) {
        try {
          const verifyRes = await fetchCanvas(`${validatedUrl}/api/v1/users/self`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${cleanedToken}`,
              Accept: 'application/json',
              'User-Agent': 'Atelier-Canvas/4.0',
            },
          });
          if (!verifyRes.ok) {
            return sendJson(400, {
              error: `Canvas rejected this token (HTTP ${verifyRes.status}). Make sure your token hasn't expired.`,
            });
          }
          verifiedUser = await verifyRes.json();
        } catch (err) {
          const status = Number.isInteger(err.status) && err.status >= 500 ? err.status : 400;
          return sendJson(status, {
            error: status >= 500 ? err.message : `Could not connect to ${validatedUrl}.`,
          });
        }
      }

      // Derive isolated account ID from HMAC of token (or existing logged-in session)
      const tokenUserId = currentSession
        ? currentSession.userId
        : `token:${crypto
            .createHmac('sha256', getMasterKey())
            .update(cleanedToken)
            .digest('hex')
            .slice(0, 24)}`;

      const studentName = verifiedUser?.short_name || verifiedUser?.name || 'Student';
      const studentEmail =
        verifiedUser?.primary_email || verifiedUser?.login_id || `${studentName.toLowerCase().replace(/\s+/g, '.')}@canvas`;

      clearUserCache(tokenUserId);
      await setUserCredentials(tokenUserId, {
        canvasBaseUrl: validatedUrl,
        canvasApiToken: cleanedToken,
        persistMode,
        studentName,
      });

      const { signedCookie, sessionData } = await createSession({
        sub: tokenUserId,
        email: studentEmail,
        name: studentName,
        authProvider: 'canvas-token-vault',
      });

      return sendJson(
        200,
        {
          ok: true,
          user: sessionData,
          canvasBaseUrl: validatedUrl,
          maskedToken: maskToken(cleanedToken),
          studentName,
        },
        {
          'Set-Cookie': sessionCookieHeader(req, signedCookie, SESSION_TTL_MS / 1000),
        }
      );
    }

    // Legacy / Email + Passphrase Login Support
    if ((pathname === '/api/auth/login' || pathname === '/api/auth/local-login') && method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim() || email.split('@')[0] || 'Student';
      const passphrase = String(body.passphrase || body.password || '');

      const profile = await authenticateOrRegisterUser(email, passphrase, name);
      const { signedCookie, sessionData } = await createSession(profile);

      return sendJson(
        200,
        { ok: true, user: sessionData },
        {
          'Set-Cookie': sessionCookieHeader(req, signedCookie, SESSION_TTL_MS / 1000),
        }
      );
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (currentSession) {
        clearUserCache(currentSession.userId);
        const creds = await getUserCredentials(currentSession.userId);
        if (creds && creds.persistMode === 'memory') {
          memoryVault.delete(currentSession.userId);
        }
        await deleteSession(currentSession.sessionId);
      }
      return sendJson(
        200,
        { ok: true },
        {
          'Set-Cookie': sessionCookieHeader(req, '', 0),
        }
      );
    }

    // -----------------------------------------------------------------------
    // C. All routes below require an authenticated user session
    // -----------------------------------------------------------------------
    if (!currentSession) {
      return sendJson(401, {
        error: 'Authentication required. Paste your Canvas token to connect.',
        code: 'UNAUTHENTICATED',
      });
    }

    const userId = currentSession.userId;

    if (pathname === '/api/user/credentials' && method === 'POST') {
      const body = await readJsonBody(req);
      let rawUrl = body.canvasBaseUrl || 'https://wcpss.instructure.com';
      let rawToken = body.canvasApiToken || '';
      const requestedMode = body.persistMode ?? 'encrypted_disk';
      if (!['encrypted_disk', 'memory'].includes(requestedMode)) {
        return sendJson(400, { error: 'Invalid persistMode.' });
      }
      if (PERSISTENCE === 'postgres' && requestedMode === 'memory') {
        return sendJson(400, {
          error: 'Memory-only credentials are unavailable with durable server storage.',
        });
      }
      const persistMode = requestedMode;

      if (body.envFileContent && typeof body.envFileContent === 'string') {
        const parsedEnv = parseEnvString(body.envFileContent);
        if (parsedEnv.CANVAS_BASE_URL) rawUrl = parsedEnv.CANVAS_BASE_URL;
        if (parsedEnv.CANVAS_API_TOKEN) rawToken = parsedEnv.CANVAS_API_TOKEN;
      }

      if (body.importWorkspaceEnv === true) {
        if (!isLoopbackRequest(req)) {
          return sendJson(403, { error: 'Workspace .env import is only allowed on localhost.' });
        }
        rawUrl = process.env.CANVAS_BASE_URL || 'https://wcpss.instructure.com';
        rawToken = process.env.CANVAS_API_TOKEN || '';
      }

      const validatedUrl = normalizeAndValidateCanvasUrl(rawUrl);
      const cleanedToken = String(rawToken || '').trim().replace(/^["']|["']$/g, '');
      if (!cleanedToken || cleanedToken.length < 12) {
        return sendJson(400, { error: 'Please provide a valid Canvas API token.' });
      }

      let verifiedUser = null;
      if (body.verifyWithCanvas !== false) {
        try {
          const verifyRes = await fetchCanvas(`${validatedUrl}/api/v1/users/self`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${cleanedToken}`,
              Accept: 'application/json',
              'User-Agent': 'Atelier-Canvas/4.0',
            },
          });
          if (!verifyRes.ok) {
            return sendJson(400, {
              error: `Canvas rejected this token (HTTP ${verifyRes.status}).`,
            });
          }
          verifiedUser = await verifyRes.json();
        } catch (err) {
          const status = Number.isInteger(err.status) && err.status >= 500 ? err.status : 400;
          return sendJson(status, {
            error: status >= 500 ? err.message : `Could not reach ${validatedUrl}.`,
          });
        }
      }

      clearUserCache(userId);
      await setUserCredentials(userId, {
        canvasBaseUrl: validatedUrl,
        canvasApiToken: cleanedToken,
        persistMode,
        studentName: verifiedUser?.short_name || verifiedUser?.name || currentSession.name,
      });

      return sendJson(200, {
        ok: true,
        canvasBaseUrl: validatedUrl,
        maskedToken: maskToken(cleanedToken),
        persistMode,
        canvasProfileName: verifiedUser?.name || null,
      });
    }

    if (pathname === '/api/user/credentials' && method === 'DELETE') {
      clearUserCache(userId);
      await deleteUserCredentials(userId);
      return sendJson(200, {
        ok: true,
        message: 'Your token and cached data have been wiped.',
      });
    }

    // -----------------------------------------------------------------------
    // D. Authenticated Per-User Canvas Proxy Endpoints
    // -----------------------------------------------------------------------
    const creds = await getUserCredentials(userId);

    if (pathname === '/api/config') {
      return sendJson(200, {
        canvasBaseUrl: creds ? creds.canvasBaseUrl : null,
        tokenConfigured: Boolean(creds && creds.canvasBaseUrl && creds.canvasApiToken),
        maskedToken: creds ? maskToken(creds.canvasApiToken) : null,
        persistMode: creds ? creds.persistMode : null,
        cacheTtlSeconds: CACHE_TTL_MS / 1000,
      });
    }

    if (!creds || !creds.canvasBaseUrl || !creds.canvasApiToken) {
      return sendJson(428, {
        error: 'Canvas API token not configured yet.',
        code: 'TOKEN_REQUIRED',
      });
    }

    // 1. Active courses: GET /api/v1/courses?enrollment_state=active
    if (pathname === '/api/v1/courses') {
      const enrollmentState = parsed.searchParams.get('enrollment_state') || 'active';
      const endpoint = `/api/v1/courses?enrollment_state=${encodeURIComponent(
        enrollmentState
      )}&include[]=term&include[]=favorites&include[]=teachers&include[]=sections&include[]=total_scores&include[]=syllabus_body&per_page=50`;
      const result = await fetchUserCanvasApi(userId, creds, endpoint, forceRefresh);
      const validCourses = Array.isArray(result.data)
        ? result.data
            .filter((c) => c && c.name && !c.access_restricted_by_date)
            .map((c) => ({
              ...c,
              syllabus_summary: c.syllabus_body
                ? stripHtmlServer(c.syllabus_body).slice(0, 1200)
                : '',
            }))
        : [];
      return sendJson(200, validCourses, {
        'X-Cache-Hit': result.cached ? 'true' : 'false',
        'X-Data-Source': result.source || 'canvas',
      });
    }

    // 2. Upcoming events: GET /api/v1/users/self/upcoming_events
    if (pathname === '/api/v1/users/self/upcoming_events') {
      const endpoint = '/api/v1/users/self/upcoming_events';
      const result = await fetchUserCanvasApi(userId, creds, endpoint, forceRefresh);
      return sendJson(200, Array.isArray(result.data) ? result.data : [], {
        'X-Cache-Hit': result.cached ? 'true' : 'false',
        'X-Data-Source': result.source || 'canvas',
      });
    }

    // 3. Course assignments (enriched with assignment_groups & created/updated context): GET /api/v1/courses/:id/assignments
    const assignMatch = pathname.match(/^\/api\/v1\/courses\/([^/]+)\/assignments$/);
    if (assignMatch) {
      const courseId = assignMatch[1];
      if (!/^\d+$/.test(courseId)) {
        return sendJson(400, { error: 'Invalid course ID.' });
      }
      const bucket = parsed.searchParams.get('bucket') || '';
      const bucketParam = bucket ? `&bucket=${encodeURIComponent(bucket)}` : '';
      const assignEndpoint = `/api/v1/courses/${encodeURIComponent(
        courseId
      )}/assignments?per_page=100&order_by=due_at&include[]=submission${bucketParam}`;
      const groupsEndpoint = `/api/v1/courses/${encodeURIComponent(
        courseId
      )}/assignment_groups?per_page=50`;

      const [result, groupsRes] = await Promise.all([
        fetchUserCanvasApi(userId, creds, assignEndpoint, forceRefresh),
        fetchUserCanvasApi(userId, creds, groupsEndpoint, forceRefresh),
      ]);

      const groupMap = new Map();
      if (Array.isArray(groupsRes.data)) {
        for (const g of groupsRes.data) {
          if (g && g.id && g.name) {
            groupMap.set(String(g.id), g.name);
          }
        }
      }

      const normalized = Array.isArray(result.data)
        ? result.data.map((a) => normalizeCanvasAssignment(a, groupMap)).filter(Boolean)
        : [];
      return sendJson(200, normalized, {
        'X-Cache-Hit': result.cached ? 'true' : 'false',
        'X-Data-Source': result.source || 'canvas',
      });
    }

    // 3b. Course modules & assignment groups context: GET /api/v1/courses/:id/context
    const contextMatch = pathname.match(/^\/api\/v1\/courses\/([^/]+)\/context$/);
    if (contextMatch) {
      const courseId = contextMatch[1];
      if (!/^\d+$/.test(courseId)) {
        return sendJson(400, { error: 'Invalid course ID.' });
      }
      const modulesEndpoint = `/api/v1/courses/${encodeURIComponent(
        courseId
      )}/modules?include[]=items&per_page=50`;
      const groupsEndpoint = `/api/v1/courses/${encodeURIComponent(
        courseId
      )}/assignment_groups?per_page=50`;

      const [modRes, grpRes] = await Promise.all([
        fetchUserCanvasApi(userId, creds, modulesEndpoint, forceRefresh),
        fetchUserCanvasApi(userId, creds, groupsEndpoint, forceRefresh),
      ]);

      const modules = Array.isArray(modRes.data)
        ? modRes.data.map((m) => ({
            id: m.id,
            name: m.name,
            state: m.state || null,
            items_count: m.items_count || (Array.isArray(m.items) ? m.items.length : 0),
            items: Array.isArray(m.items)
              ? m.items.slice(0, 18).map((it) => ({
                  id: it.id,
                  title: it.title,
                  type: it.type,
                  html_url: it.html_url || it.url || '',
                }))
              : [],
          }))
        : [];

      const groups = Array.isArray(grpRes.data)
        ? grpRes.data.map((g) => ({
            id: g.id,
            name: g.name,
            group_weight: g.group_weight || 0,
            rules: g.rules || {},
          }))
        : [];

      return sendJson(200, { course_id: Number(courseId), modules, groups });
    }

    // 3c. Direct Assignment Submission to Canvas: POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions
    const submitMatch = pathname.match(/^\/api\/v1\/courses\/([^/]+)\/assignments\/([^/]+)\/submissions$/);
    if (submitMatch && method === 'POST') {
      const courseId = submitMatch[1];
      const assignmentId = submitMatch[2];
      if (!/^\d+$/.test(courseId) || !/^\d+$/.test(assignmentId)) {
        return sendJson(400, { error: 'Invalid course or assignment ID.' });
      }

      const body = await readJsonBody(req);
      const submissionType = body.submission_type || 'online_url';
      if (!['online_url', 'online_text_entry', 'online_upload'].includes(submissionType)) {
        return sendJson(400, { error: 'Unsupported submission type.' });
      }

      const payload = {
        submission: {
          submission_type: submissionType,
        },
      };

      if (submissionType === 'online_url') {
        const urlStr = String(body.url || '').trim();
        if (!urlStr || !/^https?:\/\//i.test(urlStr)) {
          return sendJson(400, { error: 'Please enter a valid link starting with https://' });
        }
        payload.submission.url = urlStr;
      } else if (submissionType === 'online_text_entry') {
        const textStr = String(body.body || '').trim();
        if (!textStr) {
          return sendJson(400, { error: 'Submission text cannot be empty.' });
        }
        payload.submission.body = textStr;
      } else if (submissionType === 'online_upload') {
        if (!Array.isArray(body.file_ids) || body.file_ids.length === 0) {
          return sendJson(400, { error: 'No uploaded file IDs provided.' });
        }
        payload.submission.file_ids = body.file_ids;
      }

      const targetUrl = `${creds.canvasBaseUrl}/api/v1/courses/${encodeURIComponent(
        courseId
      )}/assignments/${encodeURIComponent(assignmentId)}/submissions`;

      const canvasRes = await fetchCanvas(targetUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.canvasApiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Atelier-Canvas/4.0',
        },
        body: JSON.stringify(payload),
      });

      if (!canvasRes.ok) {
        return sendJson(canvasRes.status, {
          error: `Canvas submission failed (HTTP ${canvasRes.status}).`,
        });
      }

      const submissionData = await canvasRes.json();
      clearUserCache(userId);

      return sendJson(200, {
        success: true,
        submission: submissionData,
        message: 'Assignment submitted directly to Canvas!',
      });
    }

    // 3d. File upload handshake for assignment submission: POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions/self/files
    const fileUploadMatch = pathname.match(/^\/api\/v1\/courses\/([^/]+)\/assignments\/([^/]+)\/submissions\/self\/files$/);
    if (fileUploadMatch && method === 'POST') {
      const courseId = fileUploadMatch[1];
      const assignmentId = fileUploadMatch[2];
      const body = await readJsonBody(req);

      const targetUrl = `${creds.canvasBaseUrl}/api/v1/courses/${encodeURIComponent(
        courseId
      )}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`;

      const canvasRes = await fetchCanvas(targetUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.canvasApiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Atelier-Canvas/4.0',
        },
        body: JSON.stringify(body),
      });

      if (!canvasRes.ok) {
        return sendJson(canvasRes.status, {
          error: `Canvas file-upload handshake failed (HTTP ${canvasRes.status}).`,
        });
      }
      const data = await canvasRes.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return sendJson(502, { error: 'Canvas returned an invalid file-upload response.' });
      }
      return sendJson(canvasRes.status, data);
    }

    // 4. All Teacher Announcements + Smart Summaries: GET /api/v1/announcements
    if (pathname === '/api/v1/announcements' || pathname === '/api/v1/notifications') {
      const combinedEndpoint = '/api/v1/announcements_combined_v4';
      const cacheKey = makeUserCacheKey(userId, creds.canvasBaseUrl, creds.canvasApiToken, combinedEndpoint);
      if (!forceRefresh) {
        const cached = getCached(cacheKey);
        if (cached) {
          return sendJson(200, cached.data, {
            'X-Cache-Hit': 'true',
            'X-Data-Source': cached.source || 'canvas',
          });
        }
      }

      const coursesRes = await fetchUserCanvasApi(
        userId,
        creds,
        '/api/v1/courses?enrollment_state=active&per_page=50',
        forceRefresh
      );
      const activeCourses = Array.isArray(coursesRes.data)
        ? coursesRes.data.filter((c) => c && c.id && c.name)
        : [];

      let announcements = [];
      let sourceSucceeded = false;
      let sourceError = null;
      if (activeCourses.length > 0) {
        const query = new URLSearchParams();
        activeCourses.slice(0, 15).forEach((course) => {
          query.append('context_codes[]', `course_${course.id}`);
        });
        const now = new Date();
        const startDate = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
        const endDate = new Date(Date.UTC(now.getUTCFullYear() + 2, 11, 31, 23, 59, 59));
        query.set('start_date', startDate.toISOString());
        query.set('end_date', endDate.toISOString());
        query.set('per_page', '100');
        const annEndpoint = `/api/v1/announcements?${query.toString()}`;
        try {
          const annRes = await fetchUserCanvasApi(userId, creds, annEndpoint, forceRefresh);
          if (!Array.isArray(annRes.data)) {
            const error = new Error('Canvas returned an invalid announcements response.');
            error.status = 502;
            throw error;
          }
          announcements = annRes.data.map(summarizeAnnouncementServer);
          sourceSucceeded = true;
        } catch (error) {
          sourceError = error;
          console.warn('Canvas announcements query failed:', error.message);
        }
      }

      if (!sourceSucceeded || announcements.length === 0) {
        try {
          const streamRes = await fetchUserCanvasApi(
            userId,
            creds,
            '/api/v1/users/self/activity_stream?only_active_courses=true&per_page=40',
            forceRefresh
          );
          if (!Array.isArray(streamRes.data)) {
            const error = new Error('Canvas returned an invalid activity-stream response.');
            error.status = 502;
            throw error;
          }
          announcements = streamRes.data
            .filter(
              (item) =>
                item.type === 'Announcement' ||
                item.type === 'Message' ||
                item.type === 'DiscussionTopic'
            )
            .map((item) =>
              summarizeAnnouncementServer({
                id: item.id,
                title: item.title || 'Course Update',
                message: item.message || '',
                posted_at: item.created_at || item.updated_at,
                context_code:
                  item.context_type === 'Course' && item.course_id ? `course_${item.course_id}` : '',
                read_state: item.read_state === false ? 'unread' : item.read_state || 'unread',
                html_url: item.html_url || creds.canvasBaseUrl,
              })
            );
          sourceSucceeded = true;
        } catch (error) {
          sourceError = sourceError || error;
          console.warn('Canvas activity-stream query failed:', error.message);
        }
      }

      if (!sourceSucceeded) {
        throw sourceError || new Error('Canvas announcements are unavailable.');
      }

      const saved = setCached(cacheKey, userId, announcements, 'canvas');
      return sendJson(200, saved.data, {
        'X-Cache-Hit': 'false',
        'X-Data-Source': 'canvas',
      });
    }

    // 5. Dynamic per-user iCal (.ics) feed generator
    if (pathname === '/api/calendar.ics') {
      res.writeHead(200, {
        ...getSecurityHeaders(true, originHeader),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="canvas-upcoming-deadlines.ics"',
      });
      const events = [];
      const cutoffMs = Date.now() - 7 * 24 * 3600 * 1000;
      for (const [k, v] of apiCache.entries()) {
        if (v.userId === userId && k.includes('/assignments') && Array.isArray(v.data)) {
          for (const item of v.data) {
            if (item && item.due_at && new Date(item.due_at).getTime() >= cutoffMs) {
              events.push(item);
            }
          }
        }
      }
      const formatIcsDate = (iso) => {
        const d = new Date(iso);
        return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      };
      const escapeIcs = (str) =>
        String(str || '')
          .replace(/\\/g, '\\\\')
          .replace(/;/g, '\\;')
          .replace(/,/g, '\\,')
          .replace(/\r?\n/g, '\\n');

      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Slated//School Dashboard v4.5//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Slated Schedule & Deadlines',
        'X-WR-TIMEZONE:America/New_York',
      ];
      for (const ev of events) {
        if (!ev || !ev.due_at) continue;
        const dueDate = new Date(ev.due_at);
        const startDate = new Date(dueDate.getTime() - 45 * 60 * 1000);
        const dtStart = formatIcsDate(startDate.toISOString());
        const dtEnd = formatIcsDate(dueDate.toISOString());
        const summary = escapeIcs(ev.name || 'Assignment');
        const desc = escapeIcs(`Course Assignment\nURL: ${ev.html_url || creds.canvasBaseUrl}\nManaged via Slated`);
        lines.push(
          'BEGIN:VEVENT',
          `UID:slated-assignment-${ev.id}@slated.app`,
          `DTSTAMP:${formatIcsDate(new Date().toISOString())}`,
          `DTSTART:${dtStart}`,
          `DTEND:${dtEnd}`,
          `SUMMARY:${summary}`,
          `DESCRIPTION:${desc}`,
          `URL:${ev.html_url || creds.canvasBaseUrl}`,
          'STATUS:CONFIRMED',
          'END:VEVENT'
        );
      }
      lines.push('END:VCALENDAR');
      return res.end(lines.join('\r\n'));
    }

        // 6. Curated Class Resources, Textbooks & Keys: GET /api/v1/resources
    if (pathname === '/api/v1/resources' && method === 'GET') {
      const baseUrl = creds ? creds.canvasBaseUrl : 'https://wcpss.instructure.com';
      return sendJson(200, getCuratedCourseResources(baseUrl));
    }

    // 7. AP World Conder Official Pacing Calendar: GET /api/v1/pacing-calendar
    if (pathname === '/api/v1/pacing-calendar' && method === 'GET') {
      return sendJson(200, CONDER_PACING_CALENDAR);
    }

    return sendJson(404, { error: `Unknown API route: ${pathname}` });
  } catch (err) {
    const status =
      Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    if (status >= 500) console.error(`API request failed (${status}):`, err.message);
    return sendJson(status, {
      error: status >= 500 ? 'Internal Server Error' : err.message || 'Request failed',
    });
  }
}

// ---------------------------------------------------------------------------
// Curated Course Resources & Official Conder Pacing Calendars
// ---------------------------------------------------------------------------
const CONDER_PACING_CALENDAR = {
  month: 'November 2026',
  course_id: '1414245',
  course_title: 'AP World History: Modern - Conder',
  pdf_download_url: 'https://wcpss.instructure.com/courses/1414245/files/120626470/download?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c',
  pdf_filename: 'AP_World_November_Reading_Calendar.pdf',
  milestones: [
    { date: '2026-11-02', day_type: 'B Day', label: 'Quiz: Chapter 22', detail: 'Transoceanic Encounters & Global Connections', reading: 'Read Ch. 24, pp. 543–549', reading_chapter: 24, is_assessment: true },
    { date: '2026-11-03', day_type: 'No School', label: 'Teacher Workday — No School', detail: 'Campus closed for election / planning', reading: null, is_holiday: true },
    { date: '2026-11-04', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Colonial Latin America & Encomienda Labor', reading: 'Read Ch. 24, pp. 550–557', reading_chapter: 24 },
    { date: '2026-11-05', day_type: 'B Day', label: 'Pre-SAT Testing / Class', detail: 'North American Settler Colonies', reading: 'Read Ch. 24, pp. 550–557', reading_chapter: 24 },
    { date: '2026-11-06', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'African States & Songhai Empire', reading: 'Read Ch. 25, pp. 562–568', reading_chapter: 25 },
    { date: '2026-11-09', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'Kingdom of Kongo & Atlantic Slave Trade', reading: 'Read Ch. 25, pp. 562–568', reading_chapter: 25 },
    { date: '2026-11-10', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Middle Passage & Plantation Societies', reading: 'Read Ch. 25, pp. 569–575', reading_chapter: 25 },
    { date: '2026-11-11', day_type: 'No School', label: 'Veterans Day — No School', detail: 'National Holiday', reading: null, is_holiday: true },
    { date: '2026-11-12', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'African Diaspora & Resistance', reading: 'Read Ch. 25, pp. 569–575', reading_chapter: 25 },
    { date: '2026-11-13', day_type: 'A Day', label: 'Quiz: Chapter 24', detail: 'New Worlds: Americas & Oceania', reading: 'Read Ch. 25, pp. 576–582', reading_chapter: 25, is_assessment: true },
    { date: '2026-11-16', day_type: 'B Day', label: 'Quiz: Chapter 24', detail: 'New Worlds: Americas & Oceania', reading: 'Read Ch. 25, pp. 576–582', reading_chapter: 25, is_assessment: true },
    { date: '2026-11-17', day_type: 'A Day', label: 'Class Pacing Milestone', detail: 'Reformation & Sovereign States', reading: 'Read Ch. 23 (pp. 521–524) & Ch. 26 (pp. 593–594)', reading_chapter: 23 },
    { date: '2026-11-18', day_type: 'B Day', label: 'Class Pacing Milestone', detail: 'Reformation & Ming/Qing Governance', reading: 'Read Ch. 23 (pp. 521–524) & Ch. 26 (pp. 593–594)', reading_chapter: 23 },
    { date: '2026-11-19', day_type: 'A Day', label: 'Quiz: Chapter 25', detail: 'Africa & The Atlantic World', reading: 'Reread Ch. 22, pp. 499–503', reading_chapter: 22, is_assessment: true },
    { date: '2026-11-20', day_type: 'B Day', label: 'Quiz: Chapter 25', detail: 'Africa & The Atlantic World', reading: 'Reread Ch. 22, pp. 499–503', reading_chapter: 22, is_assessment: true },
    { date: '2026-11-23', day_type: 'A Day', label: 'Unit 4 Review Milestone', detail: 'Synthesize Columbian Exchange, Maritime Empires & Labor Systems', reading: 'Review Ch. 22/24/25 RTN notes' },
    { date: '2026-11-24', day_type: 'B Day', label: 'Unit 4 Review Milestone', detail: 'Synthesize Columbian Exchange, Maritime Empires & Labor Systems', reading: 'Review Ch. 22/24/25 RTN notes' },
    { date: '2026-11-25', day_type: 'No School', label: 'School Vacation — No School', detail: 'Thanksgiving Break', reading: null, is_holiday: true },
    { date: '2026-11-26', day_type: 'No School', label: 'Thanksgiving Day — No School', detail: 'Thanksgiving Holiday', reading: null, is_holiday: true },
    { date: '2026-11-27', day_type: 'No School', label: 'Holiday — No School', detail: 'Thanksgiving Break', reading: null, is_holiday: true },
    { date: '2026-11-30', day_type: 'A Day', label: 'UNIT 4 MAJOR ASSESSMENT (TEST)', detail: 'Transoceanic Connections (1450–1750) — Full Unit Exam', reading: 'Read Ch. 27, pp. 610–616', reading_chapter: 27, is_assessment: true, is_major: true }
  ]
};

function getCuratedCourseResources(canvasBaseUrl = 'https://wcpss.instructure.com') {
  const base = String(canvasBaseUrl || 'https://wcpss.instructure.com').replace(/\/+$/, '');
  return [
    {
      id: 'res_world_ch22',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 22 — Transoceanic Encounters & Global Connections',
      format: 'pdf',
      size_label: '18.4 MB',
      description: 'Bentley & Ziegler Traditions & Encounters. European exploration, navigational tech, Indian Ocean trade networks, and early colonial outposts.',
      download_url: `${base}/courses/1414245/files/120579661/download?verifier=fa94ae2d-09a9-4fc2-a5d6-7cc34b3e4573`,
      preview_url: `${base}/courses/1414245/files/120579661?verifier=fa94ae2d-09a9-4fc2-a5d6-7cc34b3e4573&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch23',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 23 — The Transformation of Europe',
      format: 'pdf',
      size_label: '16.8 MB',
      description: 'The Protestant Reformation, Catholic Counter-Reformation, consolidation of sovereign states, and early capitalism.',
      download_url: `${base}/courses/1414245/files/120579738/download?verifier=5d31f8de-df04-4948-9bf1-d72a85160f85`,
      preview_url: `${base}/courses/1414245/files/120579738?verifier=5d31f8de-df04-4948-9bf1-d72a85160f85&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch24',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 24 — New Worlds: The Americas and Oceania',
      format: 'pdf',
      size_label: '19.1 MB',
      description: 'The Spanish Caribbean conquest, conquest of Mexico & Peru, Iberian colonial societies, North American settler colonies, and encomienda labor.',
      download_url: `${base}/courses/1414245/files/120579765/download?verifier=63a9142a-e704-43bc-ba29-8d0c44fc0d00`,
      preview_url: `${base}/courses/1414245/files/120579765?verifier=63a9142a-e704-43bc-ba29-8d0c44fc0d00&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch25',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 25 — Africa and the Atlantic World',
      format: 'pdf',
      size_label: '17.5 MB',
      description: 'Songhai Empire, Kingdom of Kongo, the transatlantic slave trade, Middle Passage, plantation societies, and African diaspora cultures.',
      download_url: `${base}/courses/1414245/files/120579798/download?verifier=73416055-b327-444c-9065-10a31d8b7a63`,
      preview_url: `${base}/courses/1414245/files/120579798?verifier=73416055-b327-444c-9065-10a31d8b7a63&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch26',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 26 — Tradition and Change in East Asia',
      format: 'pdf',
      size_label: '15.9 MB',
      description: 'Ming and Qing dynasties, the civil service examination system, neo-Confucianism, Tokugawa Shogunate, and Japanese isolationism (sakoku).',
      download_url: `${base}/courses/1414245/files/120579854/download?verifier=fffa531d-e61f-498c-a517-bd5604ce81fb`,
      preview_url: `${base}/courses/1414245/files/120579854?verifier=fffa531d-e61f-498c-a517-bd5604ce81fb&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 (1450–1750)'
    },
    {
      id: 'res_world_ch27',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 27 — The Islamic Empires',
      format: 'pdf',
      size_label: '16.3 MB',
      description: 'Formation of the Ottoman, Safavid, and Mughal Gunpowder Empires, religious policies, devshirme, and cultural synthesis.',
      download_url: `${base}/courses/1414245/files/120579898/download?verifier=701d21a6-927e-4fe2-8a3c-b6ddb97121d2`,
      preview_url: `${base}/courses/1414245/files/120579898?verifier=701d21a6-927e-4fe2-8a3c-b6ddb97121d2&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 3/4 (1450–1750)'
    },
    {
      id: 'res_world_ch13',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'textbooks',
      title: 'Chapter 13 — The Resurgence of Empire in East Asia',
      format: 'pdf',
      size_label: '14.7 MB',
      description: 'Restoration of centralized imperial rule in China under the Sui, Tang, and Song dynasties. Agricultural development, tech innovations, and East Asian influence.',
      download_url: `${base}/courses/1414245/files/118257198/download?verifier=ad6e5e07-27cd-47e7-aeef-87724765ad7a`,
      preview_url: `${base}/courses/1414245/files/118257198?verifier=ad6e5e07-27cd-47e7-aeef-87724765ad7a&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 1 (1200–1450)'
    },
    {
      id: 'res_world_cal_nov',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official November Reading & Pacing Calendar (Unit 4)',
      format: 'pdf',
      size_label: '19.7 KB',
      description: 'Official day-by-day A/B calendar detailing daily reading page targets (Ch. 24, 25, 23, 26, 27), Chapter 22/24/25 quizzes, and the Unit 4 Test on Nov 30.',
      download_url: `${base}/courses/1414245/files/120626470/download?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c`,
      preview_url: `${base}/courses/1414245/files/120626470?verifier=e0b3aeb3-0bd3-4db2-8126-909d5758396c&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 4 Pacing'
    },
    {
      id: 'res_world_cal_oct',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official October Reading Calendar (Units 2 & 3)',
      format: 'pdf',
      size_label: '21.4 KB',
      description: 'October reading pacing calendar covering Mongol integration, Islamic realm expansion, and maritime trade milestones.',
      download_url: `${base}/courses/1414245/files/120597493/download?verifier=5c9b3fb7-91e6-4e40-bea6-2b871e95894c`,
      preview_url: `${base}/courses/1414245/files/120597493?verifier=5c9b3fb7-91e6-4e40-bea6-2b871e95894c&wrap=1`,
      instructor: 'David Conder',
      unit: 'Units 2–3 Pacing'
    },
    {
      id: 'res_world_cal_dec',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'calendars',
      title: 'Official December Reading & Semester Final Calendar',
      format: 'pdf',
      size_label: '18.9 KB',
      description: 'December reading pacing calendar detailing semester wrap-up, Gunpowder Empires review, and fall final exam preparation.',
      download_url: `${base}/courses/1414245/files/120626491/download?verifier=e0472fa3-0844-4321-9c27-1d23fdfede34`,
      preview_url: `${base}/courses/1414245/files/120626491?verifier=e0472fa3-0844-4321-9c27-1d23fdfede34&wrap=1`,
      instructor: 'David Conder',
      unit: 'Semester 1 Wrap-up'
    },
    {
      id: 'res_world_syllabus',
      course_id: '1414245',
      course_name: 'P1 - AP World History: Modern - Conder',
      category: 'syllabus',
      title: 'AP World History: Modern — Official Course Syllabus',
      format: 'pdf',
      size_label: '245 KB',
      description: 'Official syllabus: contact info (dconder@wcpss.net, 919-856-7918), grading weighting, minor assessment retest policies, and AP exam expectations.',
      download_url: `${base}/courses/1414245/files/119787734/download?verifier=bab3e9b9-1f6d-40b2-a996-1fa49087eb77`,
      preview_url: `${base}/courses/1414245/files/119787734?verifier=bab3e9b9-1f6d-40b2-a996-1fa49087eb77&wrap=1`,
      instructor: 'David Conder',
      unit: 'Course Policy'
    },
    {
      id: 'res_calc_log_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Logarithmic Differentiation — 5 Practice Problems & Solutions Key',
      format: 'docx',
      size_label: '48.2 KB',
      description: 'Official solution key for logarithmic differentiation problems with corrected superscripts, step-by-step natural log applications, and product rule expansions.',
      download_url: `${base}/courses/1414714/files/122488345/download?verifier=eb98b628-f699-4106-a3d9-749ad19bd1d3`,
      preview_url: `${base}/courses/1414714/files/122488345?verifier=eb98b628-f699-4106-a3d9-749ad19bd1d3&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 3 Differentiation'
    },
    {
      id: 'res_calc_implicit_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Implicit Differentiation — Solution Key & Student Workspace',
      format: 'docx',
      size_label: '42.6 KB',
      description: 'Official solution key and printable workspace for implicit differentiation problems, tangent lines, and higher-order implicit derivatives.',
      download_url: `${base}/courses/1414714/files/122453485/download?verifier=74547806-3033-48ff-81c1-25c55c6dc6a4`,
      preview_url: `${base}/courses/1414714/files/122453485?verifier=74547806-3033-48ff-81c1-25c55c6dc6a4&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 3 Differentiation'
    },
    {
      id: 'res_calc_packet_key',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'Derivative Rules Master Solution Key & Practice Packet',
      format: 'docx',
      size_label: '56.1 KB',
      description: 'Comprehensive solutions packet covering Power Rule, Product Rule, Quotient Rule, Chain Rule, Exponential, and 6 Trigonometric functions.',
      download_url: `${base}/courses/1414714/files/120774035/download?verifier=12bbb7d3-b274-4b40-b0a2-043aa55b5a8e`,
      preview_url: `${base}/courses/1414714/files/120774035?verifier=12bbb7d3-b274-4b40-b0a2-043aa55b5a8e&wrap=1`,
      instructor: 'William Potter',
      unit: 'Unit 2/3 Rules'
    },
    {
      id: 'res_calc_mock_final',
      course_id: '1414714',
      course_name: 'P2 - AP Calculus AB - Potter',
      category: 'keys',
      title: 'AP Calculus AB Derivative Practice & Curve Sketching Mock Test',
      format: 'docx',
      size_label: '64.8 KB',
      description: '10 comprehensive test-prep problems: 5 curve sketching, 3 limit definition of derivative (f(x+h) - f(x))/h, and tangent line equations.',
      download_url: `${base}/courses/1414714/files/120071840/download?verifier=2d09db0c-6fe3-44fd-847b-02b464049df8`,
      preview_url: `${base}/courses/1414714/files/120071840?verifier=2d09db0c-6fe3-44fd-847b-02b464049df8&wrap=1`,
      instructor: 'William Potter',
      unit: 'Exam Prep'
    },
    {
      id: 'res_macro_unit1_guide',
      course_id: '1414258',
      course_name: 'P4 - AP Macroeconomics - Conder',
      category: 'keys',
      title: 'AP Macroeconomics Unit 1 Study Guide & Formula Summary',
      format: 'docx',
      size_label: '38.4 KB',
      description: 'Study guide covering scarcity, opportunity cost, Production Possibilities Curve (PPC), comparative vs. absolute advantage, and supply/demand equilibrium.',
      download_url: `${base}/courses/1414258/files/119338808/download?verifier=8f065c0c-86c2-4c70-8671-dc2e9a27db78`,
      preview_url: `${base}/courses/1414258/files/119338808?verifier=8f065c0c-86c2-4c70-8671-dc2e9a27db78&wrap=1`,
      instructor: 'David Conder',
      unit: 'Unit 1 Basic Economic Concepts'
    },
    {
      id: 'res_macro_multipliers_sheet',
      course_id: '1414258',
      course_name: 'P4 - AP Macroeconomics - Conder',
      category: 'reference',
      title: 'Propensities, Multipliers & AD/AS Formula Sheet',
      format: 'link',
      size_label: 'Web Tool',
      description: 'ReviewEcon interactive multipliers guide: Marginal Propensity to Consume (MPC), MPS, Spending Multiplier (1/MPS), Tax Multiplier (-MPC/MPS), and Aggregate Demand.',
      download_url: `https://www.reviewecon.com/propensities-and-multipliers`,
      preview_url: `https://www.reviewecon.com/propensities-and-multipliers`,
      instructor: 'David Conder',
      unit: 'Unit 3 National Income & Price Determination'
    },
    {
      id: 'res_chem_ref_tables',
      course_id: '1414296',
      course_name: 'P1 - Chemistry Honors - Gollihue',
      category: 'reference',
      title: 'North Carolina Chemistry Reference Tables & Formulas',
      format: 'pdf',
      size_label: '840 KB',
      description: 'Periodic Table of the Elements, Polyatomic Ions, Solubility Rules, Specific Heat Values, Vapor Pressure of Water, and Gas Law Formulas.',
      download_url: `https://www.dpi.nc.gov/chemistry-reference-tables/download`,
      preview_url: `https://www.dpi.nc.gov/chemistry-reference-tables/download`,
      instructor: 'Jessica Gollihue',
      unit: 'Reference'
    },
    {
      id: 'res_math_desmos',
      course_id: '1414714',
      course_name: 'General Academic Tools',
      category: 'reference',
      title: 'Desmos Graphing Calculator & Curve Analysis',
      format: 'link',
      size_label: 'Web App',
      description: 'Official Desmos graphing calculator for visualizing derivatives, tangents, curve intersections, and polar/parametric equations.',
      download_url: `https://student.desmos.com/`,
      preview_url: `https://student.desmos.com/`,
      instructor: 'All Teachers',
      unit: 'Interactive Math'
    }
  ];
}

function createApp() {
  const express = require('express');
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const sec = getSecurityHeaders(req.path.startsWith('/api'), req.headers.origin || '');
    for (const [k, v] of Object.entries(sec)) {
      res.setHeader(k, v);
    }
    next();
  });

  app.use('/api', (req, res, next) => {
    if (STORAGE_INITIALIZATION_ERROR) {
      return res.status(503).json({ error: 'Persistent storage is unavailable.' });
    }
    Promise.resolve(handleApiRequest(req, res)).catch(next);
  });

  app.use(express.static(path.join(__dirname, 'dist')));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('*', (req, res) => {
    const distIndex = path.join(__dirname, 'dist', 'index.html');
    res.sendFile(fs.existsSync(distIndex) ? distIndex : path.join(__dirname, 'src', 'site-shell.html'));
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('Unhandled request error:', err);
    const status =
      Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    if (req.path.startsWith('/api')) {
      return res.status(status).json({
        error: status >= 500 ? 'Internal Server Error' : err.message || 'Request failed',
      });
    }
    return res.status(status).send('Internal Server Error');
  });

  return app;
}

const app = createApp();

function startServer() {
  return app.listen(PORT, () => {
    console.log(`Slated running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  const server = startServer();
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; closing the server.`);
    const forceCloseTimer = setTimeout(() => {
      console.error('Graceful shutdown timed out; closing active connections.');
      server.closeAllConnections();
    }, 10000);
    forceCloseTimer.unref();
    server.close(async (error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        console.error('Could not close the HTTP server cleanly:', error.message);
        process.exitCode = 1;
      }
      try {
        const closeOperations = [CANVAS_HTTP_AGENT.close()];
        if (STORAGE) closeOperations.push(STORAGE.close());
        await Promise.all(closeOperations);
      } catch (closeError) {
        console.error('Could not close server resources cleanly:', closeError.message);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = Object.assign(app, {
  app,
  handleApiRequest,
  startServer,
  normalizeAndValidateCanvasUrl,
  encryptPayload,
  decryptPayload,
  authenticateOrRegisterUser,
  getCuratedCourseResources,
  CONDER_PACING_CALENDAR,
  normalizeCanvasAssignment,
  summarizeAnnouncementServer,
  stripHtmlServer,
});
