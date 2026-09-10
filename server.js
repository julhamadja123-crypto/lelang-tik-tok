const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(__dirname));

/* =========================================================
   TIKTOK CONNECTION
   BAGIAN INI DIPERTAHANKAN
   ========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
let liveCheckTimer = null;
let manualDisconnect = false;

// Prevent two browser/socket connect requests from replacing a healthy
// TikTok connection while the first connection is still being established.
let connectRequestInFlight = null;
let connectRequestUsername = null;
const LIVE_CHECK_INTERVAL = 10000;

/* =========================================================
   TIKTOK LIVE MONITOR
   Memisahkan status server, koneksi TikTok, event stream, dan gift.
   ========================================================= */
let tikTokConnectionState = "offline";
let tikTokEventCount = 0;
let tikTokGiftCount = 0;
let tikTokLastEventAt = 0;
let tikTokLastGiftAt = 0;
let tikTokConnectedAt = 0;
let tikTokLastError = "";
let tikTokReconnectCount = 0;

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionActive = false;
let auctionDrawTime = false;
let participants = new Map();
let participantVersion = 0;

// ---------------------------------------------------------
// DRAW-TIME / FINISH GRACE
// ---------------------------------------------------------
// The browser can reach 00:00 a few milliseconds before the last
// TikTok gift arrives. Keep a short 4-second server-side grace window.
// IMPORTANT: grace is NOT a mandatory wait when the top two are already tied.
const AUCTION_FINISH_GRACE_MS = 4000;
let auctionFinishedAt = 0;
let graceDrawCheckTimer = null;
let drawTimeEndTimer = null;
let drawTimeDeadline = 0;

function getTopTwoTie() {
  const list = Array.from(participants.values());
  if (list.length < 2) return false;

  list.sort((a, b) => (Number(b?.coins) || 0) - (Number(a?.coins) || 0));
  return (Number(list[0]?.coins) || 0) === (Number(list[1]?.coins) || 0);
}

function clearFinishGrace() {
  if (graceDrawCheckTimer) {
    clearTimeout(graceDrawCheckTimer);
    graceDrawCheckTimer = null;
  }
  if (drawTimeEndTimer) {
    clearTimeout(drawTimeEndTimer);
    drawTimeEndTimer = null;
  }
  auctionFinishedAt = 0;
}

function startServerDrawTime(reason = "coin seri") {
  clearFinishGrace();

  if (!getTopTwoTie()) {
    console.log("[Auction] DRAW TIME tidak dimulai: coin belum seri.");
    return false;
  }

  auctionActive = true;
  auctionDrawTime = true;

  drawTimeDeadline = Date.now() + 20000;

  console.log(`[Auction] ${reason} -> DRAW TIME 20 detik`);

  io.emit("auction:state", {
    state: "running",
    active: true,
    drawTime: true,
    drawTimeDeadline,
    version: participantVersion
  });

  // Server-authoritative Draw Time: when 20 seconds really end,
  // immediately repeat if the top two are still tied. This removes
  // the browser/socket round-trip gap between Draw Time rounds.
  if (drawTimeEndTimer) clearTimeout(drawTimeEndTimer);
  drawTimeEndTimer = setTimeout(() => {
    drawTimeEndTimer = null;

    if (!auctionActive || !auctionDrawTime) return;

    auctionDrawTime = false;
    drawTimeDeadline = 0;

    if (getTopTwoTie()) {
      startServerDrawTime("DRAW TIME 00:00 dan coin masih seri");
      return;
    }

    // Coin sudah berbeda: FINISHED langsung.
    auctionActive = false;
    auctionDrawTime = false;
    auctionFinishedAt = 0;
    io.emit("auction:state", {
      state: "finished",
      active: false,
      drawTime: false,
      version: participantVersion
    });
  }, 20000);

  return true;
}

function scheduleFinishGrace() {
  clearFinishGrace();

  // If the result is already tied at 00:00, DRAW TIME starts immediately.
  if (getTopTwoTie()) {
    startServerDrawTime("00:00 dan coin sudah seri");
    return;
  }

  auctionFinishedAt = Date.now();

  console.log(`[Auction] FINISHED -> grace ${AUCTION_FINISH_GRACE_MS / 1000} detik dimulai.`);

  graceDrawCheckTimer = setTimeout(() => {
    graceDrawCheckTimer = null;

    if (auctionActive || auctionDrawTime || auctionFinishedAt <= 0) return;

    if (getTopTwoTie()) {
      startServerDrawTime("Grace 4 detik selesai dan coin seri");
    } else {
      auctionFinishedAt = 0;
      console.log("[Auction] Grace selesai -> coin tidak seri -> FINISHED");
    }
  }, AUCTION_FINISH_GRACE_MS);
}

function checkGraceAfterGift() {
  if (auctionFinishedAt <= 0 || auctionActive || auctionDrawTime) return;

  // Do not wait for the remaining grace when a late gift makes the result tie.
  if (getTopTwoTie()) {
    startServerDrawTime("gift masuk saat grace dan coin langsung seri");
  }
}

/* =========================================================
   GIFT DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();
const processedGiftFingerprints = new Map();
const processedStreakProgress = new Map();
let processedGiftEventsCleanupAt = 0;

const GIFT_TTL = 60 * 1000;
const GIFT_FINGERPRINT_TTL = 1500;
// TikTok/TikTool can occasionally deliver the same normal gift through
// two channels with different transaction/message IDs. Keep a very short
// semantic guard for that case; combo/streak gifts use their own delta logic.
const GIFT_SEMANTIC_TTL = 300;

/* =========================================================
   LOAD TIKTOK CONNECTOR
   ========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  // @tiktool/live v2.x menggunakan TikTokLive.
  // WebcastPushConnection BUKAN constructor untuk package ini.
  const mod = require("@tiktool/live");

  TikTokLiveConnection =
    mod.TikTokLive ||
    mod.default?.TikTokLive ||
    mod.default;

  if (typeof TikTokLiveConnection !== "function") {
    throw new Error(
      "TikTokLive tidak ditemukan dari @tiktool/live. Pastikan dependency @tiktool/live terinstall."
    );
  }

  return TikTokLiveConnection;
}

/* =========================================================
   CLEAN USERNAME
   ========================================================= */

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/live.*$/i, "")
    .replace(/[/?#].*$/g, "")
    .replace(/\s+/g, "");
}

/* =========================================================
   STATUS
   ========================================================= */

function emitStatus(message, ok = false, extra = {}) {
  console.log(`[STATUS] ${message}`);

  io.emit("live:status", {
    message,
    ok,
    username: activeUsername,
    phase: tikTokConnectionState,
    eventCount: tikTokEventCount,
    giftCount: tikTokGiftCount,
    lastEventAt: tikTokLastEventAt || null,
    lastGiftAt: tikTokLastGiftAt || null,
    connectedAt: tikTokConnectedAt || null,
    reconnectCount: tikTokReconnectCount,
    error: tikTokLastError || null,
    serverTime: Date.now(),
    ...extra
  });
}

function setTikTokState(phase, message, ok = false, extra = {}) {
  tikTokConnectionState = phase;
  emitStatus(message, ok, extra);
}

function noteTikTokEvent(type = "event") {
  tikTokEventCount += 1;
  tikTokLastEventAt = Date.now();

  if (type === "gift") {
    tikTokGiftCount += 1;
    tikTokLastGiftAt = tikTokLastEventAt;
  }

  io.emit("live:status", {
    message:
      type === "gift"
        ? `Event gift diterima dari TikTok @${activeUsername}`
        : `Event ${type} diterima dari TikTok @${activeUsername}`,
    ok: tikTokConnectionState === "connected",
    username: activeUsername,
    phase: tikTokConnectionState,
    eventCount: tikTokEventCount,
    giftCount: tikTokGiftCount,
    lastEventAt: tikTokLastEventAt,
    lastGiftAt: tikTokLastGiftAt || null,
    connectedAt: tikTokConnectedAt || null,
    reconnectCount: tikTokReconnectCount,
    error: tikTokLastError || null,
    serverTime: Date.now()
  });
}

/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {
  const msg =
    err?.message ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const s = msg.toLowerCase();

  if (
    s.includes("offline") ||
    s.includes("not live") ||
    s.includes("useroffline")
  ) {
    return "Akun TikTok tidak sedang LIVE atau username tidak benar.";
  }

  if (
    s.includes("timeout") ||
    s.includes("timed out")
  ) {
    return "Koneksi ke TikTok timeout. Coba lagi beberapa detik kemudian.";
  }

  if (
    s.includes("sign") ||
    s.includes("signature") ||
    s.includes("euler") ||
    s.includes("business plan") ||
    s.includes("404")
  ) {
    return "TikTok/TikTool signing menolak koneksi. Periksa TIKTOOL_API_KEY di Railway Variables.";
  }

  return msg;
}

/* =========================================================
   NUMBER HELPER
   ========================================================= */

function numberPositive(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const n = Number(value);

    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }

  return 0;
}

/* =========================================================
   USER DATA
   ========================================================= */

function unwrapTikTokEvent(event) {
  /*
   * TikTool's documented GiftEvent is normally already flat:
   * { user, giftId, giftName, diamondCount, repeatCount, ... }.
   * Some transports/wrappers can however deliver:
   *   { event: "gift", data: {...} }
   * or { type: "gift", payload: {...} }.
   *
   * Normalize ALL of those forms before parsing. This is deliberately
   * limited to known wrapper fields so ordinary gift payload fields
   * cannot be accidentally replaced.
   */
  let current = event || {};

  for (let i = 0; i < 4; i++) {
    if (!current || typeof current !== "object") {
      break;
    }

    let next = null;

    if (
      current.data &&
      typeof current.data === "object"
    ) {
      next = current.data;
    } else if (
      current.payload &&
      typeof current.payload === "object"
    ) {
      next = current.payload;
    } else if (
      current.message &&
      typeof current.message === "object"
    ) {
      next = current.message;
    }

    if (!next || next === current) {
      break;
    }

    current = next;
  }

  /*
   * A few webhook/transport adapters can put data in a JSON string.
   * Accept it when it is an object-shaped JSON payload.
   */
  if (typeof current === "string") {
    try {
      const parsed = JSON.parse(current);
      if (parsed && typeof parsed === "object") {
        return unwrapTikTokEvent(parsed);
      }
    } catch (_) {}
  }

  return current || {};
}

function userData(event) {
  event = unwrapTikTokEvent(event);
  const user = event?.user || {};

  const userId =
    user.userId ||
    user.id ||
    event?.senderUserId ||
    event?.sender_user_id ||
    event?.userId ||
    event?.user_id ||
    "unknown";

  const uniqueId =
    user.uniqueId ||
    event?.uniqueId ||
    event?.nickname ||
    "Viewer";

  const nickname =
    user.nickname ||
    event?.nickname ||
    user.uniqueId ||
    user.unique_id ||
    event?.uniqueId ||
    event?.unique_id ||
    "Viewer";

  const avatar =
    user.profilePictureUrl ||
    user.profilePicture?.url ||
    user.profilePicture?.urls?.[0] ||
    event?.profilePictureUrl ||
    event?.profilePicture ||
    null;

  return {
    userId: String(userId),
    uniqueId: String(uniqueId),
    nickname: String(nickname),
    avatar
  };
}

/* =========================================================
   GIFT DATA
   ========================================================= */

function giftData(event) {
  event = unwrapTikTokEvent(event);

  if (!event) {
    return null;
  }

  const user = userData(event);

  /* -------------------------------------------------------
     GIFT ID
     ------------------------------------------------------- */

  const giftId = String(
    event.giftId ??
    event.gift_id ??
    event.gift?.giftId ??
    event.gift?.gift_id ??
    event.giftDetails?.giftId ??
    event.giftDetails?.gift_id ??
    ""
  );

  /* -------------------------------------------------------
     GIFT NAME
     ------------------------------------------------------- */

  const giftName =
    event.giftName ||
    event.gift_name ||
    event.gift?.giftName ||
    event.gift?.name ||
    event.giftDetails?.giftName ||
    event.giftDetails?.name ||
    (giftId ? `Gift #${giftId}` : "Gift");

  /* -------------------------------------------------------
     DIAMOND / COIN COUNT
     ------------------------------------------------------- */

  // TikTool dapat mengirim nilai gift pada payload flat maupun pada
  // object bertingkat. Ambil field yang benar-benar merepresentasikan
  // nilai gift sebelum memakai fallback generik. Jangan memakai
  // repeatCount sebagai coin karena itu hanya jumlah pengulangan gift.
  const diamondCount = numberPositive(
    event.diamondCount,
    event.diamond_count,
    event.diamondCost,
    event.diamond_cost,
    event.coinValue,
    event.coin_value,
    event.coinCount,
    event.coin_count,
    event.coins,
    event.diamondValue,
    event.diamond_value,
    event.coin,
    event.coin_value_total,

    event.gift?.diamondCount,
    event.gift?.diamond_count,
    event.gift?.diamondCost,
    event.gift?.diamond_cost,
    event.gift?.coinValue,
    event.gift?.coin_value,
    event.gift?.coinCount,
    event.gift?.coin_count,
    event.gift?.coins,
    event.gift?.diamondValue,
    event.gift?.diamond_value,
    event.gift?.coin,

    event.giftDetails?.diamondCount,
    event.giftDetails?.diamond_count,
    event.giftDetails?.diamondCost,
    event.giftDetails?.diamond_cost,
    event.giftDetails?.coinValue,
    event.giftDetails?.coin_value,
    event.giftDetails?.coinCount,
    event.giftDetails?.coin_count,
    event.giftDetails?.coins,
    event.giftDetails?.diamondValue,
    event.giftDetails?.diamond_value,
    event.giftDetails?.coin,

    event.extendedGiftInfo?.diamondCount,
    event.extendedGiftInfo?.diamond_count,
    event.extendedGiftInfo?.diamondCost,
    event.extendedGiftInfo?.diamond_cost,
    event.extendedGiftInfo?.coinValue,
    event.extendedGiftInfo?.coin_value,
    event.extendedGiftInfo?.coinCount,
    event.extendedGiftInfo?.coin_count,
    event.extendedGiftInfo?.coins,
    event.extendedGiftInfo?.diamondValue,
    event.extendedGiftInfo?.diamond_value,
    event.extendedGiftInfo?.coin
  );

  // Be tolerant of additional TikTool nesting (for example payloads
  // wrapped in giftInfo/giftData). Only inspect known value field names.
  let resolvedDiamondCount = diamondCount;
  if (resolvedDiamondCount <= 0) {
    const valueKeys = new Set([
      "diamondCount", "diamond_count", "diamondCost", "diamond_cost",
      "coinValue", "coin_value", "coinCount", "coin_count", "coins",
      "diamondValue", "diamond_value", "coin"
    ]);

    const scanGiftValue = (value, depth = 0, seen = new Set()) => {
      if (resolvedDiamondCount > 0 || depth > 5 || value === null || value === undefined) {
        return;
      }
      if (typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (valueKeys.has(key)) {
          const n = Number(child);
          if (Number.isFinite(n) && n > 0) {
            resolvedDiamondCount = n;
            return;
          }
        }
      }

      for (const child of Object.values(value)) {
        if (child && typeof child === "object") {
          scanGiftValue(child, depth + 1, seen);
          if (resolvedDiamondCount > 0) return;
        }
      }
    };

    scanGiftValue(event);
  }

  /* -------------------------------------------------------
     REPEAT COUNT
     ------------------------------------------------------- */

  const rawRepeatCount =
    event.repeatCount ??
    event.repeat_count ??
    event.repeat ??
    event.gift?.repeatCount ??
    event.gift?.repeat_count ??
    event.gift?.repeat ??
    event.giftDetails?.repeatCount ??
    event.giftDetails?.repeat_count ??
    1;

  let repeatCount = Number(rawRepeatCount);

  if (
    !Number.isFinite(repeatCount) ||
    repeatCount < 1
  ) {
    repeatCount = 1;
  }

  repeatCount = Math.floor(repeatCount);

  /* -------------------------------------------------------
     GIFT TYPE
     ------------------------------------------------------- */

  const giftTypeRaw =
    event.giftType ??
    event.gift_type ??
    event.gift?.giftType ??
    event.gift?.gift_type ??
    event.giftDetails?.giftType ??
    event.giftDetails?.gift_type ??
    0;

  const giftType = Number(giftTypeRaw) || 0;
  const isCombo =
    giftType === 1 ||
    event.combo === true ||
    event.combo === 1 ||
    event.combo === "1" ||
    event.gift?.combo === true ||
    event.gift?.combo === 1;

  /* -------------------------------------------------------
     REPEAT END
     ------------------------------------------------------- */

  const repeatValue =
    event.repeatEnd ??
    event.repeat_end ??
    event.gift?.repeatEnd ??
    event.gift?.repeat_end;

  const repeatEnd =
    repeatValue === true ||
    repeatValue === 1 ||
    repeatValue === "1" ||
    repeatValue === "true";

  /* -------------------------------------------------------
     VALIDASI DASAR
     ------------------------------------------------------- */

  // giftId is useful for deduplication, but it is not required
  // to accept a valid gift. Some TikTool payloads can omit it.
  if (!giftId) {
    console.log(
      `[GIFT] giftId tidak ada, tetap diproses karena coin/diamond=${resolvedDiamondCount}.`
    );
  }

  if (resolvedDiamondCount <= 0) {
    console.log(
      `[GIFT] ${giftName} diabaikan: nilai coin/diamond tidak ditemukan pada payload.`
    );

    return null;
  }

  // Identitas event dipakai juga untuk melacak progress streak saat DRAW TIME.
  const msgId = event.msgId || event.msg_id || null;
  const transactionId = event.transactionId || event.transaction_id || null;
  const groupId = event.groupId || event.group_id || null;
  const createTime = event.createTime || event.create_time || event.timestamp || null;

  /* -------------------------------------------------------
     GIFT STREAK / COMBO — FAST INCREMENTAL MODE

     Jangan menunggu repeatEnd=true. TikTok/TikTool dapat mengirim
     progress x1 lebih dulu lalu final x1 beberapa detik kemudian.
     Menunggu final membuat gift terlihat terlambat di leaderboard.

     Sekarang setiap kenaikan repeatCount langsung dihitung sebagai DELTA:
       x1 -> +1 gift
       x2 -> +1 gift lagi
       x3 -> +1 gift lagi
       final x3 -> +0 (sudah pernah dihitung)

     Dengan cara ini gift langsung masuk peserta, tetapi final event
     tidak menggandakan coin.
     ------------------------------------------------------- */

  let comboKey = null;
  let comboDelta = 0;

  if (isCombo) {
    repeatCount = Math.max(1, Math.floor(repeatCount));

    // transactionId biasanya stabil sepanjang satu combo. groupId dan
    // createTime menjadi fallback untuk transport yang tidak menyediakan
    // transactionId.
    comboKey = transactionId
      ? `tx:${transactionId}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
      : groupId
        ? `group:${groupId}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
        : createTime
          ? `time:${createTime}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
          : null;

    if (comboKey) {
      const previousRepeat = Number(processedStreakProgress.get(comboKey) || 0);
      comboDelta = repeatCount - previousRepeat;

      if (comboDelta <= 0) {
        console.log(
          `[GIFT] Combo update sudah diproses: @${user.uniqueId} | ${giftName} | x${repeatCount} | final=${repeatEnd}`
        );
        return null;
      }

      processedStreakProgress.set(comboKey, repeatCount);

      console.log(
        `[GIFT-FAST] Combo @${user.uniqueId} | ${giftName} | x${repeatCount} | delta=${comboDelta} | final=${repeatEnd}`
      );
    } else {
      // Jika transport benar-benar tidak menyediakan identitas combo,
      // proses event pertama agar gift tidak tertahan. Event berikutnya
      // tetap dilindungi oleh duplicate/fingerprint guard.
      comboDelta = 1;
    }
  }

  /* -------------------------------------------------------
     COIN VALUE
     ------------------------------------------------------- */

  // Coin peserta = nilai coin/diamond TikTok.
  // Gift biasa tetap 1:1. Combo hanya menambahkan DELTA gift yang belum
  // pernah diproses sehingga tidak double.
  const coinValue =
    isCombo
      ? resolvedDiamondCount * comboDelta
      : resolvedDiamondCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  /* =======================================================
     DUPLICATE PROTECTION
     ======================================================= */

  /*
   * Prioritas ID:
   *
   * 1. transactionId
   * 2. msgId
   * 3. groupId + user + gift + repeatCount
   * 4. fallback event signature
   */

  let eventKey;

  /*
   * IMPORTANT: transactionId/msgId/groupId alone are NOT guaranteed to be
   * unique for every gift update. Using them alone can discard a legitimate
   * gift, which makes the participant appear not to receive coins.
   * Include the sender + gift + repeat state in the dedupe key.
   * For streak gifts, repeatCount is already converted to the NEW delta above.
   */
  const senderKey = String(
    user.userId && user.userId !== "unknown"
      ? user.userId
      : user.uniqueId || user.nickname || "viewer"
  ).trim().toLowerCase();
  const giftKey = String(giftId || giftName || "gift").trim().toLowerCase();
  const repeatKey = `${repeatCount}|${repeatEnd ? 1 : 0}`;

  if (transactionId) {
    eventKey = `transaction:${transactionId}|${senderKey}|${giftKey}|${repeatKey}`;
  } else if (msgId) {
    eventKey = `msg:${msgId}|${senderKey}|${giftKey}|${repeatKey}`;
  } else if (groupId) {
    // groupId dapat dipakai untuk beberapa update/gift dalam combo.
    // Jangan jadikan groupId saja sebagai ID unik selama 60 detik karena
    // dua gift terpisah dari user yang sama bisa memiliki groupId yang sama.
    eventKey = `group:${groupId}|${senderKey}|${giftKey}|${repeatKey}|${createTime || Math.floor(Date.now() / 1000)}`;
  } else {
    const fallbackTime = createTime || Math.floor(Date.now() / 1000);
    eventKey =
      `fallback:${senderKey}|${giftKey}|${repeatKey}|${fallbackTime}`;
  }

  /* -------------------------------------------------------
     CLEAN OLD EVENTS
     ------------------------------------------------------- */

  const now = Date.now();

  // Bersihkan duplicate cache secara berkala, bukan pada setiap gift.
  // Ini menjaga jalur gift tetap ringan ketika banyak gift masuk bersamaan.
  if (
    processedGiftEvents.size > 0 &&
    (processedGiftEventsCleanupAt === 0 ||
      now >= processedGiftEventsCleanupAt)
  ) {
    for (const [key, time] of processedGiftEvents.entries()) {
      if (now - time > GIFT_TTL) {
        processedGiftEvents.delete(key);
      }
    }

    for (const [key, time] of processedGiftFingerprints.entries()) {
      if (now - time > GIFT_FINGERPRINT_TTL) {
        processedGiftFingerprints.delete(key);
      }
    }

    processedGiftEventsCleanupAt = now + 5000;
  }

  /* -------------------------------------------------------
     DUPLICATE CHECK
     ------------------------------------------------------- */

  if (eventKey && processedGiftEvents.has(eventKey)) {
    console.log(
      `[GIFT] DUPLICATE diabaikan: ${eventKey}`
    );
    return null;
  }

  /*
   * SECONDARY DUPLICATE GUARD:
   * Satu gift kadang tiba melalui dua transport dengan ID berbeda.
   */
  const fingerprintTime =
    createTime !== null &&
    createTime !== undefined &&
    String(createTime).trim() !== ""
      ? String(createTime).trim()
      : null;

  const giftFingerprint = fingerprintTime
    ? `fingerprint:${senderKey}|${giftKey}|${resolvedDiamondCount}|${repeatCount}|${repeatEnd ? 1 : 0}|${fingerprintTime}`
    : null;

  /*
   * LAST-RESORT DUPLICATE GUARD.
   *
   * V34 mempunyai bug penting: transportFingerprint disimpan terlebih
   * dahulu, lalu langsung dibaca kembali sebagai duplicate. Akibatnya
   * event gift tanpa transactionId/msgId/groupId/createTime selalu
   * ditolak.
   *
   * Sekarang fingerprint DI-CHECK dahulu dan BARU disimpan setelah event
   * lolos semua pemeriksaan.
   */
  const transportFingerprint =
    !transactionId &&
    !msgId &&
    !groupId &&
    !fingerprintTime
      ? `transport:${senderKey}|${giftKey}|${resolvedDiamondCount}|${repeatCount}|${repeatEnd ? 1 : 0}`
      : null;

  /*
   * SEMANTIC DUPLICATE GUARD:
   * Untuk gift biasa (non-streak), jangan hanya bergantung pada ID.
   * Beberapa transport dapat membuat transactionId/msgId berbeda untuk
   * event gift yang sama. Jika sender + gift + nilai + repeat sama masuk
   * hampir bersamaan, anggap itu satu gift.
   *
   * Hanya berlaku sangat singkat agar dua gift sah yang dikirim terpisah
   * tetap dapat dihitung.
   */
  const semanticFingerprint =
    !isCombo
      ? `semantic:${senderKey}|${giftKey}|${resolvedDiamondCount}|${repeatCount}`
      : null;

  if (
    giftFingerprint &&
    giftFingerprint &&
    processedGiftFingerprints.has(giftFingerprint)
  ) {
    console.log(
      `[GIFT] DUPLICATE fingerprint diabaikan: ${giftFingerprint}`
    );
    return null;
  }

  if (transportFingerprint) {
    const previousTransportTime =
      processedGiftFingerprints.get(transportFingerprint);

    if (
      previousTransportTime &&
      now - previousTransportTime <= 750
    ) {
      console.log(
        `[GIFT] DUPLICATE transport diabaikan: ${transportFingerprint}`
      );
      return null;
    }
  }

  if (semanticFingerprint) {
    const previousSemanticTime =
      processedGiftFingerprints.get(semanticFingerprint);

    if (
      previousSemanticTime &&
      now - previousSemanticTime <= GIFT_SEMANTIC_TTL
    ) {
      console.log(
        `[GIFT] DUPLICATE semantic diabaikan: ${semanticFingerprint}`
      );
      return null;
    }
  }

  /*
   * Event lolos duplicate guard.
   * Tandai cache SEKARANG, bukan sebelum pemeriksaan.
   */
  if (eventKey) {
    processedGiftEvents.set(eventKey, now);
  }

  if (giftFingerprint) {
    processedGiftFingerprints.set(giftFingerprint, now);
  }

  if (transportFingerprint) {
    processedGiftFingerprints.set(transportFingerprint, now);
  }

  if (semanticFingerprint) {
    processedGiftFingerprints.set(semanticFingerprint, now);
  }

  /* -------------------------------------------------------
     LOG
     ------------------------------------------------------- */

  console.log(
    `[GIFT] @${user.uniqueId} | ${giftName} | ${resolvedDiamondCount} x ${repeatCount} = ${coinValue}`
  );

  /* -------------------------------------------------------
     RETURN
     ------------------------------------------------------- */

  return {
    username: user.uniqueId,
    nickname: user.nickname,

    userId: user.userId,
    uniqueId: user.uniqueId,

    giftName,
    giftId,

    diamondCount: resolvedDiamondCount,
    repeatCount,

    coinValue,

    giftType,
    combo: isCombo,
    repeatEnd,

    msgId,
    transactionId,
    groupId,
    createTime,

    avatar: user.avatar
  };
}

/* =========================================================
   LIVE STATUS MONITOR
   ========================================================= */

const handledStreamEndConnections = new WeakSet();

async function markStreamOffline(reason = "TikTok LIVE sudah selesai.") {
  if (!activeUsername) return;

  const username = activeUsername;
  console.warn(`[TikTok] STREAM OFFLINE @${username}: ${reason}`);

  clearTimeout(liveCheckTimer);
  liveCheckTimer = null;

  manualDisconnect = true;
  tikTokConnectionState = "offline";
  tikTokLastError = "";

  const conn = liveConnection;
  liveConnection = null;

  if (conn) {
    try {
      await conn.disconnect();
    } catch (err) {
      console.warn("[TikTok] disconnect setelah stream end:", err?.message || err);
    }
  }

  setTikTokState(
    "offline",
    `TikTok LIVE @${username} sudah selesai/offline.`,
    false,
    { streamEnded: true, reason }
  );
}

function handleStreamEnd(conn, reason = "creator_offline") {
  if (!conn || handledStreamEndConnections.has(conn)) return;
  handledStreamEndConnections.add(conn);
  markStreamOffline(reason).catch((err) => {
    console.error("[TikTok] gagal menandai stream offline:", err);
    setTikTokState(
      "offline",
      `TikTok LIVE @${activeUsername || ""} sudah selesai/offline.`,
      false,
      { streamEnded: true }
    );
  });
}

function startLiveStatusMonitor() {
  clearTimeout(liveCheckTimer);
  liveCheckTimer = null;

  if (!activeUsername || !process.env.TIKTOOL_API_KEY) return;

  const username = activeUsername;

  const check = async () => {
    if (!activeUsername || activeUsername !== username || manualDisconnect) return;

    try {
      const apiKey = encodeURIComponent(String(process.env.TIKTOOL_API_KEY).trim());
      const user = encodeURIComponent(username);
      const response = await fetch(
        `https://api.tik.tools/webcast/check_alive?apiKey=${apiKey}&unique_id=${user}`,
        { headers: { Accept: "application/json" } }
      );

      if (response.ok) {
        const json = await response.json();
        const row = Array.isArray(json?.data) ? json.data[0] : null;

        // Hanya false yang dianggap definitif offline. Error/unknown tidak
        // boleh memutus koneksi aktif secara keliru.
        if (row && row.alive === false) {
          handleStreamEnd(liveConnection, "check_alive: offline");
          return;
        }
      }
    } catch (err) {
      console.warn("[TikTok] live status check gagal:", err?.message || err);
    }

    if (activeUsername === username && !manualDisconnect) {
      liveCheckTimer = setTimeout(check, LIVE_CHECK_INTERVAL);
    }
  };

  liveCheckTimer = setTimeout(check, LIVE_CHECK_INTERVAL);
}

/* =========================================================
   STOP TIKTOK CONNECTION
   ========================================================= */

async function stopConnection() {
  clearTimeout(reconnectTimer);
  clearTimeout(liveCheckTimer);
  liveCheckTimer = null;
  reconnectTimer = null;

  manualDisconnect = true;
  tikTokConnectionState = "offline";

  const conn = liveConnection;

  liveConnection = null;

  if (conn) {
    try {
      await conn.disconnect();
    } catch (err) {
      console.warn(
        "[TikTok] disconnect:",
        err?.message || err
      );
    }
  }
}

/* =========================================================
   CONNECT TIKTOK LIVE
   BAGIAN KONEKSI DIPERTAHANKAN
   ========================================================= */

async function connectToLiveInternal(rawUsername) {
  const Connector =
    await loadTikTokConnector();

  const username =
    cleanUsername(rawUsername);

  if (!username) {
    throw new Error(
      "Username TikTok kosong."
    );
  }

  await stopConnection();

  // Mulai sesi TikTok baru dengan cache dedupe yang bersih.
  // Cache lama tidak boleh membuat gift pertama pada koneksi baru diabaikan.
  processedGiftEvents.clear();
  processedGiftFingerprints.clear();
  processedStreakProgress.clear();
  processedGiftEventsCleanupAt = 0;

  manualDisconnect = false;
  activeUsername = username;

  tikTokConnectionState = "connecting";
  tikTokEventCount = 0;
  tikTokGiftCount = 0;
  tikTokLastEventAt = 0;
  tikTokLastGiftAt = 0;
  tikTokConnectedAt = 0;
  tikTokLastError = "";

  console.log(
    "================================================"
  );

  console.log(
    `[TikTok] Mencoba koneksi @${username}`
  );

  const TIKTOOL_API_KEY =
    String(process.env.TIKTOOL_API_KEY || "").trim();

  if (!TIKTOOL_API_KEY) {
    throw new Error(
      "TIKTOOL_API_KEY belum diset di Railway Variables."
    );
  }

  console.log(
    "[TikTok] MODE @tiktool/live + TIKTOOL API KEY"
  );

  console.log(
    "[TikTok] TikTool signing aktif."
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /* -------------------------------------------------------
     CONNECTION OPTIONS
     @tiktool/live v2.x
     ------------------------------------------------------- */

  /*
   * Gunakan mode DIRECT yang sebelumnya stabil untuk event gift.
   *
   * Versi stable sebelumnya memakai WebSocket direct, autoReconnect, dan
   * maxReconnectAttempts. Pertahankan konfigurasi itu agar event gift
   * TikTok tetap masuk ke listener @tiktool/live.
   */

  // RESTORE MODE YANG SEBELUMNYA STABIL: direct + reconnect internal TikTool.
  // Jangan memakai relayed sebagai default karena pada deployment terakhir
  // connector terlihat connected tetapi tidak menerima event gift.
  const conn = new Connector({
    uniqueId: username,
    apiKey: TIKTOOL_API_KEY,
    autoReconnect: true,
    maxReconnectAttempts: 5,
    // Railway dapat membuat direct WebSocket TikTok tersambung tetapi
    // tidak meneruskan event gift secara konsisten. Gunakan relayed TikTool
    // agar event gift dikirim melalui transport yang dikelola TikTool.
    mode: "relayed",
    debug: false
  });

  console.log("[TikTok] Mode koneksi: relayed (gift event path)");

  liveConnection = conn;

  /* =======================================================
     GIFT EVENT
     ======================================================= */

  // Guard against the same in-memory event being delivered through
  // both the primary "gift" listener and the compatibility "event"
  // listener. Without this guard, one 1-coin gift can be counted twice.
  const handledGiftObjects = new WeakSet();

  const handleGiftEvent = (incomingEvent) => {
    if (incomingEvent && typeof incomingEvent === "object") {
      if (handledGiftObjects.has(incomingEvent)) {
        console.log("[GIFT] DUPLICATE listener event diabaikan");
        return;
      }
      handledGiftObjects.add(incomingEvent);
    }

    const eventReceivedAt = Date.now();
    const event = unwrapTikTokEvent(incomingEvent);

    // FAST PATH: process the gift immediately; no artificial delay.
    // Keep Railway logging lightweight so a burst of gifts cannot spend
    // unnecessary time serializing the complete raw TikTok payload.
    /* -----------------------------------------------------
       PARSE GIFT
       -----------------------------------------------------
       giftData() juga menjadi gerbang duplicate protection.
       Counter monitor HARUS dinaikkan setelah gift lolos gerbang ini,
       bukan pada saat listener menerima frame. Dengan begitu satu combo
       yang datang melalui channel gift + generic event tidak tampil
       sebagai 2 gift di monitor.
       ----------------------------------------------------- */

    const gift =
      giftData(event);

    if (!gift) {
      console.log(
        "[GIFT] event diterima tetapi gift tidak valid/complete atau duplicate/progress combo"
      );
      return;
    }

    noteTikTokEvent("gift");

    // Diagnostic only: measure upstream delivery delay without changing
    // the TikTok connection or gift-processing logic.
    const rawCreateTime = gift.createTime || null;
    let upstreamGiftDelayMs = null;
    if (rawCreateTime !== null && rawCreateTime !== undefined && rawCreateTime !== "") {
      const numericCreateTime = Number(rawCreateTime);
      if (Number.isFinite(numericCreateTime)) {
        const createTimeMs = numericCreateTime < 100000000000
          ? numericCreateTime * 1000
          : numericCreateTime;
        if (createTimeMs > 0) {
          upstreamGiftDelayMs = Math.max(0, eventReceivedAt - createTimeMs);
        }
      }
    }
    console.log(
      `[GIFT-FAST] @${gift.uniqueId || gift.username || "Viewer"} | serverReceive=${eventReceivedAt}` +
      (upstreamGiftDelayMs !== null ? ` | upstreamDelay=${upstreamGiftDelayMs}ms` : "")
    );

    // Gift hanya boleh menambah coin ketika lelang sedang aktif.
    // Monitor tetap mencatat gift yang benar-benar diterima walaupun
    // lelang sedang tidak aktif.
    if (!auctionActive && auctionFinishedAt <= 0) {
      console.log(
        "[GIFT] DIABAIKAN: auction sudah selesai/tidak aktif"
      );
      return;
    }

    /* =====================================================
       PARTICIPANT KEY
       ===================================================== */

    let key;

    if (
      gift.userId &&
      gift.userId !== "unknown"
    ) {
      key = `id:${gift.userId}`;
    } else if (
      gift.uniqueId
    ) {
      key = `unique:${gift.uniqueId.toLowerCase()}`;
    } else if (
      gift.username
    ) {
      key = `username:${gift.username.toLowerCase()}`;
    } else {
      key = `name:${String(gift.nickname || "viewer").toLowerCase()}`;
    }

    /* -----------------------------------------------------
       PARTICIPANT SEBELUMNYA
       -----------------------------------------------------
       TikTok/TikTool kadang mengirim userId pada satu event dan
       tidak pada event berikutnya. Cocokkan juga uniqueId/username
       agar coin tidak terpecah ke peserta baru.
       ----------------------------------------------------- */

    let previous = participants.get(key);

    if (!previous) {
      const uniqueId =
        String(gift.uniqueId || "").trim().toLowerCase();
      const username =
        String(gift.username || "").trim().toLowerCase();

      for (const [existingKey, existingParticipant] of participants.entries()) {
        const existingUniqueId =
          String(existingParticipant?.uniqueId || "").trim().toLowerCase();
        const existingUsername =
          String(existingParticipant?.username || "").trim().toLowerCase();

        if (
          (uniqueId && existingUniqueId === uniqueId) ||
          (username && existingUsername === username)
        ) {
          key = existingKey;
          previous = existingParticipant;
          break;
        }
      }
    }

    /* -----------------------------------------------------
       COIN SEBELUMNYA
       ----------------------------------------------------- */

    const previousCoins =
      Number(previous?.coins) || 0;

    /* -----------------------------------------------------
       COIN GIFT
       ----------------------------------------------------- */

    const giftCoins =
      Number(gift.coinValue) || 0;

    /* -----------------------------------------------------
       TOTAL COIN
       ----------------------------------------------------- */

    const totalCoins =
      previousCoins + giftCoins;

    /* -----------------------------------------------------
       PARTICIPANT BARU / UPDATE
       ----------------------------------------------------- */

    const participant = {
      userId:
        gift.userId ||
        previous?.userId ||
        "unknown",

      uniqueId:
        gift.uniqueId ||
        previous?.uniqueId ||
        gift.username ||
        key,

      username:
        gift.username ||
        previous?.username ||
        gift.uniqueId ||
        key,

      nickname:
        gift.nickname ||
        previous?.nickname ||
        gift.username ||
        "Viewer",

      avatar:
        gift.avatar ||
        previous?.avatar ||
        null,

      coins:
        totalCoins,

      joinedAt:
        previous?.joinedAt ||
        Date.now()
    };

    /* -----------------------------------------------------
       SIMPAN PESERTA
       ----------------------------------------------------- */

    participants.set(
      key,
      participant
    );

    participantVersion += 1;

    /* =====================================================
       PAYLOAD GIFT
       ===================================================== */

    const payload = {
      ...gift,
      serverReceivedAt: eventReceivedAt,
      upstreamGiftDelayMs,

      participant,

      version:
        participantVersion
    };

    /* =====================================================
       KIRIM KE FRONTEND SECEPATNYA
       ===================================================== */

    /* Gift individual */
    io.emit(
      "live:gift",
      payload
    );

    /* State peserta yang baru berubah — kirim segera */
    io.emit(
      "auction:participant:update",
      {
        version:
          participantVersion,

        participant,

        gift
      }
    );

    /*
     * FAST PATH: jangan serialisasi seluruh leaderboard secara sinkron pada
     * jalur gift. `participant:update` di atas sudah membawa participant
     * terbaru dan menjadi event utama untuk leaderboard.
     *
     * Untuk kompatibilitas frontend lama yang masih mendengarkan
     * `auction:participants`, kirim snapshot setelah callback gift selesai
     * sehingga tidak menahan TikTok -> participant:update.
     */
    const snapshotVersion = participantVersion;
    const snapshotParticipants = Array.from(participants.values());
    setImmediate(() => {
      io.emit("auction:participants", {
        version: snapshotVersion,
        participants: snapshotParticipants
      });
    });

    // A late gift during the 4-second grace can create a tie.
    // Start DRAW TIME immediately instead of waiting for the grace timer.
    checkGraceAfterGift();
  };

  // Standard TikTool event.
  conn.on("gift", handleGiftEvent);

  // Lightweight diagnostics: confirms that the live socket is actually
  // delivering named events. This does not alter auction processing.
  for (const eventName of ["roomInfo", "like", "member", "social", "subscribe", "viewerCount"]) {
    conn.on(eventName, () => noteTikTokEvent(eventName));
  }

  // Compatibility with transports that expose all events via `event`.
  // Only use this fallback when the event transport is actually needed.
  // The normal "gift" listener remains the primary/fast path.
  conn.on("event", (incomingEvent, maybePayload) => {
    /*
     * @tiktool/live documents the generic event channel as:
     *   event.type === "gift"
     *
     * Some adapters instead expose (type, payload), while raw/relayed
     * transports can expose { event: "gift", data: {...} }.
     * Normalize all three forms before deciding whether this is a gift.
     */
    let candidate = incomingEvent;

    if (
      typeof incomingEvent === "string" &&
      maybePayload &&
      typeof maybePayload === "object"
    ) {
      candidate = {
        type: incomingEvent,
        data: maybePayload
      };
    }

    const event = unwrapTikTokEvent(candidate);
    const type = String(
      candidate?.event ||
      candidate?.type ||
      event?.event ||
      event?.type ||
      ""
    ).toLowerCase();

    if (type === "streamend") {
      handleStreamEnd(
        conn,
        event?.reason || candidate?.data?.reason || "creator_offline"
      );
      return;
    }

    if (type !== "gift") return;

    console.log("[GIFT] diterima melalui generic event channel");

    // IMPORTANT:
    // Some @tiktool/live transports deliver the gift ONLY through the
    // generic "event" channel. The primary "gift" listener and this
    // compatibility path share the same duplicate protection.
    handleGiftEvent(candidate);
  });

  // TikTool v3 juga menyediakan streamEnd saat creator benar-benar
  // mengakhiri LIVE. Tangani langsung agar status tidak tetap hijau.
  conn.on("streamEnd", (event) => {
    handleStreamEnd(
      conn,
      event?.reason || "creator_offline"
    );
  });

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on("chat", (event) => {
    noteTikTokEvent("chat");

    io.emit(
      "live:event",
      {
        type: "chat",

        username:
          event?.user?.uniqueId ||
          event?.uniqueId ||
          "Viewer"
      }
    );
  });

  /* =======================================================
     CONNECTED
     ======================================================= */

  conn.on("connected", (state) => {
    tikTokConnectionState = "connected";
    tikTokConnectedAt = Date.now();
    tikTokLastError = "";

    console.log(
      "[TikTok] CONNECTED event diterima:",
      state
    );

    setTikTokState(
      "connected",
      `TikTok BENAR-BENAR TERHUBUNG ke LIVE @${activeUsername}`,
      true,
      { roomId: conn.roomId || state?.roomId || null }
    );
  });

  /* =======================================================
     ERROR
     ======================================================= */

  conn.on("error", (err) => {
    const friendly = formatError(err);
    tikTokLastError = friendly;

    console.error(
      "[TikTok] error:",
      err
    );

    setTikTokState(
      "error",
      `Error TikTok: ${friendly}`,
      false
    );
  });

  /* =======================================================
     DISCONNECTED
     ======================================================= */

  conn.on("disconnected", () => {
    console.warn(
      `[TikTok] @${activeUsername} TERPUTUS.`
    );

    tikTokConnectionState = "reconnecting";

    if (
      manualDisconnect ||
      liveConnection !== conn ||
      !activeUsername
    ) {
      setTikTokState(
        "offline",
        `TikTok LIVE @${activeUsername || ""} diputus.`,
        false
      );
      return;
    }

    setTikTokState(
      "reconnecting",
      `TikTok LIVE @${activeUsername} terputus. Mencoba terhubung kembali...`,
      false
    );

    clearTimeout(
      reconnectTimer
    );

    tikTokReconnectCount += 1;

    // @tiktool/live is already configured with autoReconnect.
    // Do NOT call connectToLive() here: that function first disconnects
    // the current connector, which can create the "Koneksi TikTok
    // digantikan oleh koneksi lain" loop seen on Railway.
    // Leave the same connector alive so its internal reconnect can restore
    // the WebSocket without replacing the gift listener.
    console.log(
      `[TikTok] Menunggu autoReconnect @${activeUsername} tanpa membuat connector baru.`
    );
  });

  /* =======================================================
     CONNECT
     ======================================================= */

  try {
    await conn.connect();
    const state = {
      roomId: conn.roomId || null
    };

    if (
      liveConnection !== conn
    ) {
      try {
        await conn.disconnect();
      } catch (_) {}

      throw new Error(
        "Koneksi TikTok digantikan oleh koneksi lain."
      );
    }

    const roomId =
      conn.roomId ||
      state?.roomId ||
      null;

    // Jangan menganggap await connect() saja sebagai bukti stream event.
    // Status hijau hanya dipakai ketika connector benar-benar connected.
    const connectorConnected = Boolean(
      conn.connected === true ||
      conn.isConnected === true ||
      state?.isConnected === true
    );

    if (connectorConnected && tikTokConnectionState !== "connected") {
      tikTokConnectionState = "connected";
      tikTokConnectedAt = Date.now();
    }

    if (tikTokConnectionState === "connected") {
      emitStatus(
        `TikTok TERHUBUNG ke LIVE @${username} • Room ${roomId || "aktif"} • Menunggu event`,
        true,
        { roomId }
      );

      console.log(
        `[TikTok] CONNECTED & LISTENING @${username}`
      );
    } else {
      setTikTokState(
        "connected_waiting",
        `Transport TikTok tersambung ke @${username}, menunggu konfirmasi stream event...`,
        false,
        { roomId }
      );

      console.warn(
        `[TikTok] connect() selesai tetapi status connected belum terkonfirmasi.`
      );
    }

    if (typeof conn.eventCount !== "undefined") {
      console.log(
        `[TikTok] connector eventCount awal: ${conn.eventCount}`
      );
    }

    // Fallback liveness monitor: beberapa relay menutup socket beberapa saat
    // setelah LIVE berakhir, jadi jangan hanya bergantung pada disconnected.
    startLiveStatusMonitor();

    return state;

  } catch (err) {
    if (
      liveConnection === conn
    ) {
      liveConnection = null;
    }

    const friendly =
      formatError(err);

    tikTokConnectionState = "error";
    tikTokLastError = friendly;

    console.error(
      "[TikTok] gagal connect:",
      err
    );

    emitStatus(
      `Gagal terhubung @${username}: ${friendly}`,
      false
    );

    throw new Error(
      friendly
    );
  }
}

/*
 * Single-flight wrapper. A second socket/browser request for the same
 * username must wait for the first request instead of stopping/replacing
 * its connector. A different username is allowed to replace the old one.
 */
async function connectToLive(rawUsername) {
  const username = cleanUsername(rawUsername);

  if (!username) {
    throw new Error("Username TikTok kosong.");
  }

  if (
    connectRequestInFlight &&
    connectRequestUsername === username
  ) {
    console.log(
      `[TikTok] Menunggu koneksi yang sedang berjalan @${username}.`
    );
    return connectRequestInFlight;
  }

  connectRequestUsername = username;

  const request = connectToLiveInternal(username);
  connectRequestInFlight = request;

  try {
    return await request;
  } finally {
    if (connectRequestInFlight === request) {
      connectRequestInFlight = null;
      connectRequestUsername = null;
    }
  }
}


/* =========================================================
   SOCKET CONNECTION
   ========================================================= */

io.on("connection", (socket) => {
  console.log(
    `[Socket] Client terhubung: ${socket.id}`
  );

  /* =======================================================
     CONNECTION STATUS
     ======================================================= */

  const connected =
    tikTokConnectionState === "connected";

  socket.emit(
    "live:status",
    {
      ok: connected,
      message: connected
        ? `TikTok TERHUBUNG ke @${activeUsername}`
        : activeUsername
          ? `TikTok ${tikTokConnectionState}: @${activeUsername}`
          : "Belum terhubung ke TikTok LIVE",
      username: activeUsername,
      phase: tikTokConnectionState,
      eventCount: tikTokEventCount,
      giftCount: tikTokGiftCount,
      lastEventAt: tikTokLastEventAt || null,
      lastGiftAt: tikTokLastGiftAt || null,
      connectedAt: tikTokConnectedAt || null,
      reconnectCount: tikTokReconnectCount,
      error: tikTokLastError || null,
      serverTime: Date.now()
    }
  );

  /* =======================================================
     AUCTION STATE
     ======================================================= */

  socket.emit(
    "auction:state",
    {
      state:
        auctionActive
          ? "running"
          : "idle",

      active:
        auctionActive,

      drawTime:
        auctionDrawTime,

      drawTimeDeadline:
        auctionDrawTime && drawTimeDeadline > 0
          ? drawTimeDeadline
          : undefined,

      version:
        participantVersion
    }
  );

  /* =======================================================
     SEND CURRENT PARTICIPANTS
     ======================================================= */

  socket.emit(
    "auction:participants",
    {
      version:
        participantVersion,

      participants:
        Array.from(
          participants.values()
        )
    }
  );

  /* =======================================================
     LIVE CONNECT
     ======================================================= */

  socket.on(
    "live:connect",
    async (data = {}) => {
      try {
        if (!data.username) {
          throw new Error(
            "Masukkan username TikTok terlebih dahulu."
          );
        }

        const requestedUsername = cleanUsername(data.username);

        // Do not let a second click / duplicate browser event tear down
        // the connection that is already connecting or connected.
        if (
          requestedUsername &&
          requestedUsername === activeUsername &&
          liveConnection &&
          ["connecting", "connected_waiting", "connected", "reconnecting"].includes(
            tikTokConnectionState
          )
        ) {
          console.log(
            `[TikTok] Duplicate connect request ignored for @${requestedUsername}`
          );
          socket.emit("live:status", {
            message:
              tikTokConnectionState === "connected"
                ? `TikTok TERHUBUNG ke @${requestedUsername}`
                : `TikTok @${requestedUsername} sedang ${tikTokConnectionState}...`,
            ok: tikTokConnectionState === "connected",
            username: activeUsername,
            phase: tikTokConnectionState,
            eventCount: tikTokEventCount,
            giftCount: tikTokGiftCount,
            lastEventAt: tikTokLastEventAt || null,
            lastGiftAt: tikTokLastGiftAt || null,
            connectedAt: tikTokConnectedAt || null,
            reconnectCount: tikTokReconnectCount,
            error: tikTokLastError || null,
            serverTime: Date.now()
          });
          return;
        }

        await connectToLive(
          data.username
        );

      } catch (err) {
        console.error(
          "[Socket] live:connect:",
          err
        );

        socket.emit(
          "live:error",
          {
            message:
              err?.message ||
              "Gagal menghubungkan TikTok LIVE."
          }
        );
      }
    }
  );

  /* =======================================================
     AUCTION STATE
     ======================================================= */

  socket.on(
    "auction:state",
    (data = {}) => {
      const requestedState =
        String(
          data?.state ||
          (
            data?.active
              ? "running"
              : "idle"
          )
        );

      if (requestedState === "finished") {
        // A delayed FINISHED from the browser must never cancel a
        // server-authoritative DRAW TIME that has already started.
        if (auctionDrawTime && auctionActive) {
          console.log("[Auction] FINISHED stale diabaikan karena DRAW TIME sedang aktif.");
          return;
        }

        auctionActive = false;
        auctionDrawTime = false;
        drawTimeDeadline = 0;
        processedStreakProgress.clear();

        // Tell the browser that the main countdown ended, then keep the
        // server open for late TikTok gifts for up to 4 seconds.
        io.emit("auction:state", {
          state: "finished",
          active: false,
          drawTime: false,
          version: participantVersion
        });

        scheduleFinishGrace();
        return;
      }

      if (requestedState === "idle" || requestedState === "paused") {
        clearFinishGrace();
        auctionActive = requestedState === "paused" ? true : false;
        auctionDrawTime = false;
        drawTimeDeadline = 0;
        processedStreakProgress.clear();
      } else {
        auctionActive = true;
        auctionDrawTime = data?.drawTime === true;

        if (auctionDrawTime) {
          clearFinishGrace();
        }
      }

      console.log(
        `[Auction] state=${requestedState} active=${auctionActive} drawTime=${auctionDrawTime}`
      );

      io.emit(
        "auction:state",
        {
          state: requestedState,
          active: auctionActive,
          drawTime: auctionDrawTime,
          drawTimeDeadline: data?.drawTimeDeadline || undefined,
          version: participantVersion
        }
      );
    }
  );

  /* =======================================================
     AUCTION RESET
     ======================================================= */

  socket.on(
    "auction:reset",
    () => {
      clearFinishGrace();
      drawTimeDeadline = 0;
      participants.clear();

      participantVersion += 1;

      console.log(
        "[Auction] peserta dan coin di-reset"
      );

      /* ---------------------------------------------------
         Bersihkan duplicate protection juga
         supaya gift baru setelah reset bisa diproses.
         --------------------------------------------------- */

      processedGiftEvents.clear();
      processedGiftFingerprints.clear();
      processedStreakProgress.clear();
      processedGiftEventsCleanupAt = 0;

      io.emit(
        "auction:participants",
        {
          version:
            participantVersion,

          participants: []
        }
      );

      io.emit(
        "auction:participant:update",
        {
          version:
            participantVersion,

          participant: null,

          gift: null,

          reset: true
        }
      );

      clearFinishGrace();
      auctionActive = false;
      auctionDrawTime = false;
      processedStreakProgress.clear();

      io.emit(
        "auction:state",
        {
          state: "idle",

          active: false,

          version:
            participantVersion
        }
      );
    }
  );

  /* =======================================================
     LIVE DISCONNECT
     ======================================================= */

  socket.on(
    "live:disconnect",
    async () => {
      console.log(
        "[Socket] Disconnect TikTok."
      );

      clearFinishGrace();
      auctionActive = false;
      auctionDrawTime = false;
      processedStreakProgress.clear();

      await stopConnection();

      activeUsername = null;
      tikTokConnectionState = "offline";
      tikTokLastError = "";

      emitStatus(
        "Koneksi TikTok LIVE diputus.",
        false
      );
    }
  );

  /* =======================================================
     SOCKET DISCONNECT
     ======================================================= */

  socket.on(
    "disconnect",
    () => {
      console.log(
        `[Socket] Client terputus: ${socket.id}`
      );
    }
  );
});

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      connected:
        tikTokConnectionState === "connected",

      connectionPhase:
        tikTokConnectionState,

      username:
        activeUsername,

      eventCount:
        tikTokEventCount,

      giftCount:
        tikTokGiftCount,

      lastEventAt:
        tikTokLastEventAt || null,

      lastGiftAt:
        tikTokLastGiftAt || null,

      connectedAt:
        tikTokConnectedAt || null,

      reconnectCount:
        tikTokReconnectCount,

      lastError:
        tikTokLastError || null,

      auctionActive,

      auctionDrawTime,

      participantCount:
        participants.size,

      participantVersion,

      apiKeyRequired:
        true
    });
  }
);

/* =========================================================
   TIKTOK MONITOR HEARTBEAT
   Mengirim status setiap 5 detik agar dashboard bisa membedakan
   "server hidup" dari "TikTok benar-benar connected".
   ========================================================= */

setInterval(() => {
  if (!activeUsername) return;

  io.emit("live:status", {
    message:
      tikTokConnectionState === "connected"
        ? `TikTok LIVE @${activeUsername} terhubung • event stream aktif`
        : `TikTok @${activeUsername}: ${tikTokConnectionState}`,
    ok: tikTokConnectionState === "connected",
    username: activeUsername,
    phase: tikTokConnectionState,
    eventCount: tikTokEventCount,
    giftCount: tikTokGiftCount,
    lastEventAt: tikTokLastEventAt || null,
    lastGiftAt: tikTokLastGiftAt || null,
    connectedAt: tikTokConnectedAt || null,
    reconnectCount: tikTokReconnectCount,
    error: tikTokLastError || null,
    serverTime: Date.now()
  });
}, 5000);

/* =========================================================
   INDEX
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      __dirname + "/index.html"
    );
  }
);

/* =========================================================
   SERVER
   ========================================================= */

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================================"
    );

    console.log(
      `Server berjalan di port ${PORT}`
    );

    console.log(
      "TikTok Live Coin Auction siap."
    );

    console.log(
      "MODE: @tiktool/live + TIKTOOL_API_KEY"
    );

    console.log(
      "================================================"
    );
  }
);

/* =========================================================
   PROCESS ERROR HANDLER
   ========================================================= */

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[PROCESS] Unhandled Promise Rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[PROCESS] Uncaught Exception:",
      error
    );
  }
);
