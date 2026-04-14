import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";

const CFG = {
  MIN_DEPOSIT_TON: 1,
  MIN_BID: 0.1,
  AUCTION_DURATION: 3 * 24 * 60 * 60 * 1000,
  APP_NAME: "PandaBambooBot",
  APP_URL: "https://pandabambo.vercel.app",
  APP_ICON:
    "https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/87e9d1bd-c053-466a-a29e-40483a009e8f.png",
  APP_DESCRIPTION: "Panda Bamboo Factory",
};

type FirebaseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

type TelegramUser = {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

type UserRecord = {
  userId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  tonBalance?: number;
  totalBid?: number;
  hasDeposited?: boolean;
  createdAt?: number;
};

type AuctionRecord = {
  endDate: number;
  startDate: number;
  status: string;
  createdAt: number;
};

type BidRecord = {
  userId: string;
  name?: string;
  photo?: string | null;
  totalBid?: number;
  lastBidAt?: number;
};

type DepositRecord = {
  depId: string;
  userId: string;
  txHash: string;
  comment: string;
  amount: number;
  status: "pending" | "completed" | "rejected";
  ts: number;
  createdAt?: number;
  completedAt?: number;
  currentBalance?: number;
  creditedTon?: number;
  confirmedByAdmin?: boolean;
};

type PromoRecord = {
  promoId: string;
  userId: string;
  name: string;
  photoUrl: string | null;
  url: string;
  status: "pending" | "approved" | "rejected";
  earned: number | null;
  ts: number;
};

type Env = {
  FIREBASE_DATABASE_URL?: string;
  FIREBASE_API_KEY?: string;
  BOT_TOKEN?: string;
  ADMIN_IDS?: string;
};

const router: IRouter = Router();
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function getEnv(): Env {
  return {
    FIREBASE_DATABASE_URL: process.env["FIREBASE_DATABASE_URL"],
    FIREBASE_API_KEY: process.env["FIREBASE_API_KEY"],
    BOT_TOKEN: process.env["BOT_TOKEN"],
    ADMIN_IDS: process.env["ADMIN_IDS"],
  };
}

function sanitise(str: string) {
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/[<>]/g, (m) => (m === "<" ? "&lt;" : "&gt;"));
}

function fbUrl(env: Env, path: string) {
  const base = env.FIREBASE_DATABASE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("FIREBASE_DATABASE_URL not set");
  const key = env.FIREBASE_API_KEY;
  if (!key) throw new Error("FIREBASE_API_KEY not set");
  return `${base}/${path.replace(/^\//, "")}.json?key=${key}`;
}

async function dbGet<T = unknown>(env: Env, path: string): Promise<FirebaseResult<T | null>> {
  try {
    const response = await fetch(fbUrl(env, path));
    if (!response.ok) throw new Error(`GET ${response.status}`);
    return { success: true, data: (await response.json()) as T | null };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown database error";
    logger.error({ err, path }, "DB GET failed");
    return { success: false, error };
  }
}

async function dbSet(env: Env, path: string, data: unknown): Promise<FirebaseResult<null>> {
  try {
    const response = await fetch(fbUrl(env, path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`SET ${response.status}`);
    return { success: true, data: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown database error";
    logger.error({ err, path }, "DB SET failed");
    return { success: false, error };
  }
}

async function dbUpdate(env: Env, path: string, updates: unknown): Promise<FirebaseResult<null>> {
  try {
    const response = await fetch(fbUrl(env, path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(`UPDATE ${response.status}`);
    return { success: true, data: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown database error";
    logger.error({ err, path }, "DB UPDATE failed");
    return { success: false, error };
  }
}

async function dbPush(env: Env, path: string, data: unknown): Promise<FirebaseResult<{ id: string }>> {
  try {
    const response = await fetch(fbUrl(env, path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`PUSH ${response.status}`);
    const json = (await response.json()) as { name: string };
    return { success: true, data: { id: json.name } };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown database error";
    logger.error({ err, path }, "DB PUSH failed");
    return { success: false, error };
  }
}

async function dbDelete(env: Env, path: string): Promise<FirebaseResult<null>> {
  try {
    const response = await fetch(fbUrl(env, path), { method: "DELETE" });
    if (!response.ok) throw new Error(`DELETE ${response.status}`);
    return { success: true, data: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown database error";
    logger.error({ err, path }, "DB DELETE failed");
    return { success: false, error };
  }
}

function getIp(req: Request) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() || "unknown";
  return req.ip || "unknown";
}

function rateOk(ip: string) {
  const now = Date.now();
  const record = rateLimits.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 60_000;
  }
  record.count += 1;
  rateLimits.set(ip, record);
  return record.count <= 60;
}

async function validateTg(initData: string, botToken?: string) {
  try {
    if (!initData) return { valid: false as const, error: "No init data" };
    const params = new URLSearchParams(initData);
    if (!botToken) {
      const userRaw = params.get("user");
      if (!userRaw) return { valid: false as const, error: "No user in initData" };
      return { valid: true as const, user: JSON.parse(decodeURIComponent(userRaw)) as TelegramUser };
    }

    const hash = params.get("hash");
    if (!hash) return { valid: false as const, error: "No hash in initData" };
    params.delete("hash");

    const authDate = Number.parseInt(params.get("auth_date") || "0", 10);
    if (Date.now() / 1000 - authDate > 900) {
      return { valid: false as const, error: "initData expired" };
    }

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const encoder = new TextEncoder();
    const secret = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const keyBytes = await crypto.subtle.sign("HMAC", secret, encoder.encode(botToken));
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataCheckString));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return { valid: false as const, error: "Hash mismatch" };

    const userRaw = params.get("user");
    if (!userRaw) return { valid: false as const, error: "No user" };
    return { valid: true as const, user: JSON.parse(decodeURIComponent(userRaw)) as TelegramUser };
  } catch (err) {
    return { valid: false as const, error: err instanceof Error ? err.message : "Telegram validation failed" };
  }
}

async function sendTgMsg(env: Env, chatId: string, text: string) {
  try {
    if (!env.BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    logger.error({ err, chatId }, "Telegram message failed");
  }
}

async function getOrInitAuction(env: Env) {
  const result = await dbGet<AuctionRecord>(env, "auction");
  if (result.success && result.data?.endDate) return result.data;
  const now = Date.now();
  const auction: AuctionRecord = {
    endDate: now + CFG.AUCTION_DURATION,
    startDate: now,
    status: "active",
    createdAt: now,
  };
  await dbSet(env, "auction", auction);
  return auction;
}

async function getOrInitUser(env: Env, uid: string, tg: TelegramUser = { id: uid }) {
  const result = await dbGet<UserRecord>(env, `users/${uid}`);
  if (result.success && result.data) {
    const updates: Partial<UserRecord> = {};
    if (tg.first_name) updates.firstName = tg.first_name.slice(0, 64);
    if (tg.last_name) updates.lastName = tg.last_name.slice(0, 64);
    if (tg.username) updates.username = tg.username.slice(0, 64);
    if (tg.photo_url) updates.photoUrl = tg.photo_url.slice(0, 512);
    if (Object.keys(updates).length) await dbUpdate(env, `users/${uid}`, updates);
    return { ...result.data, ...updates };
  }

  const user: UserRecord = {
    userId: uid,
    firstName: (tg.first_name || "").slice(0, 64),
    lastName: (tg.last_name || "").slice(0, 64),
    username: (tg.username || "").slice(0, 64),
    photoUrl: (tg.photo_url || "").slice(0, 512),
    tonBalance: 0,
    totalBid: 0,
    hasDeposited: false,
    createdAt: Date.now(),
  };
  await dbSet(env, `users/${uid}`, user);
  return user;
}

async function getLeaderboard(env: Env) {
  const result = await dbGet<Record<string, BidRecord>>(env, "bids");
  if (!result.success || !result.data) return [];
  return Object.values(result.data)
    .sort((a, b) => (b.totalBid || 0) - (a.totalBid || 0))
    .slice(0, 20)
    .map((bid) => ({
      userId: bid.userId,
      name: bid.name || "مشارك",
      photo: bid.photo || null,
      amount: bid.totalBid || 0,
    }));
}

async function hGetAuction(env: Env, uid: string, tg: TelegramUser) {
  const [auction, user, leaderboard] = await Promise.all([
    getOrInitAuction(env),
    getOrInitUser(env, uid, tg),
    getLeaderboard(env),
  ]);
  return {
    success: true,
    data: {
      endDate: auction.endDate,
      status: auction.status || "active",
      myBid: user.totalBid || 0,
      leaderboard,
    },
  };
}

async function hGetUser(env: Env, uid: string, tg: TelegramUser) {
  const user = await getOrInitUser(env, uid, tg);
  return {
    success: true,
    data: {
      tonBalance: user.tonBalance || 0,
      totalBid: user.totalBid || 0,
      hasDeposited: user.hasDeposited || false,
    },
  };
}

async function hAuctionBid(env: Env, uid: string, tg: TelegramUser, data: Record<string, unknown>) {
  const amount = Number.parseFloat(String(data["amount"] || "0")) || 0;
  if (amount < CFG.MIN_BID) {
    return { success: false, error: `الحد الأدنى للمزايدة ${CFG.MIN_BID} TON` };
  }

  const lockKey = `bidLocks/${uid}`;
  const lockRec = await dbGet<{ ts?: number }>(env, lockKey);
  const now = Date.now();
  if (lockRec.success && lockRec.data && now - (lockRec.data.ts || 0) < 8000) {
    return { success: false, error: "انتظر لحظة قبل المزايدة مرة أخرى" };
  }
  await dbSet(env, lockKey, { ts: now });

  try {
    const user = await getOrInitUser(env, uid, tg);
    if ((user.tonBalance || 0) < amount) {
      await dbSet(env, lockKey, { ts: 0 });
      return { success: false, error: "رصيدك غير كافٍ. قم بالإيداع أولاً." };
    }

    const auction = await getOrInitAuction(env);
    if (auction.status !== "active" || Date.now() > auction.endDate) {
      await dbSet(env, lockKey, { ts: 0 });
      return { success: false, error: "انتهى المزاد" };
    }

    const newBalance = Number.parseFloat(((user.tonBalance || 0) - amount).toFixed(6));
    const newTotalBid = Number.parseFloat(((user.totalBid || 0) + amount).toFixed(6));
    const displayName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "مشارك";

    await dbUpdate(env, `users/${uid}`, { tonBalance: newBalance, totalBid: newTotalBid });
    await dbSet(env, `bids/${uid}`, {
      userId: uid,
      name: displayName,
      photo: user.photoUrl || null,
      totalBid: newTotalBid,
      lastBidAt: now,
    });
    await dbPush(env, `users/${uid}/bidHistory`, { amount, newTotalBid, newBalance, ts: now });
    await dbSet(env, lockKey, { ts: 0 });

    if (process.env["ADMIN_IDS"]) {
      process.env["ADMIN_IDS"].split(",")
        .map((id) => id.trim())
        .forEach((adminId) => {
          sendTgMsg(env, adminId, `🔥 <b>مزايدة جديدة</b>\n👤 ${displayName} (${uid})\n💰 ${amount} TON\n📊 الإجمالي: ${newTotalBid} TON`).catch(() => {});
        });
    }

    const leaderboard = await getLeaderboard(env);
    return { success: true, data: { tonBalance: newBalance, totalBid: newTotalBid, leaderboard } };
  } catch (err) {
    await dbSet(env, lockKey, { ts: 0 }).catch(() => {});
    throw err;
  }
}

async function hDeposit(env: Env, uid: string, data: Record<string, unknown>) {
  const amount = Number.parseFloat(String(data["amount"] || "0")) || 0;
  const txHash = String(data["txHash"] || "").slice(0, 512);
  const comment = String(data["comment"] || "").slice(0, 64);

  if (!txHash) return { success: false, error: "لم يتم استقبال بيانات المعاملة" };
  if (amount < CFG.MIN_DEPOSIT_TON) {
    return { success: false, error: `الحد الأدنى للإيداع ${CFG.MIN_DEPOSIT_TON} TON` };
  }
  if (amount > 10000) return { success: false, error: "المبلغ كبير جداً" };

  const safeHash = txHash.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  const dup = await dbGet(env, `txHashes/${safeHash}`);
  if (dup.success && dup.data) return { success: false, error: "هذه المعاملة مسجلة مسبقاً" };

  const userResult = await dbGet<UserRecord>(env, `users/${uid}`);
  const user = userResult.success && userResult.data ? userResult.data : {};
  const now = Date.now();
  const depId = `dep_${uid}_${now}`;
  const rec: DepositRecord = {
    depId,
    userId: uid,
    txHash: txHash.slice(0, 128),
    comment,
    amount,
    status: "pending",
    ts: now,
    createdAt: now,
    currentBalance: user.tonBalance || 0,
  };

  await Promise.all([
    dbSet(env, `users/${uid}/deposits/${depId}`, rec),
    dbSet(env, `pendingDeposits/${depId}`, rec),
    dbSet(env, `txHashes/${safeHash}`, { depId, userId: uid, ts: now, amount }),
  ]);

  sendTgMsg(
    env,
    uid,
    `⏳ <b>تم استقبال طلب الإيداع</b>\n💰 المبلغ: <b>${amount} TON</b>\n🧾 الحالة: قيد المراجعة\n\nسيتم إضافة الرصيد بعد مراجعة الإدارة.`,
  ).catch(() => {});

  if (env.ADMIN_IDS) {
    const name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "مستخدم";
    env.ADMIN_IDS.split(",")
      .map((id) => id.trim())
      .forEach((adminId) => {
        sendTgMsg(env, adminId, `⏳ <b>طلب إيداع جديد بانتظار المراجعة</b>\n👤 ${name} (${uid})\n💵 ${amount} TON\n🧾 ID: ${depId}`).catch(() => {});
      });
  }

  return {
    success: true,
    data: {
      depositId: depId,
      status: "pending",
      currentBalance: user.tonBalance || 0,
      amount,
      message: `تم تسجيل طلب إيداع ${amount} TON وهو بانتظار مراجعة الإدارة.`,
    },
  };
}

async function hVerifyDeposit(env: Env, uid: string, data: Record<string, unknown>) {
  const depositId = String(data["depositId"] || "");
  if (!depositId) return { success: false, error: "depositId مطلوب" };
  const depositResult = await dbGet<DepositRecord>(env, `users/${uid}/deposits/${depositId}`);
  if (!depositResult.success || !depositResult.data) return { success: false, error: "الإيداع غير موجود" };
  if (depositResult.data.status === "completed") {
    return { success: true, data: { status: "completed", amount: depositResult.data.amount } };
  }
  return { success: true, data: { status: "pending" } };
}

async function hSubmitPromo(env: Env, uid: string, tg: TelegramUser, data: Record<string, unknown>) {
  const url = String(data["url"] || "").trim().slice(0, 256);
  if (!url || !url.startsWith("http")) return { success: false, error: "رابط غير صالح" };
  if (!url.includes("t.me")) return { success: false, error: "يجب أن يكون رابط تيليجرام" };

  const user = await getOrInitUser(env, uid, tg);
  const displayName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "مشارك";
  const promoId = `promo_${uid}_${Date.now()}`;
  const record: PromoRecord = {
    promoId,
    userId: uid,
    name: displayName,
    photoUrl: user.photoUrl || null,
    url,
    status: "pending",
    earned: null,
    ts: Date.now(),
  };

  await Promise.all([
    dbSet(env, `users/${uid}/promos/${promoId}`, record),
    dbSet(env, `pendingPromos/${promoId}`, record),
  ]);

  if (env.ADMIN_IDS) {
    for (const adminId of env.ADMIN_IDS.split(",").map((id) => id.trim())) {
      sendTgMsg(env, adminId, `📢 <b>منشور جديد للمراجعة</b>\n👤 ${displayName} (${uid})\n🔗 ${url}`).catch(() => {});
    }
  }

  return { success: true, data: { id: promoId, status: "pending" } };
}

async function hAdmin(env: Env, action: string, data: Record<string, unknown>) {
  switch (action) {
    case "adminGetUser": {
      const uid = String(data["userId"] || "");
      if (!uid) return { success: false, error: "userId required" };
      const [userR, bidsR, depositsR] = await Promise.all([
        dbGet(env, `users/${uid}`),
        dbGet(env, `bids/${uid}`),
        dbGet<Record<string, DepositRecord>>(env, `users/${uid}/deposits`),
      ]);
      return {
        success: true,
        data: {
          user: userR.success ? userR.data : null,
          bidEntry: bidsR.success ? bidsR.data : null,
          deposits: depositsR.success && depositsR.data ? Object.values(depositsR.data) : [],
        },
      };
    }
    case "adminConfirmDeposit": {
      const userId = String(data["userId"] || "");
      const depositId = String(data["depositId"] || "");
      if (!userId || !depositId) return { success: false, error: "userId and depositId required" };
      const depResult = await dbGet<DepositRecord>(env, `users/${userId}/deposits/${depositId}`);
      const dep = depResult.success ? depResult.data : null;
      if (!dep) return { success: false, error: "Deposit not found" };
      if (dep.status === "completed") return { success: false, error: "Already completed" };

      const tonAmt = Number.parseFloat(String(data["amountTon"] || dep.amount || "0"));
      const userResult = await dbGet<UserRecord>(env, `users/${userId}`);
      const user = userResult.success && userResult.data ? userResult.data : {};
      const newBalance = Number.parseFloat(((user.tonBalance || 0) + tonAmt).toFixed(6));

      await Promise.all([
        dbUpdate(env, `users/${userId}`, { tonBalance: newBalance, hasDeposited: true }),
        dbUpdate(env, `users/${userId}/deposits/${depositId}`, {
          status: "completed",
          completedAt: Date.now(),
          creditedTon: tonAmt,
          confirmedByAdmin: true,
        }),
        dbDelete(env, `pendingDeposits/${depositId}`),
      ]);

      sendTgMsg(env, userId, `✅ <b>تم تأكيد إيداعك يدوياً!</b>\n💰 <b>${tonAmt} TON</b> أُضيفت إلى رصيدك\n📊 الرصيد الجديد: <b>${newBalance} TON</b>`).catch(() => {});
      return { success: true, data: { newBalance, credited: tonAmt } };
    }
    case "adminGetQueue": {
      const [pendingDep, pendingPromo, leaderboard] = await Promise.all([
        dbGet<Record<string, DepositRecord>>(env, "pendingDeposits"),
        dbGet<Record<string, PromoRecord>>(env, "pendingPromos"),
        getLeaderboard(env),
      ]);
      return {
        success: true,
        data: {
          pendingDeposits: pendingDep.success && pendingDep.data ? Object.values(pendingDep.data) : [],
          pendingPromos: pendingPromo.success && pendingPromo.data ? Object.values(pendingPromo.data) : [],
          leaderboard,
        },
      };
    }
    case "adminApprovePromo": {
      const userId = String(data["userId"] || "");
      const promoId = String(data["promoId"] || "");
      if (!userId || !promoId) return { success: false, error: "userId and promoId required" };
      const reward = Number.parseFloat(String(data["rewardTon"] || "0"));
      const userResult = await dbGet<UserRecord>(env, `users/${userId}`);
      const user = userResult.success && userResult.data ? userResult.data : {};
      const newBalance = Number.parseFloat(((user.tonBalance || 0) + reward).toFixed(6));

      await Promise.all([
        dbUpdate(env, `users/${userId}`, { tonBalance: newBalance }),
        dbUpdate(env, `users/${userId}/promos/${promoId}`, {
          status: "approved",
          earned: reward,
          reviewedAt: Date.now(),
        }),
        dbDelete(env, `pendingPromos/${promoId}`),
      ]);

      if (reward > 0) {
        sendTgMsg(env, userId, `🏆 <b>منشورك تم قبوله!</b>\n💰 حصلت على <b>${reward} TON</b> مكافأة\n📊 رصيدك الجديد: <b>${newBalance} TON</b>`).catch(() => {});
      }
      return { success: true, data: { approved: true, newBalance, reward } };
    }
    case "adminRejectPromo": {
      const userId = String(data["userId"] || "");
      const promoId = String(data["promoId"] || "");
      if (!userId || !promoId) return { success: false, error: "userId and promoId required" };
      await Promise.all([
        dbUpdate(env, `users/${userId}/promos/${promoId}`, { status: "rejected", reviewedAt: Date.now() }),
        dbDelete(env, `pendingPromos/${promoId}`),
      ]);
      sendTgMsg(env, userId, "❌ <b>منشورك تم رفضه</b>\nللأسف لم يستوفِ المنشور المتطلبات. يمكنك إرسال منشور آخر.").catch(() => {});
      return { success: true, data: { rejected: true } };
    }
    case "adminSetBalance": {
      const userId = String(data["userId"] || "");
      if (!userId) return { success: false, error: "userId required" };
      const bal = Number.parseFloat(String(data["tonBalance"] || "0"));
      await dbUpdate(env, `users/${userId}`, { tonBalance: bal });
      sendTgMsg(env, userId, `💰 تم تعديل رصيدك من قِبل الإدارة\n📊 رصيدك الجديد: <b>${bal} TON</b>`).catch(() => {});
      return { success: true, data: { userId, tonBalance: bal } };
    }
    case "adminGetAuction": {
      const [auction, leaderboard, pendingDep] = await Promise.all([
        dbGet(env, "auction"),
        getLeaderboard(env),
        dbGet<Record<string, DepositRecord>>(env, "pendingDeposits"),
      ]);
      return {
        success: true,
        data: {
          auction: auction.success ? auction.data : null,
          leaderboard,
          pendingDeposits: pendingDep.success && pendingDep.data ? Object.values(pendingDep.data) : [],
        },
      };
    }
    case "adminExtendAuction":
      return { success: false, error: "Auction time is locked and cannot be changed from the app" };
    default:
      return { success: false, error: `Unknown admin action: ${action}` };
  }
}

router.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", ts: Date.now(), app: CFG.APP_NAME, minDeposit: CFG.MIN_DEPOSIT_TON } });
});

router.get("/tonconnect-manifest.json", (_req, res) => {
  res.json({
    url: CFG.APP_URL,
    name: CFG.APP_NAME,
    iconUrl: CFG.APP_ICON,
    description: CFG.APP_DESCRIPTION,
  });
});

router.post("/api", async (req, res) => {
  const env = getEnv();
  const ip = getIp(req);
  if (!rateOk(ip)) {
    res.status(429).json({ success: false, error: "Rate limit exceeded" });
    return;
  }

  try {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const cleanBody = JSON.parse(sanitise(JSON.stringify(body))) as {
      action?: string;
      data?: Record<string, unknown>;
      initData?: string;
    };
    const action = cleanBody.action || String(req.headers["x-action"] || "");
    const data = cleanBody.data || {};
    if (!action) {
      res.status(400).json({ success: false, error: "Missing action" });
      return;
    }

    const adminActions = new Set([
      "adminGetUser",
      "adminConfirmDeposit",
      "adminGetQueue",
      "adminApprovePromo",
      "adminRejectPromo",
      "adminSetBalance",
      "adminGetAuction",
      "adminExtendAuction",
    ]);

    const initData = String(
      req.headers["x-telegram-init-data"] ||
        String(req.headers["authorization"] || "").replace("Telegram ", "") ||
        cleanBody.initData ||
        "",
    ).slice(0, 4096);

    const validation = await validateTg(initData, env.BOT_TOKEN);
    if (!validation.valid) {
      res.status(401).json({
        success: false,
        error: "Telegram authentication required",
        errorCode: "INVALID_TELEGRAM_AUTH",
        debug: {
          validationError: validation.error,
          botTokenConfigured: !!env.BOT_TOKEN,
          hasInitData: !!initData,
        },
      });
      return;
    }

    if (adminActions.has(action)) {
      const adminIds = (env.ADMIN_IDS || "").split(",").map((id) => id.trim());
      if (!adminIds.includes(String(validation.user.id))) {
        res.status(403).json({ success: false, error: "Forbidden" });
        return;
      }
      res.json(await hAdmin(env, action, data));
      return;
    }

    const uid = String(validation.user.id);
    switch (action) {
      case "getAuction":
        res.json(await hGetAuction(env, uid, validation.user));
        return;
      case "getUser":
        res.json(await hGetUser(env, uid, validation.user));
        return;
      case "auctionBid":
        res.json(await hAuctionBid(env, uid, validation.user, data));
        return;
      case "deposit":
        res.json(await hDeposit(env, uid, data));
        return;
      case "verifyDeposit":
        res.json(await hVerifyDeposit(env, uid, data));
        return;
      case "submitPromo":
        res.json(await hSubmitPromo(env, uid, validation.user, data));
        return;
      default:
        res.status(400).json({ success: false, error: `Unknown action: ${action}` });
        return;
    }
  } catch (err) {
    req.log.error({ err }, "Auction API failed");
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Server error" });
  }
});

export default router;
