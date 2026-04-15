// ================================================================
//  مزاد باكج الأساطير — Railway / Node.js Express
//  Firebase Realtime Database
//
//  Environment Variables (.env أو Railway Variables):
//    FIREBASE_DATABASE_URL   e.g. https://YOUR-DB-default-rtdb.firebaseio.com
//    FIREBASE_API_KEY        Firebase Web API Key
//    BOT_TOKEN               Telegram Bot Token
//    ADMIN_IDS               comma-separated Telegram admin IDs
//    PORT                    (اختياري — Railway يحدده تلقائياً)
//
//  Routes:
//    GET  /health                    → server health check
//    GET  /tonconnect-manifest.json  → TON Connect manifest
//    POST /api                       → all app actions
// ================================================================

import express from 'express';
import crypto  from 'crypto';

const app = express();

// ── Config ────────────────────────────────────────────────────────
const CFG = {
  MIN_DEPOSIT_TON : 1,
  MIN_BID         : 0.1,
  AUCTION_DURATION: 3 * 24 * 60 * 60 * 1000,
  APP_NAME        : 'PandaBambooBot',
  APP_URL         : 'https://pandabambo.vercel.app',
  APP_ICON        : 'https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/87e9d1bd-c053-466a-a29e-40483a009e8f.png',
  APP_DESCRIPTION : 'Panda Bamboo Factory',
};

// ── Environment ───────────────────────────────────────────────────
const env = {
  get FIREBASE_DATABASE_URL() { return process.env.FIREBASE_DATABASE_URL; },
  get FIREBASE_API_KEY()      { return process.env.FIREBASE_API_KEY; },
  get BOT_TOKEN()             { return process.env.BOT_TOKEN; },
  get ADMIN_IDS()             { return process.env.ADMIN_IDS; },
};

// ── CORS middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data, X-Action');
  res.setHeader('Access-Control-Max-Age',       '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Body parser (32 KB limit) ─────────────────────────────────────
app.use(express.text({ limit: '32kb' }));

// ── Helpers ───────────────────────────────────────────────────────
const ok   = d  => ({ success: true,  data: d });
const fail = (m) => ({ success: false, error: m });

function sanitise(str) {
  if (!str) return str;
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/[<>]/g, m => m === '<' ? '&lt;' : '&gt;');
}

// ── Firebase helpers ──────────────────────────────────────────────
function fbUrl(path) {
  const base = env.FIREBASE_DATABASE_URL?.replace(/\/$/, '');
  if (!base) throw new Error('FIREBASE_DATABASE_URL not set');
  const key = env.FIREBASE_API_KEY;
  if (!key)  throw new Error('FIREBASE_API_KEY not set');
  return `${base}/${path.replace(/^\//, '')}.json?key=${key}`;
}

async function dbGet(path) {
  try {
    const r = await fetch(fbUrl(path));
    if (!r.ok) throw new Error(`GET ${r.status}`);
    return { success: true, data: await r.json() };
  } catch (e) {
    console.error('DB GET', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbSet(path, data) {
  try {
    const r = await fetch(fbUrl(path), {
      method : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`SET ${r.status}`);
    return { success: true };
  } catch (e) {
    console.error('DB SET', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbUpdate(path, updates) {
  try {
    const r = await fetch(fbUrl(path), {
      method : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(updates),
    });
    if (!r.ok) throw new Error(`UPDATE ${r.status}`);
    return { success: true };
  } catch (e) {
    console.error('DB UPDATE', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbPush(path, data) {
  try {
    const r = await fetch(fbUrl(path), {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`PUSH ${r.status}`);
    const j = await r.json();
    return { success: true, data: { id: j.name } };
  } catch (e) {
    console.error('DB PUSH', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbDelete(path) {
  try {
    const r = await fetch(fbUrl(path), { method: 'DELETE' });
    if (!r.ok) throw new Error(`DELETE ${r.status}`);
    return { success: true };
  } catch (e) {
    console.error('DB DELETE', path, e.message);
    return { success: false, error: e.message };
  }
}

// ── Rate limiter (per IP, 60 req/min) ────────────────────────────
const _rl = new Map();
function rateOk(ip) {
  const now = Date.now();
  const d   = _rl.get(ip) || { c: 0, r: now + 60000 };
  if (now > d.r) { d.c = 0; d.r = now + 60000; }
  d.c++;
  _rl.set(ip, d);
  return d.c <= 60;
}

// ── Telegram init data validation ─────────────────────────────────
async function validateTg(initData, botToken) {
  try {
    if (!initData) return { valid: false, error: 'No init data' };
    const p = new URLSearchParams(initData);
    if (!botToken) {
      const u = p.get('user');
      if (!u) return { valid: false, error: 'No user in initData' };
      return { valid: true, user: JSON.parse(decodeURIComponent(u)) };
    }
    const hash = p.get('hash');
    if (!hash) return { valid: false, error: 'No hash in initData' };
    p.delete('hash');
    const authDate = parseInt(p.get('auth_date') || '0');
    if (Date.now() / 1000 - authDate > 900) return { valid: false, error: 'initData expired' };
    const dc = [...p.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // Node.js crypto (بدل Web Crypto API)
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hex       = crypto.createHmac('sha256', secretKey).update(dc).digest('hex');

    if (hex !== hash) return { valid: false, error: 'Hash mismatch' };
    const u = p.get('user');
    if (!u) return { valid: false, error: 'No user' };
    return { valid: true, user: JSON.parse(decodeURIComponent(u)) };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── Telegram Bot notification ──────────────────────────────────────
async function sendTgMsg(chatId, text) {
  try {
    if (!env.BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('sendTgMsg:', e.message); }
}

// ── Get or init auction ────────────────────────────────────────────
async function getOrInitAuction() {
  const r = await dbGet('auction');
  if (r.data && r.data.endDate) return r.data;
  const auction = {
    endDate  : Date.now() + CFG.AUCTION_DURATION,
    startDate: Date.now(),
    status   : 'active',
    createdAt: Date.now(),
  };
  await dbSet('auction', auction);
  return auction;
}

// ── Get or init user ───────────────────────────────────────────────
async function getOrInitUser(uid, tg = {}) {
  const r = await dbGet(`users/${uid}`);
  if (r.data) {
    const updates = {};
    if (tg.first_name) updates.firstName = tg.first_name.slice(0, 64);
    if (tg.last_name)  updates.lastName  = tg.last_name.slice(0, 64);
    if (tg.username)   updates.username  = tg.username.slice(0, 64);
    if (tg.photo_url)  updates.photoUrl  = tg.photo_url.slice(0, 512);
    if (Object.keys(updates).length) await dbUpdate(`users/${uid}`, updates);
    return { ...r.data, ...updates };
  }
  const user = {
    userId      : uid,
    firstName   : (tg.first_name || '').slice(0, 64),
    lastName    : (tg.last_name  || '').slice(0, 64),
    username    : (tg.username   || '').slice(0, 64),
    photoUrl    : (tg.photo_url  || '').slice(0, 512),
    tonBalance  : 0,
    totalBid    : 0,
    hasDeposited: false,
    createdAt   : Date.now(),
  };
  await dbSet(`users/${uid}`, user);
  return user;
}

// ── Build leaderboard ──────────────────────────────────────────────
async function getLeaderboard() {
  try {
    const r = await dbGet('bids');
    if (!r.data) return [];
    const bids = Object.values(r.data);
    bids.sort((a, b) => b.totalBid - a.totalBid);
    return bids.slice(0, 20).map(b => ({
      userId: b.userId,
      name  : b.name  || 'مشارك',
      photo : b.photo || null,
      amount: b.totalBid || 0,
    }));
  } catch { return []; }
}

// ================================================================
//  HANDLERS
// ================================================================

async function hGetAuction(uid, tg) {
  try {
    const [auction, user, leaderboard] = await Promise.all([
      getOrInitAuction(),
      getOrInitUser(uid, tg),
      getLeaderboard(),
    ]);
    return ok({ endDate: auction.endDate, status: auction.status || 'active', myBid: user.totalBid || 0, leaderboard });
  } catch (e) { return fail(e.message); }
}

async function hGetUser(uid, tg) {
  try {
    const user = await getOrInitUser(uid, tg);
    return ok({ tonBalance: user.tonBalance || 0, totalBid: user.totalBid || 0, hasDeposited: user.hasDeposited || false });
  } catch (e) { return fail(e.message); }
}

async function hAuctionBid(uid, tg, data) {
  try {
    const amount = parseFloat(data.amount) || 0;
    console.log(`[BID] uid:${uid} raw_amount:${data.amount} parsed:${amount} minBid:${CFG.MIN_BID}`);
    if (amount <= 0 || amount < CFG.MIN_BID)
      return { success: false, errorCode: 'BID_MIN', minBid: CFG.MIN_BID };

    const lockKey = `bidLocks/${uid}`;
    const lockRec = await dbGet(lockKey);
    const now = Date.now();
    if (lockRec.data && (now - (lockRec.data.ts || 0)) < 8000)
      return { success: false, errorCode: 'BID_COOLDOWN' };
    await dbSet(lockKey, { ts: now });

    try {
      const user = await getOrInitUser(uid, tg);
      if ((user.tonBalance || 0) < amount) {
        await dbSet(lockKey, { ts: 0 });
        return { success: false, errorCode: 'INSUFFICIENT_BALANCE', balance: user.tonBalance || 0 };
      }
      const auction = await getOrInitAuction();
      if (auction.status !== 'active' || Date.now() > auction.endDate) {
        await dbSet(lockKey, { ts: 0 });
        return { success: false, errorCode: 'AUCTION_ENDED' };
      }
      const newBalance  = parseFloat(((user.tonBalance || 0) - amount).toFixed(6));
      const newTotalBid = parseFloat(((user.totalBid   || 0) + amount).toFixed(6));
      const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'مشارك';

      await dbUpdate(`users/${uid}`, { tonBalance: newBalance, totalBid: newTotalBid });
      await dbSet(`bids/${uid}`, { userId: uid, name: displayName, photo: user.photoUrl || null, totalBid: newTotalBid, lastBidAt: now });
      await dbPush(`users/${uid}/bidHistory`, { amount, newTotalBid, newBalance, ts: now });
      await dbSet(lockKey, { ts: 0 });

      if (amount >= 5 && env.ADMIN_IDS) {
        env.ADMIN_IDS.split(',').map(s => s.trim()).forEach(adminId =>
          sendTgMsg(adminId, `🏆 <b>مزايدة جديدة!</b>\n👤 ${displayName}\n💰 ${amount} TON\n📊 إجمالي: ${newTotalBid} TON`).catch(() => {})
        );
      }
      const leaderboard = await getLeaderboard();
      return ok({ tonBalance: newBalance, totalBid: newTotalBid, leaderboard });
    } catch (innerErr) {
      await dbSet(lockKey, { ts: 0 }).catch(() => {});
      throw innerErr;
    }
  } catch (e) {
    console.error('hAuctionBid:', e);
    return fail(e.message);
  }
}

async function hDeposit(uid, data) {
  try {
    const amt     = parseFloat(data.amount) || 0;
    const txHash  = (data.txHash  || '').slice(0, 512);
    const comment = (data.comment || '').slice(0, 64);

    if (!txHash)                       return fail('لم يتم استقبال بيانات المعاملة');
    if (amt < CFG.MIN_DEPOSIT_TON)     return fail(`الحد الأدنى للإيداع ${CFG.MIN_DEPOSIT_TON} TON`);
    if (amt > 10000)                   return fail('المبلغ كبير جداً');

    const safeHash = txHash.replace(/[^a-zA-Z0-9+/=]/g, '_').slice(0, 128);
    const dup = await dbGet(`txHashes/${safeHash}`);
    if (dup.data) return fail('هذه المعاملة مسجلة مسبقاً');

    const ur  = await dbGet(`users/${uid}`);
    const u   = ur.data || {};
    const depId = `dep_${uid}_${Date.now()}`;
    const now   = Date.now();
    const rec   = { depId, userId: uid, txHash: txHash.slice(0, 128), comment, amount: amt, status: 'pending', ts: now, createdAt: now, currentBalance: u.tonBalance || 0 };

    await Promise.all([
      dbSet(`users/${uid}/deposits/${depId}`, rec),
      dbSet(`pendingDeposits/${depId}`, rec),
      dbSet(`txHashes/${safeHash}`, { depId, userId: uid, ts: now, amount: amt }),
    ]);

    console.log(`[DEPOSIT PENDING] uid:${uid} amount:${amt} TON deposit:${depId}`);

    sendTgMsg(uid,
      `⏳ <b>تم استقبال طلب الإيداع</b>\n💰 المبلغ: <b>${amt} TON</b>\n🧾 الحالة: قيد المراجعة\n\nسيتم إضافة الرصيد بعد مراجعة الإدارة.`
    ).catch(() => {});

    if (env.ADMIN_IDS) {
      const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'مستخدم';
      env.ADMIN_IDS.split(',').map(s => s.trim()).forEach(adminId =>
        sendTgMsg(adminId, `⏳ <b>طلب إيداع جديد بانتظار المراجعة</b>\n👤 ${name} (${uid})\n💵 ${amt} TON\n🧾 ID: ${depId}`).catch(() => {})
      );
    }

    return ok({ depositId: depId, status: 'pending', currentBalance: u.tonBalance || 0, amount: amt, message: `تم تسجيل طلب إيداع ${amt} TON وهو بانتظار مراجعة الإدارة.` });
  } catch (e) {
    console.error('hDeposit:', e);
    return fail(e.message);
  }
}

async function hVerifyDeposit(uid, data) {
  try {
    const { depositId } = data;
    if (!depositId) return fail('depositId مطلوب');
    const dr  = await dbGet(`users/${uid}/deposits/${depositId}`);
    const dep = dr.data;
    if (!dep) return fail('الإيداع غير موجود');
    if (dep.status === 'completed') return ok({ status: 'completed', amount: dep.amount });
    return ok({ status: 'pending' });
  } catch (e) { return fail(e.message); }
}

async function hSubmitPromo(uid, tg, data) {
  try {
    const url = (data.url || '').trim().slice(0, 256);
    if (!url || !url.startsWith('http')) return fail('رابط غير صالح');
    if (!url.includes('t.me'))           return fail('يجب أن يكون رابط تيليجرام');

    const user = await getOrInitUser(uid, tg);
    const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'مشارك';

    const promoId = `promo_${uid}_${Date.now()}`;
    const record  = { promoId, userId: uid, name: displayName, photoUrl: user.photoUrl || null, url, status: 'pending', earned: null, ts: Date.now() };

    await Promise.all([
      dbSet(`users/${uid}/promos/${promoId}`, record),
      dbSet(`pendingPromos/${promoId}`, record),
    ]);

    if (env.ADMIN_IDS) {
      env.ADMIN_IDS.split(',').map(s => s.trim()).forEach(adminId =>
        sendTgMsg(adminId, `📢 <b>منشور جديد للمراجعة</b>\n👤 ${displayName} (${uid})\n🔗 ${url}`).catch(() => {})
      );
    }
    return ok({ id: promoId, status: 'pending' });
  } catch (e) {
    console.error('hSubmitPromo:', e);
    return fail(e.message);
  }
}

async function hAdmin(action, data) {
  try {
    switch (action) {

      case 'adminGetUser': {
        const uid = String(data.userId || '');
        if (!uid) return fail('userId required');
        const [userR, bidsR, depositsR] = await Promise.all([
          dbGet(`users/${uid}`),
          dbGet(`bids/${uid}`),
          dbGet(`users/${uid}/deposits`),
        ]);
        return ok({ user: userR.data, bidEntry: bidsR.data, deposits: depositsR.data ? Object.values(depositsR.data) : [] });
      }

      case 'adminConfirmDeposit': {
        const { userId, depositId, amountTon } = data;
        if (!userId || !depositId) return fail('userId and depositId required');
        const dr  = await dbGet(`users/${userId}/deposits/${depositId}`);
        const dep = dr.data;
        if (!dep)                         return fail('Deposit not found');
        if (dep.status === 'completed')   return fail('Already completed');

        const tonAmt = parseFloat(amountTon || dep.amount || 0);
        const ur     = await dbGet(`users/${userId}`);
        const user   = ur.data || {};
        const newBalance = parseFloat(((user.tonBalance || 0) + tonAmt).toFixed(6));

        await Promise.all([
          dbUpdate(`users/${userId}`, { tonBalance: newBalance, hasDeposited: true }),
          dbUpdate(`users/${userId}/deposits/${depositId}`, { status: 'completed', completedAt: Date.now(), creditedTon: tonAmt, confirmedByAdmin: true }),
          dbDelete(`pendingDeposits/${depositId}`),
        ]);
        sendTgMsg(userId, `✅ <b>تم تأكيد إيداعك يدوياً!</b>\n💰 <b>${tonAmt} TON</b> أُضيفت إلى رصيدك\n📊 الرصيد الجديد: <b>${newBalance} TON</b>`).catch(() => {});
        return ok({ newBalance, credited: tonAmt });
      }

      case 'adminGetQueue': {
        const [pendingDep, pendingPromo, leaderboard] = await Promise.all([
          dbGet('pendingDeposits'),
          dbGet('pendingPromos'),
          getLeaderboard(),
        ]);
        return ok({
          pendingDeposits: pendingDep.data   ? Object.values(pendingDep.data)   : [],
          pendingPromos  : pendingPromo.data  ? Object.values(pendingPromo.data) : [],
          leaderboard,
        });
      }

      case 'adminApprovePromo': {
        const { userId, promoId, rewardTon } = data;
        if (!userId || !promoId) return fail('userId and promoId required');
        const reward = parseFloat(rewardTon || 0);
        const ur     = await dbGet(`users/${userId}`);
        const user   = ur.data || {};
        const newBalance = parseFloat(((user.tonBalance || 0) + reward).toFixed(6));

        await Promise.all([
          dbUpdate(`users/${userId}`, { tonBalance: newBalance }),
          dbUpdate(`users/${userId}/promos/${promoId}`, { status: 'approved', earned: reward, reviewedAt: Date.now() }),
          dbDelete(`pendingPromos/${promoId}`),
        ]);
        if (reward > 0)
          sendTgMsg(userId, `🏆 <b>منشورك تم قبوله!</b>\n💰 حصلت على <b>${reward} TON</b> مكافأة\n📊 رصيدك الجديد: <b>${newBalance} TON</b>`).catch(() => {});
        return ok({ approved: true, newBalance, reward });
      }

      case 'adminRejectPromo': {
        const { userId, promoId } = data;
        if (!userId || !promoId) return fail('userId and promoId required');
        await Promise.all([
          dbUpdate(`users/${userId}/promos/${promoId}`, { status: 'rejected', reviewedAt: Date.now() }),
          dbDelete(`pendingPromos/${promoId}`),
        ]);
        sendTgMsg(userId, `❌ <b>منشورك تم رفضه</b>\nللأسف لم يستوفِ المنشور المتطلبات. يمكنك إرسال منشور آخر.`).catch(() => {});
        return ok({ rejected: true });
      }

      case 'adminSetBalance': {
        const { userId, tonBalance } = data;
        if (!userId) return fail('userId required');
        const bal = parseFloat(tonBalance || 0);
        await dbUpdate(`users/${userId}`, { tonBalance: bal });
        sendTgMsg(userId, `💰 تم تعديل رصيدك من قِبل الإدارة\n📊 رصيدك الجديد: <b>${bal} TON</b>`).catch(() => {});
        return ok({ userId, tonBalance: bal });
      }

      case 'adminGetAuction': {
        const [auction, leaderboard, pendingDep] = await Promise.all([
          dbGet('auction'),
          getLeaderboard(),
          dbGet('pendingDeposits'),
        ]);
        return ok({ auction: auction.data, leaderboard, pendingDeposits: pendingDep.data ? Object.values(pendingDep.data) : [] });
      }

      case 'adminExtendAuction':
        return fail('Auction time is locked and cannot be changed from the app');

      default:
        return fail(`Unknown admin action: ${action}`);
    }
  } catch (e) {
    console.error('hAdmin:', e);
    return fail(e.message);
  }
}

// ================================================================
//  ROUTES
// ================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', ts: Date.now(), app: CFG.APP_NAME, minDeposit: CFG.MIN_DEPOSIT_TON } });
});

// TON Connect manifest
app.get('/tonconnect-manifest.json', (req, res) => {
  res.json({ url: CFG.APP_URL, name: CFG.APP_NAME, iconUrl: CFG.APP_ICON, description: CFG.APP_DESCRIPTION });
});

// Main API
app.post('/api', async (req, res) => {
  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!rateOk(ip)) return res.status(429).json(fail('Rate limit exceeded'));

  // Parse body
  let body;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (raw.length > 32768) return res.status(413).json(fail('Payload too large'));
    body = JSON.parse(sanitise(raw));
  } catch { return res.status(400).json(fail('Invalid JSON')); }

  const action = body.action || req.headers['x-action'];
  const data   = body.data || {};
  if (!action) return res.status(400).json(fail('Missing action'));

  // Admin actions
  const ADMIN_ACTIONS = new Set([
    'adminGetUser', 'adminConfirmDeposit', 'adminGetQueue',
    'adminApprovePromo', 'adminRejectPromo', 'adminSetBalance',
    'adminGetAuction', 'adminExtendAuction',
  ]);

  if (ADMIN_ACTIONS.has(action)) {
    const initData = (
      req.headers['x-telegram-init-data'] ||
      req.headers['authorization']?.replace('Telegram ', '') ||
      body.initData || ''
    ).slice(0, 4096);
    const v = await validateTg(initData, env.BOT_TOKEN);
    if (!v.valid) return res.status(401).json(fail('Unauthorized'));
    const adminIds = (env.ADMIN_IDS || '').split(',').map(s => s.trim());
    if (!adminIds.includes(String(v.user?.id))) return res.status(403).json(fail('Forbidden'));
    return res.json(await hAdmin(action, data));
  }

  // User actions
  const initData = (
    req.headers['x-telegram-init-data'] ||
    req.headers['authorization']?.replace('Telegram ', '') ||
    body.initData || ''
  ).slice(0, 4096);

  const v = await validateTg(initData, env.BOT_TOKEN);
  if (!v.valid) {
    console.error('TG validation failed:', v.error, 'Action:', action);
    return res.status(401).json({
      success  : false,
      error    : 'Telegram authentication required',
      errorCode: 'INVALID_TELEGRAM_AUTH',
      debug    : { validationError: v.error, botTokenConfigured: !!env.BOT_TOKEN, hasInitData: !!initData },
    });
  }

  const uid    = String(v.user.id);
  const tgUser = v.user;
  console.log(`[${new Date().toISOString()}] uid:${uid} action:${action} ip:${ip}`);

  switch (action) {
    case 'getAuction'    : return res.json(await hGetAuction   (uid, tgUser));
    case 'getUser'       : return res.json(await hGetUser       (uid, tgUser));
    case 'auctionBid'    : return res.json(await hAuctionBid   (uid, tgUser, data));
    case 'deposit'       : return res.json(await hDeposit       (uid, data));
    case 'verifyDeposit' : return res.json(await hVerifyDeposit (uid, data));
    case 'submitPromo'   : return res.json(await hSubmitPromo   (uid, tgUser, data));
    default              : return res.status(400).json(fail(`Unknown action: ${action}`));
  }
});

// 404
app.use((req, res) => res.status(404).json(fail('Not found')));

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
