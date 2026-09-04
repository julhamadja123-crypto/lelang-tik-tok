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

function emitStatus(message, ok = false) {
  console.log(`[STATUS] ${message}`);

  io.emit("live:status", {
    message,
    ok
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

    const deltaRepeat = Math.max(
      0,
      repeatCount - previousRepeat
    );

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

  if (
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

  const conn = new Connector({
    uniqueId: username,
    apiKey: TIKTOOL_API_KEY,
    autoReconnect: false,
    debug: false
  });

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
  conn.on("event", (incomingEvent) => {
    const event = unwrapTikTokEvent(incomingEvent);
    const type = String(
      incomingEvent?.event ||
      incomingEvent?.type ||
      event?.type ||
      ""
    ).toLowerCase();

    if (type !== "gift") return;

    // IMPORTANT:
    // Some @tiktool/live transports deliver the gift ONLY through the
    // generic "event" channel as { event: "gift", data: {...} }.
    // Do not return here: the primary "gift" listener may not receive
    // the same gift at all. giftData() + duplicate protection below
    // safely prevent the same gift from being counted twice.
    handleGiftEvent(incomingEvent);
  });

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on("chat", (event) => {
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
    console.log(
      "[TikTok] connected:",
      state
    );
  });

  /* =======================================================
     ERROR
     ======================================================= */

  conn.on("error", (err) => {
    console.error(
      "[TikTok] error:",
      err
    );

    emitStatus(
      `Error TikTok: ${formatError(err)}`
    );
  });

  /* =======================================================
     DISCONNECTED
     ======================================================= */

  conn.on("disconnected", () => {
    console.warn(
      `[TikTok] @${activeUsername} terputus.`
    );

    if (
      manualDisconnect ||
      liveConnection !== conn ||
      !activeUsername
    ) {
      return;
    }

    emitStatus(
      `Koneksi @${activeUsername} terputus. Mencoba ulang...`
    );

    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      setTimeout(() => {
        if (
          !manualDisconnect &&
          activeUsername
        ) {
          connectToLive(
            activeUsername
          ).catch((err) => {
            emitStatus(
              `Reconnect gagal: ${formatError(err)}`
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
      "aktif";

    emitStatus(
      `Terhubung ke LIVE @${username} • Room ${roomId}`,
      true
    );

    console.log(
      `[TikTok] BERHASIL TERHUBUNG @${username}`
    );

    return state;

  } catch (err) {
    if (
      liveConnection === conn
    ) {
      liveConnection = null;
    }

    const friendly =
      formatError(err);

    console.error(
      "[TikTok] gagal connect:",
      err
    );

    emitStatus(
      `Gagal terhubung @${username}: ${friendly}`
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
    Boolean(
      liveConnection?.connected === true
    );

  socket.emit(
    "live:status",
    {
      ok: connected,

      message: connected
        ? `Terhubung ke @${activeUsername}`
        : "Belum terhubung ke TikTok LIVE"
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

      emitStatus(
        "Koneksi TikTok LIVE diputus."
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
        Boolean(liveConnection),

      username:
        activeUsername,

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
