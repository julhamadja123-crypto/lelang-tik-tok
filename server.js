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
let manualDisconnect = false;

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
     GIFT STREAK / COMBO

     TikTok/TikTool dapat mengirim dua tahap untuk SATU gift:
       - progress: repeatEnd=false, repeatCount=1
       - final:    repeatEnd=true,  repeatCount=1

     Versi sebelumnya hanya melakukan delta pada progress, sedangkan
     event final dihitung lagi sebagai 1 coin. Akibatnya kirim 1 coin
     bisa menjadi 2 coin.

     Sekarang semua event streak dihitung sebagai delta terhadap
     repeatCount terakhir. Jika hanya event final yang diterima,
     delta tetap penuh sehingga gift tidak hilang.
     ------------------------------------------------------- */

  if (giftType === 1) {
    // Gunakan identitas pengirim + gift sebagai kunci combo yang stabil.
    // Jangan bergantung hanya pada transactionId/groupId karena nilai
    // tersebut dapat berbeda antara event progress dan event final.
    const streakSenderKey = String(
      user.userId && user.userId !== "unknown"
        ? user.userId
        : user.uniqueId || user.username || user.nickname || "viewer"
    ).trim().toLowerCase();

    const streakGiftKey = String(
      giftId || giftName || "gift"
    ).trim().toLowerCase();

    const streakKey = `${streakSenderKey}|${streakGiftKey}`;

    const previousRepeat = Number(
      processedStreakProgress.get(streakKey) || 0
    );

    // TikTok/TikTool tidak selalu mengirim format combo yang sama.
    // Ada stream yang mengirim progress kumulatif (x1, x2, x3), tetapi
    // ada juga yang mengirim progress lalu event FINAL dengan repeatCount=1.
    // Jika final lebih kecil dari progress terakhir, final tetap mewakili
    // 1 hit tambahan. Jika nilainya sama, final adalah pengulangan event
    // yang sudah dihitung dan harus diabaikan.
    let deltaRepeat;

    if (repeatCount > previousRepeat) {
      // Progress/final membawa total kumulatif baru.
      deltaRepeat = repeatCount - previousRepeat;
    } else if (repeatEnd && repeatCount < previousRepeat) {
      // Format final non-kumulatif: progress terakhir sudah xN, lalu
      // event final datang sebagai x1. Tambahkan tepat 1 combo.
      deltaRepeat = 1;
    } else {
      // Nilai sama = event duplicate / final yang sudah terwakili.
      deltaRepeat = 0;
    }

    if (deltaRepeat <= 0) {
      console.log(
        `[GIFT] Streak duplicate diabaikan: @${user.uniqueId} | ${giftName} | x${repeatCount} | repeatEnd=${repeatEnd}`
      );

      // Event final menutup combo yang sudah selesai.
      if (repeatEnd) {
        processedStreakProgress.delete(streakKey);
      }

      return null;
    }

    if (repeatEnd) {
      // Final sudah membawa total repeatCount. Yang masuk hanya delta.
      // Hapus state agar combo berikutnya dari user yang sama normal.
      processedStreakProgress.delete(streakKey);
    } else {
      processedStreakProgress.set(
        streakKey,
        Math.max(previousRepeat, repeatCount)
      );
    }

    // Hanya delta baru yang boleh menjadi coin.
    repeatCount = deltaRepeat;
  }

  /* -------------------------------------------------------
     COIN VALUE
     ------------------------------------------------------- */

  const coinValue =
    resolvedDiamondCount * repeatCount;

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
    giftType !== 1
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
    repeatEnd,

    msgId,
    transactionId,
    groupId,

    avatar: user.avatar
  };
}

/* =========================================================
   STOP TIKTOK CONNECTION
   ========================================================= */

async function stopConnection() {
  clearTimeout(reconnectTimer);
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

async function connectToLive(rawUsername) {
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
   * Use TikTool RELAYED mode for the production connection.
   *
   * The v38 log showed that the signed/direct WebSocket was able to obtain
   * roomId + credentials and report "connected", but no gift events reached
   * the SDK listener. Relayed mode keeps the same @tiktool/live event API
   * while letting TikTool's edge handle the TikTok WebSocket/protobuf side.
   * This is especially important here because the application only needs the
   * normalized gift/chat events, not the raw TikTok socket.
   *
   * TIKTOOL_MODE can be set to "direct" if a direct connection is explicitly
   * required. Default is "relayed".
   */
  const tikToolMode =
    String(process.env.TIKTOOL_MODE || "relayed").trim().toLowerCase();

  const conn = new Connector({
    uniqueId: username,
    apiKey: TIKTOOL_API_KEY,
    mode: tikToolMode === "direct" ? "direct" : "relayed",
    autoReconnect: false,
    debug: false
  });

  console.log(
    `[TikTok] Mode koneksi: ${tikToolMode === "direct" ? "direct" : "relayed"}`
  );

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

    const event = unwrapTikTokEvent(incomingEvent);

    // Event counter hanya bertambah setelah gift benar-benar diterima.
    // WeakSet di atas mencegah listener ganda menghitung dua kali.
    noteTikTokEvent("gift");

    // FAST PATH: process the gift immediately; no artificial delay.

    /* -----------------------------------------------------
       PARSE GIFT
       -----------------------------------------------------
       Gift tetap diproses ketika event TikTok diterima.
       Jangan membuang event hanya karena auctionActive belum
       sinkron dengan UI. Duplicate protection di giftData()
       tetap mencegah event yang sama dihitung dua kali.
       ----------------------------------------------------- */

    console.log(
      `[GIFT] EVENT DITERIMA | auctionActive=${auctionActive} | drawTime=${auctionDrawTime}`
    );

    // Gift hanya boleh menambah coin ketika lelang sedang aktif.
    // Ini juga mencegah event duplicate/terlambat yang baru tiba setelah
    // lelang FINISH menambahkan coin sekali lagi.
    if (!auctionActive) {
      console.log(
        "[GIFT] DIABAIKAN: auction sudah selesai/tidak aktif"
      );
      return;
    }

    const gift =
      giftData(event);

    if (!gift) {
      console.log(
        "[GIFT] event diterima tetapi gift tidak valid/complete"
      );
      try {
        console.log(
          "[GIFT] RAW PAYLOAD:",
          JSON.stringify(event)
        );
      } catch (_) {}

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
     * Snapshot seluruh peserta dikirim sesaat setelah event utama.
     * Ini mencegah Array.from(...) + serialisasi daftar peserta
     * menahan jalur gift ketika peserta sudah banyak.
     * Tidak mengubah perhitungan coin maupun urutan event utama.
     */
    // Capture version/snapshot sekarang agar snapshot lama tidak dapat
    // menimpa coin terbaru ketika beberapa gift masuk sangat cepat.
    // Kirim snapshot authoritative segera setelah participant diperbarui.
    // Tidak ditunda dengan setImmediate agar client langsung menerima
    // daftar peserta terbaru setelah gift diproses.
    io.emit(
      "auction:participants",
      {
        version:
          participantVersion,

        participants:
          Array.from(participants.values())
      }
    );
  };

  // Standard TikTool event.
  conn.on("gift", handleGiftEvent);

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

    if (type !== "gift") return;

    console.log("[GIFT] diterima melalui generic event channel");

    // IMPORTANT:
    // Some @tiktool/live transports deliver the gift ONLY through the
    // generic "event" channel. The primary "gift" listener and this
    // compatibility path share the same duplicate protection.
    handleGiftEvent(candidate);
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

    reconnectTimer =
      setTimeout(() => {
        if (
          !manualDisconnect &&
          activeUsername
        ) {
          connectToLive(
            activeUsername
          ).catch((err) => {
            const friendly = formatError(err);
            tikTokLastError = friendly;
            setTikTokState(
              "reconnecting",
              `Reconnect gagal: ${friendly}`,
              false
            );
          });
        }
      }, 5000);
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

      auctionActive =
        requestedState === "running";

      auctionDrawTime =
        auctionActive && data?.drawTime === true;

      if (!auctionDrawTime) {
        processedStreakProgress.clear();
      }

      console.log(
        `[Auction] state=${requestedState} active=${auctionActive} drawTime=${auctionDrawTime}`
      );

      io.emit(
        "auction:state",
        {
          state:
            requestedState,

          active:
            auctionActive,

          drawTime:
            auctionDrawTime,

          version:
            participantVersion
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
