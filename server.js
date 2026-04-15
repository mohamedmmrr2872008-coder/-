// ================================================================
//  مزاد باكج الأساطير — Railway / Node.js
//  Firebase Realtime Database
//
//  Environment Variables:
//    FIREBASE_DATABASE_URL   e.g. https://YOUR-DB-default-rtdb.firebaseio.com
//    FIREBASE_API_KEY        Firebase Web API Key
//    BOT_TOKEN               Telegram Bot Token
//    ADMIN_IDS               comma-separated Telegram admin IDs
//    PORT                    (اختياري — Railway يضبطها تلقائياً)
//
//  Routes:
//    GET  /health                    → server health check
//    GET  /tonconnect-manifest.json  → TON Connect manifest
//    POST /api                       → all app actions
// ================================================================

import http from 'http';
import { webcrypto as crypto } from 'crypto';

// ── env object من process.env (يحاكي Cloudflare env) ──────────────
const env = {
  get FIREBASE_DATABASE_URL() { return process.env.FIREBASE_DATABASE_URL; },
  get FIREBASE_API_KEY()      { return process.env.FIREBASE_API_KEY; },
  get BOT_TOKEN()             { return process.env.BOT_TOKEN; },
  get ADMIN_IDS()             { return process.env.ADMIN_IDS; },
};

// ── Config ────────────────────────────────────────────────────────
const CFG = {
  MIN_DEPOSIT_TON : 1,     // ✅ الحد الأدنى 1 TON (مطابق للـ HTML)
  MIN_BID         : 0.1,   // Minimum bid increment in TON
  AUCTION_DURATION: 3 * 24 * 60 * 60 * 1000,
  APP_NAME        : 'PandaBambooBot',
  APP_URL         : 'https://pandabambo.vercel.app',
  APP_ICON        : 'https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/87e9d1bd-c053-466a-a29e-40483a009e8f.png',
  APP_DESCRIPTION : 'Panda Bamboo Factory',
};

// ── HTTP helpers ──────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data, X-Action',
  'Access-Control-Max-Age'      : '86400',
};
const JSON_CT = { 'Content-Type': 'application/json', ...CORS };
const jRes  = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: JSON_CT });
const ok    = d => jRes({ success: true, data: d });
const fail  = (m, s = 400) => jRes({ success: false, error: m }, s);

function sanitise(str) {
  if (!str) return str;
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/[<>]/g, m => m === '<' ? '&lt;' : '&gt;');
}

// ── Firebase helpers ──────────────────────────────────────────────
function fbUrl(env, path) {
  const base = env.FIREBASE_DATABASE_URL?.replace(/\/$/, '');
  if (!base) throw new Error('FIREBASE_DATABASE_URL not set');
  const key = env.FIREBASE_API_KEY;
  if (!key) throw new Error('FIREBASE_API_KEY not set');
  return `${base}/${path.replace(/^\//, '')}.json?key=${key}`;
}

async function dbGet(env, path) {
  try {
    const r = await fetch(fbUrl(env, path));
    if (!r.ok) throw new Error(`GET ${r.status}`);
    return { success: true, data: await r.json() };
  } catch (e) {
    console.error('DB GET', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbSet(env, path, data) {
  try {
    const r = await fetch(fbUrl(env, path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`SET ${r.status}`);
    return { success: true };
  } catch (e) {
    console.error('DB SET', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbUpdate(env, path, updates) {
  try {
    const r = await fetch(fbUrl(env, path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!r.ok) throw new Error(`UPDATE ${r.status}`);
    return { success: true };
  } catch (e) {
    console.error('DB UPDATE', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbPush(env, path, data) {
  try {
    const r = await fetch(fbUrl(env, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`PUSH ${r.status}`);
    const j = await r.json();
    return { success: true, data: { id: j.name } };
  } catch (e) {
    console.error('DB PUSH', path, e.message);
    return { success: false, error: e.message };
  }
}

async function dbDelete(env, path) {
  try {
    const r = await fetch(fbUrl(env, path), { method: 'DELETE' });
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
  const d = _rl.get(ip) || { c: 0, r: now + 60000 };
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
      // Dev mode — trust without verification
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
    const enc = new TextEncoder();
    const sec = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const kb = await crypto.subtle.sign('HMAC', sec, enc.encode(botToken));
    const key = await crypto.subtle.importKey('raw', kb, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dc));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return { valid: false, error: 'Hash mismatch' };
    const u = p.get('user');
    if (!u) return { valid: false, error: 'No user' };
    return { valid: true, user: JSON.parse(decodeURIComponent(u)) };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── Telegram Bot notification ──────────────────────────────────────
async function sendTgMsg(env, chatId, text) {
  try {
    if (!env.BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('sendTgMsg:', e.message); }
}

// ── Get or init auction ────────────────────────────────────────────
async function getOrInitAuction(env) {
  const r = await dbGet(env, 'auction');
  if (r.data && r.data.endDate) return r.data;
  const auction = {
    endDate  : Date.now() + CFG.AUCTION_DURATION,
    startDate: Date.now(),
    status   : 'active',
    createdAt: Date.now(),
  };
  await dbSet(env, 'auction', auction);
  return auction;
}

// ── Get or init user ───────────────────────────────────────────────
async function getOrInitUser(env, uid, tg = {}) {
  const r = await dbGet(env, `users/${uid}`);
  if (r.data) {
    const updates = {};
    if (tg.first_name) updates.firstName = tg.first_name.slice(0, 64);
    if (tg.last_name)  updates.lastName  = tg.last_name.slice(0, 64);
    if (tg.username)   updates.username  = tg.username.slice(0, 64);
    if (tg.photo_url)  updates.photoUrl  = tg.photo_url.slice(0, 512);
    if (Object.keys(updates).length) await dbUpdate(env, `users/${uid}`, updates);
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
  await dbSet(env, `users/${uid}`, user);
  return user;
}

// ── Build leaderboard from bids ────────────────────────────────────
async function getLeaderboard(env) {
  try {
    const r = await dbGet(env, 'bids');
    if (!r.data) return [];
    const bids = Object.values(r.data);
    bids.sort((a, b) => b.totalBid - a.totalBid);
    return bids.slice(0, 20).map(b => ({
      userId: b.userId,
      name  : b.name || 'مشارك',
      photo : b.photo || null,
      amount: b.totalBid || 0,
    }));
  } catch (e) {
    return [];
  }
}

// ================================================================
//  HANDLERS
// ================================================================

// ── GET AUCTION ────────────────────────────────────────────────────
async function hGetAuction(env, uid, tg, data) {
  try {
    const [auction, user, leaderboard] = await Promise.all([
      getOrInitAuction(env),
      getOrInitUser(env, uid, tg),
      getLeaderboard(env),
    ]);
    return {
      success: true,
      data: {
        endDate    : auction.endDate,
        status     : auction.status || 'active',
        myBid      : user.totalBid  || 0,
        leaderboard,
      },
    };
  } catch (e) {
    console.error('hGetAuction:', e);
    return { success: false, error: e.message };
  }
}

// ── GET USER ───────────────────────────────────────────────────────
async function hGetUser(env, uid, tg) {
  try {
    const user = await getOrInitUser(env, uid, tg);
    return {
      success: true,
      data: {
        tonBalance  : user.tonBalance   || 0,
        totalBid    : user.totalBid     || 0,
        hasDeposited: user.hasDeposited || false,
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── AUCTION BID ────────────────────────────────────────────────────
async function hAuctionBid(env, uid, tg, data) {
  try {
    const amount = parseFloat(data.amount) || 0;
    if (amount < CFG.MIN_BID) return { success: false, error: `الحد الأدنى للمزايدة ${CFG.MIN_BID} TON` };

    const lockKey = `bidLocks/${uid}`;
    const lockRec = await dbGet(env, lockKey);
    const now = Date.now();
    if (lockRec.data && (now - (lockRec.data.ts || 0)) < 8000) {
      return { success: false, error: 'انتظر لحظة قبل المزايدة مرة أخرى' };
    }
    await dbSet(env, lockKey, { ts: now });

    try {
      const user = await getOrInitUser(env, uid, tg);
      if ((user.tonBalance || 0) < amount) {
        await dbSet(env, lockKey, { ts: 0 });
        return { success: false, error: 'رصيدك غير كافٍ. قم بالإيداع أولاً.' };
      }

      const auction = await getOrInitAuction(env);
      if (auction.status !== 'active' || Date.now() > auction.endDate) {
        await dbSet(env, lockKey, { ts: 0 });
        return { success: false, error: 'انتهى المزاد' };
      }

      const newBalance  = parseFloat(((user.tonBalance || 0) - amount).toFixed(6));
      const newTotalBid = parseFloat(((user.totalBid   || 0) + amount).toFixed(6));
      const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'مشارك';

      await dbUpdate(env, `users/${uid}`, { tonBalance: newBalance, totalBid: newTotalBid });
      await dbSet(env, `bids/${uid}`, {
        userId   : uid,
        name     : displayName,
        photo    : user.photoUrl || null,
        totalBid : newTotalBid,
        lastBidAt: now,
      });
      await dbPush(env, `users/${uid}/bidHistory`, { amount, newTotalBid, newBalance, ts: now });
      await dbSet(env, lockKey, { ts: 0 });

      if (amount >= 5 && env.ADMIN_IDS) {
        const adminIds = env.ADMIN_IDS.split(',').map(s => s.trim());
        for (const adminId of adminIds) {
          sendTgMsg(env, adminId,
            `🏆 <b>مزايدة جديدة!</b>\n👤 ${displayName}\n💰 ${amount} TON\n📊 إجمالي: ${newTotalBid} TON`
          ).catch(() => {});
        }
      }

      const leaderboard = await getLeaderboard(env);
      return { success: true, data: { tonBalance: newBalance, totalBid: newTotalBid, leaderboard } };
    } catch (innerErr) {
      await dbSet(env, lockKey, { ts: 0 }).catch(() => {});
      throw innerErr;
    }
  } catch (e) {
    console.error('hAuctionBid:', e);
    return { success: false, error: e.message };
  }
}

// ================================================================
//  ✅ DEPOSIT — يسجل طلب الإيداع للمراجعة فقط ولا يضيف الرصيد تلقائياً
// ================================================================
async function hDeposit(env, uid, data) {
  try {
    const amt     = parseFloat(data.amount) || 0;
    const txHash  = (data.txHash  || '').slice(0, 512);
    const comment = (data.comment || '').slice(0, 64);

    // التحقق من الحد الأدنى
    if (!txHash)
      return { success: false, error: 'لم يتم استقبال بيانات المعاملة' };
    if (amt < CFG.MIN_DEPOSIT_TON)
      return { success: false, error: `الحد الأدنى للإيداع ${CFG.MIN_DEPOSIT_TON} TON` };
    if (amt > 10000)
      return { success: false, error: 'المبلغ كبير جداً' };

    // ── حماية من التكرار (نفس txHash مرتين) ──────────────────────
    // نستخدم أول 128 حرف من BOC لتجنب مشكلة الأحرف الخاصة
    const safeHash = txHash.replace(/[^a-zA-Z0-9+/=]/g, '_').slice(0, 128);
    const dup = await dbGet(env, `txHashes/${safeHash}`);
    if (dup.data) return { success: false, error: 'هذه المعاملة مسجلة مسبقاً' };

    // ── جلب بيانات المستخدم الحالية ──────────────────────────────
    const ur = await dbGet(env, `users/${uid}`);
    const u  = ur.data || {};

    const depId = `dep_${uid}_${Date.now()}`;
    const now   = Date.now();
    const rec   = {
      depId,
      userId     : uid,
      txHash     : txHash.slice(0, 128),
      comment,
      amount     : amt,
      status     : 'pending',
      ts         : now,
      createdAt  : now,
      currentBalance: u.tonBalance || 0,
    };

    // ── حفظ السجل فقط بدون إضافة رصيد حتى يراجعه الأدمن ──────────
    await Promise.all([
      dbSet(env, `users/${uid}/deposits/${depId}`, rec),
      dbSet(env, `pendingDeposits/${depId}`, rec),
      dbSet(env, `txHashes/${safeHash}`, { depId, userId: uid, ts: now, amount: amt }),
    ]);

    console.log(`[DEPOSIT PENDING] uid:${uid} amount:${amt} TON deposit:${depId}`);

    // ── إشعار المستخدم عبر تيليجرام ──────────────────────────────
    sendTgMsg(env, uid,
      `⏳ <b>تم استقبال طلب الإيداع</b>\n` +
      `💰 المبلغ: <b>${amt} TON</b>\n` +
      `🧾 الحالة: قيد المراجعة\n\n` +
      `سيتم إضافة الرصيد بعد مراجعة الإدارة.`
    ).catch(() => {});

    // ── إشعار الأدمن ──────────────────────────────────────────────
    if (env.ADMIN_IDS) {
      const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || 'مستخدم';
      env.ADMIN_IDS.split(',').map(s => s.trim()).forEach(adminId => {
        sendTgMsg(env, adminId,
          `⏳ <b>طلب إيداع جديد بانتظار المراجعة</b>\n👤 ${name} (${uid})\n💵 ${amt} TON\n🧾 ID: ${depId}`
        ).catch(() => {});
      });
    }

    return {
      success: true,
      data: {
        depositId : depId,
        status    : 'pending',
        currentBalance: u.tonBalance || 0,
        amount    : amt,
        message   : `تم تسجيل طلب إيداع ${amt} TON وهو بانتظار مراجعة الإدارة.`,
      },
    };
  } catch (e) {
    console.error('hDeposit:', e);
    return { success: false, error: e.message };
  }
}

// ── VERIFY DEPOSIT (احتياطي — للتوافق مع الإصدارات القديمة) ────────
async function hVerifyDeposit(env, uid, data) {
  try {
    const { depositId } = data;
    if (!depositId) return { success: false, error: 'depositId مطلوب' };

    const dr  = await dbGet(env, `users/${uid}/deposits/${depositId}`);
    const dep = dr.data;
    if (!dep) return { success: false, error: 'الإيداع غير موجود' };

    // إذا اكتمل مسبقاً أعد النتيجة مباشرة
    if (dep.status === 'completed')
      return { success: true, data: { status: 'completed', amount: dep.amount } };

    return { success: true, data: { status: 'pending' } };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── SUBMIT PROMO ───────────────────────────────────────────────────
async function hSubmitPromo(env, uid, tg, data) {
  try {
    const url = (data.url || '').trim().slice(0, 256);
    if (!url || !url.startsWith('http')) return { success: false, error: 'رابط غير صالح' };
    if (!url.includes('t.me')) return { success: false, error: 'يجب أن يكون رابط تيليجرام' };

    const user = await getOrInitUser(env, uid, tg);
    const displayName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'مشارك';

    const promoId = `promo_${uid}_${Date.now()}`;
    const record  = {
      promoId,
      userId  : uid,
      name    : displayName,
      photoUrl: user.photoUrl || null,
      url,
      status  : 'pending',
      earned  : null,
      ts      : Date.now(),
    };

    await Promise.all([
      dbSet(env, `users/${uid}/promos/${promoId}`, record),
      dbSet(env, `pendingPromos/${promoId}`, record),
    ]);

    if (env.ADMIN_IDS) {
      const adminIds = env.ADMIN_IDS.split(',').map(s => s.trim());
      for (const adminId of adminIds) {
        sendTgMsg(env, adminId,
          `📢 <b>منشور جديد للمراجعة</b>\n👤 ${displayName} (${uid})\n🔗 ${url}`
        ).catch(() => {});
      }
    }

    return { success: true, data: { id: promoId, status: 'pending' } };
  } catch (e) {
    console.error('hSubmitPromo:', e);
    return { success: false, error: e.message };
  }
}

// ── ADMIN ──────────────────────────────────────────────────────────
async function hAdmin(env, action, data) {
  try {
    switch (action) {

      case 'adminGetUser': {
        const uid = String(data.userId || '');
        if (!uid) return { success: false, error: 'userId required' };
        const [userR, bidsR, depositsR] = await Promise.all([
          dbGet(env, `users/${uid}`),
          dbGet(env, `bids/${uid}`),
          dbGet(env, `users/${uid}/deposits`),
        ]);
        return {
          success: true,
          data: {
            user    : userR.data,
            bidEntry: bidsR.data,
            deposits: depositsR.data ? Object.values(depositsR.data) : [],
          },
        };
      }

      case 'adminConfirmDeposit': {
        const { userId, depositId, amountTon } = data;
        if (!userId || !depositId) return { success: false, error: 'userId and depositId required' };
        const dr  = await dbGet(env, `users/${userId}/deposits/${depositId}`);
        const dep = dr.data;
        if (!dep) return { success: false, error: 'Deposit not found' };
        if (dep.status === 'completed') return { success: false, error: 'Already completed' };

        const tonAmt = parseFloat(amountTon || dep.amount || 0);
        const ur   = await dbGet(env, `users/${userId}`);
        const user = ur.data || {};
        const newBalance = parseFloat(((user.tonBalance || 0) + tonAmt).toFixed(6));

        await Promise.all([
          dbUpdate(env, `users/${userId}`, { tonBalance: newBalance, hasDeposited: true }),
          dbUpdate(env, `users/${userId}/deposits/${depositId}`, {
            status: 'completed', completedAt: Date.now(),
            creditedTon: tonAmt, confirmedByAdmin: true,
          }),
          dbDelete(env, `pendingDeposits/${depositId}`),
        ]);

        sendTgMsg(env, userId,
          `✅ <b>تم تأكيد إيداعك يدوياً!</b>\n💰 <b>${tonAmt} TON</b> أُضيفت إلى رصيدك\n📊 الرصيد الجديد: <b>${newBalance} TON</b>`
        ).catch(() => {});

        return { success: true, data: { newBalance, credited: tonAmt } };
      }

      case 'adminGetQueue': {
        const [pendingDep, pendingPromo, leaderboard] = await Promise.all([
          dbGet(env, 'pendingDeposits'),
          dbGet(env, 'pendingPromos'),
          getLeaderboard(env),
        ]);
        return {
          success: true,
          data: {
            pendingDeposits: pendingDep.data  ? Object.values(pendingDep.data)  : [],
            pendingPromos  : pendingPromo.data ? Object.values(pendingPromo.data): [],
            leaderboard,
          },
        };
      }

      case 'adminApprovePromo': {
        const { userId, promoId, rewardTon } = data;
        if (!userId || !promoId) return { success: false, error: 'userId and promoId required' };
        const reward = parseFloat(rewardTon || 0);

        const ur   = await dbGet(env, `users/${userId}`);
        const user = ur.data || {};
        const newBalance = parseFloat(((user.tonBalance || 0) + reward).toFixed(6));

        await Promise.all([
          dbUpdate(env, `users/${userId}`, { tonBalance: newBalance }),
          dbUpdate(env, `users/${userId}/promos/${promoId}`, { status: 'approved', earned: reward, reviewedAt: Date.now() }),
          dbDelete(env, `pendingPromos/${promoId}`),
        ]);

        if (reward > 0) {
          sendTgMsg(env, userId,
            `🏆 <b>منشورك تم قبوله!</b>\n💰 حصلت على <b>${reward} TON</b> مكافأة\n📊 رصيدك الجديد: <b>${newBalance} TON</b>`
          ).catch(() => {});
        }

        return { success: true, data: { approved: true, newBalance, reward } };
      }

      case 'adminRejectPromo': {
        const { userId, promoId } = data;
        if (!userId || !promoId) return { success: false, error: 'userId and promoId required' };
        await Promise.all([
          dbUpdate(env, `users/${userId}/promos/${promoId}`, { status: 'rejected', reviewedAt: Date.now() }),
          dbDelete(env, `pendingPromos/${promoId}`),
        ]);
        sendTgMsg(env, userId,
          `❌ <b>منشورك تم رفضه</b>\nللأسف لم يستوفِ المنشور المتطلبات. يمكنك إرسال منشور آخر.`
        ).catch(() => {});
        return { success: true, data: { rejected: true } };
      }

      case 'adminSetBalance': {
        const { userId, tonBalance } = data;
        if (!userId) return { success: false, error: 'userId required' };
        const bal = parseFloat(tonBalance || 0);
        await dbUpdate(env, `users/${userId}`, { tonBalance: bal });
        sendTgMsg(env, userId,
          `💰 تم تعديل رصيدك من قِبل الإدارة\n📊 رصيدك الجديد: <b>${bal} TON</b>`
        ).catch(() => {});
        return { success: true, data: { userId, tonBalance: bal } };
      }

      case 'adminGetAuction': {
        const [auction, leaderboard, pendingDep] = await Promise.all([
          dbGet(env, 'auction'),
          getLeaderboard(env),
          dbGet(env, 'pendingDeposits'),
        ]);
        return {
          success: true,
          data: {
            auction        : auction.data,
            leaderboard,
            pendingDeposits: pendingDep.data ? Object.values(pendingDep.data) : [],
          },
        };
      }

      case 'adminExtendAuction':
        return { success: false, error: 'Auction time is locked and cannot be changed from the app' };

      default:
        return { success: false, error: `Unknown admin action: ${action}` };
    }
  } catch (e) {
    console.error('hAdmin:', e);
    return { success: false, error: e.message };
  }
}

// ================================================================
//  MAIN FETCH HANDLER
// ================================================================
// ================================================================
//  HTTP SERVER — يستقبل الطلبات ويحوّلها لـ Web API Request/Response
// ================================================================

async function handleRequest(request) {
    // ── CORS preflight ──
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Health check ──
    if (path === '/health') {
      return ok({ status: 'ok', ts: Date.now(), app: CFG.APP_NAME, minDeposit: CFG.MIN_DEPOSIT_TON });
    }

    // ── TON Connect manifest ──
    if (path === '/tonconnect-manifest.json') {
      return jRes({
        url        : CFG.APP_URL,
        name       : CFG.APP_NAME,
        iconUrl    : CFG.APP_ICON,
        description: CFG.APP_DESCRIPTION,
      });
    }

    // ── Static HTML (optional: serve index.html) ──
    if (path === '/' || path === '/index.html') {
      return fail('Please deploy the HTML separately', 404);
    }

    // ── All other routes must be POST /api ──
    if (path !== '/api' || request.method !== 'POST') {
      return fail('Not found', 404);
    }

    // ── Rate limit ──
    const ip = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
             || request.headers.get('CF-Connecting-IP')
             || 'unknown';
    if (!rateOk(ip)) return fail('Rate limit exceeded', 429);

    // ── Parse body ──
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 32768) return fail('Payload too large', 413);
      body = JSON.parse(sanitise(raw));
    } catch (_) {
      return fail('Invalid JSON', 400);
    }

    const action = body.action || request.headers.get('X-Action');
    const data   = body.data || {};
    if (!action) return fail('Missing action', 400);

    // ── Admin actions ──
    const ADMIN_ACTIONS = new Set([
      'adminGetUser', 'adminConfirmDeposit', 'adminGetQueue',
      'adminApprovePromo', 'adminRejectPromo', 'adminSetBalance',
      'adminGetAuction', 'adminExtendAuction',
    ]);

    if (ADMIN_ACTIONS.has(action)) {
      const initData = (
        request.headers.get('X-Telegram-Init-Data') ||
        request.headers.get('Authorization')?.replace('Telegram ', '') ||
        body.initData || ''
      ).slice(0, 4096);
      const v = await validateTg(initData, env.BOT_TOKEN);
      if (!v.valid) return fail('Unauthorized', 401);
      const adminIds = (env.ADMIN_IDS || '').split(',').map(s => s.trim());
      if (!adminIds.includes(String(v.user?.id))) return fail('Forbidden', 403);
      return jRes(await hAdmin(env, action, data));
    }

    // ── User actions — استخراج initData من Header أو body ──────────
    const initData = (
      request.headers.get('X-Telegram-Init-Data') ||
      request.headers.get('Authorization')?.replace('Telegram ', '') ||
      body.initData || ''
    ).slice(0, 4096);

    const v = await validateTg(initData, env.BOT_TOKEN);

    if (!v.valid) {
      console.error('TG validation failed:', v.error, 'Action:', action);
      return jRes({
        success  : false,
        error    : 'Telegram authentication required',
        errorCode: 'INVALID_TELEGRAM_AUTH',
        debug    : {
          validationError   : v.error,
          botTokenConfigured: !!env.BOT_TOKEN,
          hasInitData       : !!initData,
        },
      }, 401);
    }

    const uid    = String(v.user.id);
    const tgUser = v.user;
    console.log(`[${new Date().toISOString()}] uid:${uid} action:${action} ip:${ip}`);

    // ── Dispatch ──
    switch (action) {
      case 'getAuction'    : return jRes(await hGetAuction   (env, uid, tgUser, data));
      case 'getUser'       : return jRes(await hGetUser       (env, uid, tgUser));
      case 'auctionBid'    : return jRes(await hAuctionBid   (env, uid, tgUser, data));
      case 'deposit'       : return jRes(await hDeposit       (env, uid, data));
      case 'verifyDeposit' : return jRes(await hVerifyDeposit (env, uid, data));
      case 'submitPromo'   : return jRes(await hSubmitPromo   (env, uid, tgUser, data));
      default              : return fail(`Unknown action: ${action}`, 400);
    }
}

// ── تحويل Node.js IncomingMessage → Web API Request ──────────────
function toWebRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      const proto   = req.headers['x-forwarded-proto'] || 'http';
      const host    = req.headers.host || 'localhost';
      const fullUrl = `${proto}://${host}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach(val => headers.append(k, val));
        else headers.set(k, v);
      }
      resolve(new Request(fullUrl, {
        method : req.method,
        headers,
        body   : ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : bodyBuf,
      }));
    });
    req.on('error', reject);
  });
}

// ── تحويل Web API Response → Node.js ServerResponse ──────────────
async function toNodeResponse(webRes, res) {
  res.statusCode = webRes.status;
  for (const [k, v] of webRes.headers.entries()) {
    res.setHeader(k, v);
  }
  const buf = await webRes.arrayBuffer();
  res.end(Buffer.from(buf));
}

// ── تشغيل السيرفر ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer(async (req, res) => {
  try {
    const webReq = await toWebRequest(req);
    const webRes = await handleRequest(webReq);
    await toNodeResponse(webRes, res);
  } catch (err) {
    console.error('Unhandled error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   Firebase URL : ${env.FIREBASE_DATABASE_URL ? '✅ Set' : '❌ NOT SET'}`);
  console.log(`   Firebase Key : ${env.FIREBASE_API_KEY     ? '✅ Set' : '❌ NOT SET'}`);
  console.log(`   Bot Token    : ${env.BOT_TOKEN            ? '✅ Set' : '❌ NOT SET'}`);
  console.log(`   Admin IDs    : ${env.ADMIN_IDS            ? '✅ Set' : '❌ NOT SET'}`);
});
