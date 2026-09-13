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
    forceAuctionFinished("DRAW TIME selesai, coin tidak seri");
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
      forceAuctionFinished("grace selesai, coin tidak seri");
    }
  }, AUCTION_FINISH_GRACE_MS);
}

function forceAuctionFinished(reason = "timer 00:00") {
  if (auctionDrawTime) return false;

  clearTimeout(graceDrawCheckTimer);
  graceDrawCheckTimer = null;
  auctionFinishedAt = 0;
  auctionActive = false;
  auctionDrawTime = false;
  drawTimeDeadline = 0;

  console.log(`[Auction] FINISHED FINAL: ${reason}`);
  io.emit("auction:state", {
    state: "finished",
    active: false,
    drawTime: false,
    finished: true,
    final: true,
    reason,
    version: participantVersion
  });
  return true;
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
// TikTool can send the same combo twice as progress/final events with different
// createTime/transport IDs. Remember the latest non-final combo state briefly
// so final replay cannot add the same coin again.
const recentComboReceipts = new Map();
const COMBO_REPLAY_TTL = 10000;
// Protect against the same normal gift arriving through both TikTool
// `gift` and generic `event` transports with different IDs.
const processedCrossTransportGifts = new Map();
// Receipt cache khusus normal gift yang memiliki createTime upstream.
// Dipisahkan dari cache cross-transport 5 detik agar replay terlambat
// dari gift yang sama tetap ditolak tanpa memblokir gift baru yang sah.
const processedGiftReceipts = new Map();
let processedGiftEventsCleanupAt = 0;

const GIFT_TTL = 60 * 1000;
const GIFT_FINGERPRINT_TTL = 5000;
const CROSS_TRANSPORT_TTL = 5000;
const GIFT_RECEIPT_TTL = 60 * 1000;
// TikTok/TikTool can occasionally deliver the same normal gift through
// two channels with different transaction/message IDs. Keep a short semantic guard for that case; combo/streak gifts use their own delta logic.
const GIFT_SEMANTIC_TTL = 5000;
// Guard khusus replay terlambat pada gift biasa. TikTool kadang mengirim
// ulang gift yang sama beberapa detik kemudian dengan ID transport baru.
// Guard ini hanya aktif ketika event baru datang dari jalur primary yang sama
// dan participant/gift yang sama; combo tidak disentuh.
const LATE_NORMAL_REPLAY_TTL = 5000;
const recentNormalGiftReceipts = new Map();
// Once the normal `gift` listener has delivered a gift, the generic `event`
// channel is treated as a fallback only. A duplicate can arrive there later
// with fresh IDs and otherwise bypass the ID guards. This timestamp lets the
// primary path win without adding any delay to real gifts.
let lastPrimaryGiftAt = 0;
const GENERIC_GIFT_FALLBACK_TTL = 10000;
// TikTool can replay the first normal gift with a different event ID after
// the initial delivery. The longer semantic window prevents that replay
// from becoming a second coin while still keeping combo handling separate.

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
    displayUsername: activeUsername ? `@${activeUsername}` : "",
    connectionLabel: tikTokConnectionState === "connected"
      ? "TERHUBUNG"
      : tikTokConnectionState === "reconnecting"
        ? "MENYAMBUNG KEMBALI"
        : "BELUM TERHUBUNG",
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
    } else if (
      current.gift &&
      typeof current.gift === "object"
    ) {
      next = current.gift;
    } else if (
      current.giftInfo &&
      typeof current.giftInfo === "object"
    ) {
      next = current.giftInfo;
    } else if (
      current.giftData &&
      typeof current.giftData === "object"
    ) {
      next = current.giftData;
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


/* =========================================================
   ROBUST GIFT PAYLOAD EXTRACTION
   =========================================================
   @tiktool/live normally emits:
     { event: "gift", data: { user, giftName, diamondCount, ... } }

   Some relayed/generic transports can add extra wrappers, arrays, or
   JSON-string payloads. Find the actual gift object without changing
   the TikTok connection itself.
========================================================= */
function findGiftPayload(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value === null || value === undefined) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;

    // Only parse strings that look like JSON objects/arrays.
    if (text[0] === "{" || text[0] === "[") {
      try {
        return findGiftPayload(JSON.parse(text), depth + 1, seen);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  if (typeof value !== "object") return null;

  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGiftPayload(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  const type = String(
    value.event ??
    value.type ??
    value.eventType ??
    value.event_type ??
    ""
  ).toLowerCase();

  const hasGiftFields =
    value.giftId !== undefined ||
    value.gift_id !== undefined ||
    value.giftName !== undefined ||
    value.gift_name !== undefined ||
    value.diamondCount !== undefined ||
    value.diamond_count !== undefined ||
    value.diamondCost !== undefined ||
    value.diamond_cost !== undefined ||
    value.coinValue !== undefined ||
    value.coin_value !== undefined ||
    value.coins !== undefined ||
    value.coinCount !== undefined ||
    value.coin_count !== undefined ||
    value.coin !== undefined ||
    value.giftDetails !== undefined ||
    value.extendedGiftInfo !== undefined ||
    value.gift?.giftId !== undefined ||
    value.gift?.gift_id !== undefined ||
    value.gift?.giftName !== undefined ||
    value.gift?.diamondCount !== undefined ||
    value.gift?.diamond_count !== undefined;

  if (type === "gift" || hasGiftFields) {
    // If this is a gift envelope, prefer its actual data/payload child.
    // IMPORTANT: a generic envelope can say event/type="gift" while the
    // actual gift payload is in another argument or a nested wrapper. Do NOT
    // return that empty envelope just because its event name is "gift".
    // Otherwise the caller never reaches the real payload and diamondCount
    // stays 0.
    for (const key of [
      "data",
      "payload",
      "message",
      "body",
      "result",
      "response",
      "eventData",
      "event_data",
      "gift",
      "giftInfo",
      "gift_info",
      "giftData",
      "gift_data",
      "giftDetails",
      "gift_details",
      "extendedGiftInfo",
      "extended_gift_info"
    ]) {
      if (value[key] !== undefined && value[key] !== value) {
        const nestedGift = findGiftPayload(value[key], depth + 1, seen);
        if (nestedGift) return nestedGift;
      }
    }

    // Only accept the current object as a gift payload when it actually has
    // gift fields. A bare {event:"gift"} envelope is not enough.
    if (hasGiftFields) return value;
  }

  // Search common wrappers first.
  for (const key of [
    "data",
    "payload",
    "message",
    "body",
    "result",
    "response",
    "eventData",
    "event_data",
    "gift",
    "giftInfo",
    "gift_info",
    "giftData",
    "gift_data",
    "giftDetails",
    "gift_details",
    "extendedGiftInfo",
    "extended_gift_info"
  ]) {
    if (value[key] !== undefined) {
      const found = findGiftPayload(value[key], depth + 1, seen);
      if (found) return found;
    }
  }

  // Last resort: inspect enumerable children. This is bounded by depth.
  for (const child of Object.values(value)) {
    if (child && (typeof child === "object" || typeof child === "string")) {
      const found = findGiftPayload(child, depth + 1, seen);
      if (found) return found;
    }
  }

  return null;
}


/* =========================================================
   RAW / GENERIC EVENT NORMALIZER
   =========================================================
   Some @tiktool/live builds expose the underlying websocket envelope on
   the generic `event` channel. Depending on the transport, the payload can
   be a plain object, JSON text, a nested data/payload wrapper, or an object
   whose useful fields only become enumerable after JSON serialization.

   This helper is ONLY for gift extraction. It does not alter the TikTok
   connection itself.
========================================================= */

/* =========================================================
   STRICT GIFT ENVELOPE EXTRACTOR — server-70
   =========================================================
   TikTool's documented websocket envelope is:
     { event: "gift", data: { ...gift fields... } }

   The previous generic extractor could still return the OUTER envelope in
   some transports. That leaves giftData() looking at {event:"gift"} instead
   of data.diamondCount, producing coin=0 and dropping the gift.

   This helper deliberately unwraps event -> data first. It never uses
   repeatCount as coin value and never changes the TikTok connection.
========================================================= */
function extractGiftPayloadStrict(value, depth = 0, seen = new Set()) {
  if (depth > 12 || value === null || value === undefined) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
    try {
      return extractGiftPayloadStrict(JSON.parse(text), depth + 1, seen);
    } catch (_) {
      return null;
    }
  }

  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const positive = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  };

  const hasPositiveValue = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    return (
      positive(obj.diamondCount) ||
      positive(obj.diamond_count) ||
      positive(obj.diamondCost) ||
      positive(obj.diamond_cost) ||
      positive(obj.coinValue) ||
      positive(obj.coin_value) ||
      positive(obj.coins) ||
      positive(obj.coinCount) ||
      positive(obj.coin_count) ||
      positive(obj.coin)
    );
  };

  const hasGiftIdentity = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    return (
      obj.giftId !== undefined ||
      obj.gift_id !== undefined ||
      obj.giftName !== undefined ||
      obj.gift_name !== undefined ||
      obj.gift !== undefined ||
      obj.giftInfo !== undefined ||
      obj.giftData !== undefined ||
      obj.giftDetails !== undefined ||
      obj.extendedGiftInfo !== undefined
    );
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGiftPayloadStrict(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  const eventType = String(
    value.event ?? value.type ?? value.eventType ?? value.event_type ?? ""
  ).trim().toLowerCase();

  /*
   * IMPORTANT:
   * Never return a wrapper merely because it contains giftId/giftName.
   * Some TikTool envelopes have the identity on the outer object while the
   * actual diamond/coin value is several levels deeper. Returning the outer
   * object made giftData() see coin=0 and drop the gift.
   *
   * Priority:
   *   1. direct object with a positive per-gift value
   *   2. known gift/data wrappers
   *   3. bounded generic children
   */
  if (hasPositiveValue(value)) return value;

  const directKeys = [
    "data",
    "payload",
    "message",
    "body",
    "result",
    "response",
    "eventData",
    "event_data",
    "gift",
    "giftData",
    "gift_data",
    "giftInfo",
    "gift_info",
    "giftDetails",
    "gift_details",
    "extendedGiftInfo",
    "extended_gift_info"
  ];

  /*
   * For a named gift envelope, search all known children first.
   * This fixes partial envelopes such as:
   * { event:"gift", giftId:..., data:{ diamondCount:1, ... } }
   */
  for (const key of directKeys) {
    const child = value[key];
    if (child === undefined || child === null || child === value) continue;

    const found = extractGiftPayloadStrict(child, depth + 1, seen);
    if (found) return found;
  }

  /*
   * Some transports place the gift payload under an unusual wrapper.
   * Only recurse into children when this object already looks gift-related
   * or explicitly says it is a gift. This keeps the fast path cheap.
   */
  const looksGiftRelated =
    eventType === "gift" ||
    eventType.includes("gift") ||
    hasGiftIdentity(value);

  if (looksGiftRelated) {
    for (const [key, child] of Object.entries(value)) {
      if (directKeys.includes(key)) continue;
      if (!child || (typeof child !== "object" && typeof child !== "string")) continue;

      const found = extractGiftPayloadStrict(child, depth + 1, seen);
      if (found) return found;
    }
  }

  return null;
}

function normalizeRawEventCandidate(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;

    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  if (typeof value !== "object") return null;

  // First use the object as-is. This preserves references for the normal
  // fast path and lets findGiftPayload walk ordinary plain objects.
  const direct = findGiftPayload(value);
  if (direct) return direct;

  // A few transport objects expose their data through non-standard/non-
  // enumerable properties. JSON serialization is a safe read-only way to
  // obtain the wire-shaped object when available.
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== "{}") {
      const parsed = JSON.parse(serialized);
      return findGiftPayload(parsed) || parsed;
    }
  } catch (_) {}

  return null;
}


/* =========================================================
   GENERIC EVENT GIFT VALUE GUARD — server-70
   =========================================================
   EventEmitter `event` kadang mengirim envelope/heartbeat/partial event
   yang memiliki bentuk mirip gift tetapi TIDAK memiliki nilai coin/diamond.

   JANGAN kirim payload seperti itu ke giftData()/handleGiftEvent().
   Jalur `gift` utama tetap tidak diubah. Guard ini hanya dipakai sebelum
   fallback generic/raw mencoba memproses sebuah payload sebagai gift.
========================================================= */
function hasPositiveGiftValue(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value === null || value === undefined) return false;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text || (text[0] !== "{" && text[0] !== "[")) return false;
    try {
      return hasPositiveGiftValue(JSON.parse(text), depth + 1, seen);
    } catch (_) {
      return false;
    }
  }

  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) =>
      hasPositiveGiftValue(item, depth + 1, seen)
    );
  }

  const valueKeys = [
    "diamondCount", "diamond_count",
    "diamondCost", "diamond_cost",
    "coinValue", "coin_value",
    "coinCount", "coin_count",
    "coins", "coin"
  ];

  for (const key of valueKeys) {
    if (value[key] === undefined || value[key] === null || value[key] === "") continue;
    const n = Number(value[key]);
    if (Number.isFinite(n) && n > 0) return true;
  }

  for (const key of [
    "data", "payload", "message", "body", "result", "response",
    "eventData", "event_data", "gift", "giftData", "gift_data",
    "giftInfo", "gift_info", "giftDetails", "gift_details",
    "extendedGiftInfo", "extended_gift_info"
  ]) {
    if (value[key] !== undefined && value[key] !== null &&
        hasPositiveGiftValue(value[key], depth + 1, seen)) {
      return true;
    }
  }

  return false;
}

function isUsableGenericGiftPayload(value) {
  if (!value || typeof value !== "object") return false;
  if (hasPositiveGiftValue(value)) return true;

  // A valid gift frame can contain giftId + sender but omit diamondCount.
  // Allow it through when the official cached catalog can price that ID.
  const idCandidates = [
    value.giftId, value.gift_id,
    value.gift?.giftId, value.gift?.gift_id,
    value.giftDetails?.giftId, value.giftDetails?.gift_id,
    value.giftInfo?.giftId, value.giftInfo?.gift_id,
    value.giftData?.giftId, value.giftData?.gift_id
  ];

  return idCandidates.some((id) => getCatalogDiamondCount(id) > 0);
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
    user.unique_id ||
    event?.uniqueId ||
    event?.unique_id ||
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
   GIFT CATALOG FALLBACK
   =========================================================
   Some TikTool generic/raw frames can carry giftId + sender but omit
   diamondCount on the frame. The official TikTool gift catalog contains
   the per-unit diamond value by gift ID. Cache it in memory so the live
   gift path stays fast and never waits on an HTTP request.

   IMPORTANT:
   - This is NOT gift-name mapping.
   - The key is TikTok giftId and the value is the official diamond_count.
   - repeatCount is NEVER used as the coin value.
   ========================================================= */

const giftCatalogById = new Map();
let giftCatalogLoadedAt = 0;
let giftCatalogRefreshPromise = null;
const GIFT_CATALOG_TTL = 6 * 60 * 60 * 1000;

async function refreshGiftCatalog(force = false) {
  if (!force && giftCatalogLoadedAt > 0 && Date.now() - giftCatalogLoadedAt < GIFT_CATALOG_TTL) {
    return giftCatalogById;
  }

  if (giftCatalogRefreshPromise) return giftCatalogRefreshPromise;

  const apiKey = String(process.env.TIKTOOL_API_KEY || '').trim();
  if (!apiKey) return giftCatalogById;

  giftCatalogRefreshPromise = (async () => {
    try {
      const response = await fetch('https://api.tik.tools/webcast/gift_info', {
        headers: {
          Accept: 'application/json',
          'x-api-key': apiKey
        }
      });

      if (!response.ok) {
        console.warn(`[GIFT CATALOG] HTTP ${response.status} - fallback katalog tidak diperbarui.`);
        return giftCatalogById;
      }

      const json = await response.json();
      const gifts = Array.isArray(json?.data?.gifts) ? json.data.gifts : [];

      let loaded = 0;
      for (const item of gifts) {
        const id = String(item?.id ?? item?.giftId ?? item?.gift_id ?? '').trim();
        const diamond = Number(
          item?.diamond_count ??
          item?.diamondCount ??
          item?.diamondCost ??
          item?.diamond_cost
        );

        if (id && Number.isFinite(diamond) && diamond > 0) {
          giftCatalogById.set(id, diamond);
          loaded += 1;
        }
      }

      if (loaded > 0) {
        giftCatalogLoadedAt = Date.now();
        console.log(`[GIFT CATALOG] ${loaded} gift price berhasil dicache.`);
      } else {
        console.warn('[GIFT CATALOG] Tidak ada gift price valid pada response.');
      }
    } catch (err) {
      console.warn('[GIFT CATALOG] gagal refresh:', err?.message || err);
    } finally {
      giftCatalogRefreshPromise = null;
    }

    return giftCatalogById;
  })();

  return giftCatalogRefreshPromise;
}

function getCatalogDiamondCount(giftId) {
  if (!giftId) return 0;
  const value = Number(giftCatalogById.get(String(giftId).trim()) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function startGiftCatalogWarmup() {
  // Never block TikTok connection or gift processing on this request.
  refreshGiftCatalog(false).catch(() => {});
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
    event.giftInfo?.giftId ??
    event.giftInfo?.gift_id ??
    event.giftData?.giftId ??
    event.giftData?.gift_id ??
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
    event.giftInfo?.giftName ||
    event.giftInfo?.name ||
    event.giftData?.giftName ||
    event.giftData?.name ||
    (giftId ? `Gift #${giftId}` : "Gift");

  /* -------------------------------------------------------
     DIAMOND / COIN COUNT
     ------------------------------------------------------- */

  // TikTool dapat mengirim nilai gift pada payload flat maupun pada
  // object bertingkat. Ambil field yang benar-benar merepresentasikan
  // nilai gift sebelum memakai fallback generik. Jangan memakai
  // repeatCount sebagai coin karena itu hanya jumlah pengulangan gift.
  // IMPORTANT: use TikTool's explicit diamondCount as the canonical
  // per-gift value. Fields such as coinValue/coins/coinCount can be
  // cumulative or wrapper-derived values and were the main suspect for
  // the first 1-coin gift becoming 2. Never use those fields as the
  // primary coin source.
  const diamondCount = numberPositive(
    event.diamondCount,
    event.diamond_count,
    event.diamondCost,
    event.diamond_cost,
    event.diamondValue,
    event.diamond_value,

    event.gift?.diamondCount,
    event.gift?.diamond_count,
    event.gift?.diamondCost,
    event.gift?.diamond_cost,
    event.gift?.diamondValue,
    event.gift?.diamond_value,

    event.giftDetails?.diamondCount,
    event.giftDetails?.diamond_count,
    event.giftDetails?.diamondCost,
    event.giftDetails?.diamond_cost,
    event.giftDetails?.diamondValue,
    event.giftDetails?.diamond_value,

    event.extendedGiftInfo?.diamondCount,
    event.extendedGiftInfo?.diamond_count,
    event.extendedGiftInfo?.diamondCost,
    event.extendedGiftInfo?.diamond_cost,

    event.giftInfo?.diamondCount,
    event.giftInfo?.diamond_count,
    event.giftInfo?.diamondCost,
    event.giftInfo?.diamond_cost,
    event.giftInfo?.diamondValue,
    event.giftInfo?.diamond_value,

    event.giftData?.diamondCount,
    event.giftData?.diamond_count,
    event.giftData?.diamondCost,
    event.giftData?.diamond_cost,
    event.giftData?.diamondValue,
    event.giftData?.diamond_value
  );

  // Be tolerant of additional TikTool nesting (for example payloads
  // wrapped in giftInfo/giftData). Only inspect explicit diamond-value
  // fields; never infer the participant coin total from cumulative fields.
  let resolvedDiamondCount = diamondCount;
  if (resolvedDiamondCount <= 0) {
    const valueKeys = new Set([
      "diamondCount", "diamond_count", "diamondCost", "diamond_cost",
      "diamondValue", "diamond_value"
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

  // LAST SAFE RECOVERY: if this is a real gift payload with a giftId but
  // the generic frame omitted diamondCount, use the cached official catalog.
  // This keeps the live path immediate and avoids guessing from gift names.
  if (resolvedDiamondCount <= 0 && giftId) {
    const catalogDiamond = getCatalogDiamondCount(giftId);
    if (catalogDiamond > 0) {
      resolvedDiamondCount = catalogDiamond;
      console.log(
        `[GIFT] catalog fallback aktif: giftId=${giftId} diamond=${catalogDiamond}`
      );
    } else {
      // Refresh in the background for newly released gifts. Do not wait here.
      refreshGiftCatalog(false).catch(() => {});
    }
  }

  /*
   * COIN FALLBACK
   * Some TikTool relay payloads expose the per-gift value as coinValue,
   * coins, coinCount, or coin instead of diamondCount/diamondCost.
   * This fallback is used ONLY when no explicit diamond value exists.
   * repeatCount is never used as the coin value.
   */
  let resolvedCoinFallback = 0;

  if (resolvedDiamondCount <= 0) {
    const coinValueKeys = new Set([
      "coinValue",
      "coin_value",
      "coins",
      "coinCount",
      "coin_count",
      "coin"
    ]);

    const scanCoinValue = (value, depth = 0, seen = new Set()) => {
      if (
        resolvedCoinFallback > 0 ||
        depth > 6 ||
        value === null ||
        value === undefined
      ) return;

      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (!coinValueKeys.has(key)) continue;
        const n = Number(child);
        if (Number.isFinite(n) && n > 0) {
          resolvedCoinFallback = n;
          return;
        }
      }

      for (const key of [
        "gift", "giftInfo", "giftData", "giftDetails",
        "extendedGiftInfo", "data", "payload", "message",
        "body", "result", "response", "eventData", "event_data"
      ]) {
        if (value[key] && typeof value[key] === "object") {
          scanCoinValue(value[key], depth + 1, seen);
          if (resolvedCoinFallback > 0) return;
        }
      }
    };

    scanCoinValue(event);
  }

  if (resolvedDiamondCount <= 0 && resolvedCoinFallback > 0) {
    resolvedDiamondCount = resolvedCoinFallback;
    console.log(
      `[GIFT] coin fallback aktif: coinValue/coins=${resolvedCoinFallback} ` +
      `(diamondCount/diamondCost tidak tersedia)`
    );
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
    event.giftInfo?.giftType ??
    event.giftInfo?.gift_type ??
    event.giftData?.giftType ??
    event.giftData?.gift_type ??
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
      `[GIFT] ${giftName} diabaikan: nilai coin gift tidak ditemukan ` +
      `(diamondCount/diamondCost/coinValue/coins).`
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
    // Untuk satu combo, TikTool dapat mengirim update progress/final
    // dengan transactionId yang berbeda. Karena itu identitas combo harus
    // memakai identitas yang lebih stabil terlebih dahulu: groupId lalu
    // createTime, baru transactionId sebagai fallback.
    // Prefer a stable combo/group identity. transactionId is safer than
    // createTime for separate gifts sent close together: two legitimate
    // gifts can share the same createTime and must NOT be collapsed.
    comboKey = groupId
      ? `group:${groupId}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
      : transactionId
        ? `tx:${transactionId}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
        : createTime
          ? `time:${createTime}|${user.userId || user.uniqueId || user.nickname}|${giftId || giftName}`
          : null;

    if (comboKey) {
      const previousRepeat = Number(processedStreakProgress.get(comboKey) || 0);

      // TikTool's progress event and final event can have different createTime
      // values, causing the old comboKey to differ even though they are the
      // same 1-gift combo. If a final event repeats a repeatCount already
      // accepted as a non-final event from the same sender/gift, suppress it.
      // This is deliberately limited to the short replay window and does not
      // affect separate gifts sent later.
      const comboReceiptKey = `combo-replay:${String(user.uniqueId || user.userId || user.nickname || "viewer").trim().toLowerCase()}|${String(giftId || giftName || "gift").trim().toLowerCase()}`;
      const recentCombo = recentComboReceipts.get(comboReceiptKey);
      if (
        recentCombo &&
        !recentCombo.final &&
        repeatCount <= Number(recentCombo.repeat || 0) &&
        Date.now() - recentCombo.at <= COMBO_REPLAY_TTL
      ) {
        console.log(
          `[GIFT] DUPLICATE combo final/replay diabaikan: ${comboReceiptKey} | x${repeatCount} | final=${repeatEnd}`
        );
        return null;
      }

      // FAST + SAFE FIRST GIFT:
      // TikTool can occasionally label the very first Rose event as a
      // streak/combo and report repeatCount > 1 even though the viewer has
      // only sent one gift. The first accepted event must therefore always
      // contribute exactly ONE gift. Later events may add only the new
      // repeat delta (x2 -> +1, x3 -> +1, etc.). This keeps the first 1-coin
      // gift at 1 coin without introducing any artificial delay.
      comboDelta = previousRepeat <= 0
        ? 1
        : repeatCount - previousRepeat;

      if (comboDelta <= 0) {
        console.log(
          `[GIFT] Combo update sudah diproses: @${user.uniqueId} | ${giftName} | x${repeatCount} | final=${repeatEnd}`
        );
        return null;
      }

      // Commit combo progress only after all duplicate guards pass.
      // Otherwise a rejected first event can make the next event look
      // already processed and the gift never reaches the participant.
      console.log(
        `[GIFT-FAST] Combo candidate @${user.uniqueId} | ${giftName} | x${repeatCount} | delta=${comboDelta} | final=${repeatEnd}`
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
     SIMPLE DUPLICATE PROTECTION
     =======================================================
     Satu jalur dedup saja. Jangan blok sender+gift selama beberapa detik
     karena dua gift sah yang dikirim berdekatan harus tetap dihitung.
  ======================================================= */
  const now = Date.now();
  const senderKey = String(
    user.uniqueId && user.uniqueId !== "Viewer"
      ? user.uniqueId
      : user.userId && user.userId !== "unknown"
        ? user.userId
        : user.nickname || "viewer"
  ).trim().toLowerCase();
  const giftKey = String(giftId || giftName || "gift").trim().toLowerCase();
  const repeatKey = isCombo ? String(repeatCount) : "normal";

  // Prefer stable TikTok event identity. createTime is also useful when a
  // second transport wraps the same gift with a different message ID.
  let eventKey = null;
  if (transactionId) {
    eventKey = `tx:${transactionId}|${senderKey}|${giftKey}|${repeatKey}`;
  } else if (msgId) {
    eventKey = `msg:${msgId}|${senderKey}|${giftKey}|${repeatKey}`;
  } else if (groupId) {
    eventKey = `group:${groupId}|${senderKey}|${giftKey}|${repeatKey}`;
  } else if (createTime !== null && createTime !== undefined && String(createTime).trim() !== "") {
    eventKey = `time:${String(createTime).trim()}|${senderKey}|${giftKey}|${repeatKey}`;
  }

  if (eventKey) {
    const previous = processedGiftEvents.get(eventKey);
    if (previous && now - previous <= GIFT_TTL) {
      console.log(`[GIFT] DUPLICATE diabaikan: ${eventKey}`);
      return null;
    }
    processedGiftEvents.set(eventKey, now);
  }

  // If TikTok supplies no stable event identity at all, only suppress an
  // immediate transport replay. There is deliberately no 5-10 second
  // sender+gift lock here.
  if (!eventKey) {
    const shortKey = `short:${senderKey}|${giftKey}|${repeatKey}`;
    const previousShort = processedCrossTransportGifts.get(shortKey);
    if (previousShort && now - previousShort.at <= 750) {
      console.log(`[GIFT] DUPLICATE short replay diabaikan: ${shortKey}`);
      return null;
    }
    processedCrossTransportGifts.set(shortKey, { at: now });
  }

  // Combo progress is committed only after the event has passed dedup.
  if (isCombo && comboKey) {
    processedStreakProgress.set(comboKey, repeatCount);
  }

  if (processedGiftEventsCleanupAt === 0 || now >= processedGiftEventsCleanupAt) {
    for (const [key, time] of processedGiftEvents.entries()) {
      if (now - time > GIFT_TTL) processedGiftEvents.delete(key);
    }
    for (const [key, info] of processedCrossTransportGifts.entries()) {
      if (!info || now - info.at > 2000) processedCrossTransportGifts.delete(key);
    }
    processedGiftEventsCleanupAt = now + 5000;
  }

  /* -------------------------------------------------------
     LOG
     ------------------------------------------------------- */

  console.log(
    `[GIFT] @${user.uniqueId} | ${giftName} | diamond=${resolvedDiamondCount} | repeat=${repeatCount} | combo=${isCombo} | +${coinValue}`
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
      recentComboReceipts.clear();
  processedCrossTransportGifts.clear();
  processedGiftReceipts.clear();
  recentNormalGiftReceipts.clear();
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
  // Pada deployment server-65, relayed berhasil CONNECTED tetapi tidak
  // menghasilkan event gift. Karena target utama sekarang adalah menerima
  // event gift tanpa mengubah parser/auction, gunakan direct kembali.
  const conn = new Connector({
    uniqueId: username,
    apiKey: TIKTOOL_API_KEY,
    autoReconnect: true,
    maxReconnectAttempts: 5,
    // Server-65 memakai relayed: koneksi terlihat sehat, tetapi log
    // tidak menerima satu pun event gift. Kembalikan jalur direct yang
    // sebelumnya dipakai saat event gift berhasil masuk.
    mode: "direct",
    debug: false
  });

  console.log("[TikTok] Mode koneksi: auto (TikTool memilih mode yang sesuai API key)");

  liveConnection = conn;

  /* =======================================================
     GIFT EVENT
     ======================================================= */

  // Guard against the same in-memory event being delivered through
  // both the primary "gift" listener and the compatibility "event"
  // listener. Without this guard, one 1-coin gift can be counted twice.
  const handledGiftObjects = new WeakSet();

  const handleGiftEvent = (incomingEvent, deliveryChannel = "gift") => {
    /*
     * IMPORTANT:
     * Jangan memasukkan object ke WeakSet SEBELUM giftData() berhasil.
     *
     * @tiktool/live dapat mengirim object gift yang sama lewat lebih dari satu
     * jalur. Kadang listener pertama menerima wrapper/partial frame yang belum
     * bisa diparse, lalu listener `event` / fallback menerima payload lengkap.
     *
     * Versi sebelumnya menandai object sebagai "handled" terlalu awal. Akibatnya
     * kalau percobaan pertama gagal parse, fallback berikutnya langsung dianggap
     * duplicate dan gift 1 coin hilang. Duplicate guard sekarang di-commit hanya
     * setelah gift benar-benar valid.
     */
    if (
      incomingEvent &&
      typeof incomingEvent === "object" &&
      handledGiftObjects.has(incomingEvent)
    ) {
      console.log("[GIFT] DUPLICATE listener event diabaikan");
      return;
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
        `[GIFT] ${deliveryChannel} diterima tetapi gift belum valid/complete atau duplicate/progress combo`
      );
      return;
    }

    // IMPORTANT: commit the object-level duplicate guard ONLY after
    // giftData() has produced a valid gift. This keeps fallback channels
    // alive when the first listener saw only a partial wrapper.
    if (incomingEvent && typeof incomingEvent === "object") {
      handledGiftObjects.add(incomingEvent);
    }

    // Mark the primary channel only after giftData() has produced a valid
    // gift. This keeps the generic event fallback available when TikTool
    // sends an incomplete named `gift` wrapper.
    if (deliveryChannel === "gift") {
      lastPrimaryGiftAt = eventReceivedAt;
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

    // ID peserta diprioritaskan berdasarkan identitas akun TikTok yang stabil.
    // UniqueId/username dipakai lebih dulu agar userId dari wrapper/transport
    // yang bentrok tidak membuat gift peserta B masuk ke peserta A.
    const normalizedUniqueId = String(gift.uniqueId || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    const normalizedUsername = String(gift.username || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    const normalizedUserId = String(gift.userId || "")
      .trim();

    if (normalizedUniqueId && normalizedUniqueId !== "viewer") {
      key = `unique:${normalizedUniqueId}`;
    } else if (normalizedUsername && normalizedUsername !== "viewer") {
      key = `username:${normalizedUsername}`;
    } else if (normalizedUserId && normalizedUserId !== "unknown") {
      key = `id:${normalizedUserId}`;
    } else {
      key = `name:${String(gift.nickname || "viewer").trim().toLowerCase()}`;
    }

    /* -----------------------------------------------------
       PARTICIPANT SEBELUMNYA
       -----------------------------------------------------
       TikTok/TikTool kadang mengirim userId pada satu event dan
       tidak pada event berikutnya. Cocokkan juga uniqueId/username
       agar coin tidak terpecah ke peserta baru.
       ----------------------------------------------------- */

    let previous = participants.get(key);

    const incomingUniqueId =
      String(gift.uniqueId || "").trim().toLowerCase();
    const incomingUsername =
      String(gift.username || "").trim().toLowerCase();

    /*
       ID-COLLISION PROTECTION
       -----------------------------------------------------
       userId tetap menjadi key utama. Tetapi jika key tersebut ternyata
       sudah berisi peserta lain, jangan pernah menambahkan coin peserta
       baru ke peserta lama hanya karena userId dari TikTool bentrok/tidak
       konsisten.

       Contoh:
         A = 1
         B kirim 1
       hasil wajib:
         A = 1, B = 1
    */
    if (previous) {
      const previousUniqueId =
        String(previous?.uniqueId || "").trim().toLowerCase();
      const previousUsername =
        String(previous?.username || "").trim().toLowerCase();

      const uniqueMismatch =
        incomingUniqueId &&
        previousUniqueId &&
        incomingUniqueId !== previousUniqueId;

      const usernameMismatch =
        incomingUsername &&
        previousUsername &&
        incomingUsername !== previousUsername;

      if (uniqueMismatch || usernameMismatch) {
        const safeKey = incomingUniqueId
          ? `unique:${incomingUniqueId}`
          : incomingUsername
            ? `username:${incomingUsername}`
            : null;

        if (safeKey) {
          console.warn(
            `[GIFT] ID COLLISION dicegah: key=${key} ` +
            `existing=@${previousUniqueId || previousUsername || "unknown"} ` +
            `incoming=@${incomingUniqueId || incomingUsername || "unknown"} ` +
            `-> ${safeKey}`
          );

          key = safeKey;
          previous = participants.get(key);
        }
      }
    }

    /*
       Bila userId berubah tetapi uniqueId/username benar-benar sama,
       tetap gabungkan ke peserta yang sama agar coin tidak terpecah.
    */
    if (!previous) {
      for (const [existingKey, existingParticipant] of participants.entries()) {
        const existingUniqueId =
          String(existingParticipant?.uniqueId || "").trim().toLowerCase();
        const existingUsername =
          String(existingParticipant?.username || "").trim().toLowerCase();

        if (
          (incomingUniqueId && existingUniqueId === incomingUniqueId) ||
          (incomingUsername && existingUsername === incomingUsername)
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
     * COMPATIBILITY SNAPSHOT
     *
     * Tetap kirim snapshot leaderboard setelah update cepat agar frontend
     * lama/varian yang masih mengandalkan `auction:participants` juga
     * langsung menerima peserta terbaru.
     *
     * Ini TIDAK menambah coin. Server sudah menyimpan TOTAL coin di
     * `participant`, dan frontend app.js yang dipakai proyek melakukan merge
     * berdasarkan total coin (bukan menambahkan gift.coinValue lagi).
     *
     * setImmediate menjaga jalur TikTok -> participant:update tetap cepat.
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

  // Standard TikTool event. This is the authoritative/fast gift path.
  conn.on("gift", (event) => {
    // Do not mark the primary path as successful until handleGiftEvent()
    // confirms that the payload contains a valid gift. Some TikTool
    // transports emit a named "gift" event with an incomplete wrapper;
    // marking it here would suppress the generic fallback and make the
    // gift disappear entirely.
    handleGiftEvent(event, "gift");
  });

  /* =======================================================
     GIFT EVENT COMPATIBILITY BRIDGE
     =======================================================
     Keep the working TikTok connection untouched. Some @tiktool/live
     transports/adapters expose the same webcast gift under a slightly
     different EventEmitter name. These listeners only forward gift-shaped
     events into the existing handler; they do not change coin calculation.
  ======================================================= */
  const compatibilityGiftEvents = [
    "giftEvent",
    "gift_event",
    "GiftEvent",
    "TikTokGift",
    "webcastGift",
    "webcast_gift"
  ];

  for (const eventName of compatibilityGiftEvents) {
    conn.on(eventName, (event) => {
      console.log(`[TikTok] compatibility event received: ${eventName}`);
      handleGiftEvent(event, `compat:${eventName}`);
    });
  }

  /* =======================================================
     RAW EVENT DIAGNOSTIC
     =======================================================
     If the connector is connected but its named gift listener stays silent,
     expose the actual EventEmitter event names in Railway logs. This is only
     a diagnostic tap: the original emit() is always called unchanged.
     It also lets us recover gift payloads from an unexpected event name when
     the payload itself clearly identifies a gift.
  ======================================================= */
  if (typeof conn.emit === "function" && !conn.__coinAuctionEmitTap) {
    const originalEmit = conn.emit.bind(conn);
    conn.emit = function(eventName, ...args) {
      const name = String(eventName || "");
      const lowerName = name.toLowerCase();

      if (lowerName !== "connected" && lowerName !== "disconnected") {
        if (lowerName.includes("gift") || lowerName === "event") {
          console.log(`[TikTok RAW EVENT] ${name}`);
        }

        const first = args[0];
        const second = args[1];
        const rawFirstCandidate = findGiftPayload(first);
        const rawSecondCandidate = findGiftPayload(second);
        const candidate = rawFirstCandidate || rawSecondCandidate || unwrapTikTokEvent(first);
        const candidateType = String(
          first?.event ||
          first?.type ||
          candidate?.event ||
          candidate?.type ||
          (typeof first === "string" ? first : "")
        ).toLowerCase();

        const looksLikeGift =
          candidateType === "gift" ||
          lowerName.includes("gift") ||
          Boolean(rawFirstCandidate || rawSecondCandidate);

        if (looksLikeGift && !lowerName.includes("gift") && lowerName !== "event") {
          console.log(`[TikTok RAW EVENT] gift-shaped payload on ${name}`);
          handleGiftEvent(candidate, `raw:${name}`);
        }
      }

      return originalEmit(eventName, ...args);
    };
    conn.__coinAuctionEmitTap = true;
  }

  // Lightweight diagnostics: confirms that the live socket is actually
  // delivering named events. This does not alter auction processing.
  for (const eventName of ["roomInfo", "like", "member", "social", "subscribe", "viewerCount"]) {
    conn.on(eventName, () => noteTikTokEvent(eventName));
  }

  // Compatibility with transports that expose all events via `event`.
  // IMPORTANT: some @tiktool/live builds emit the raw websocket envelope
  // here even when the named `gift` listener is silent. Always inspect BOTH
  // arguments and normalize the actual gift payload before giving up.
  conn.on("event", (incomingEvent, maybePayload) => {
    const candidates = [];

    if (incomingEvent !== undefined) candidates.push(incomingEvent);
    if (maybePayload !== undefined) candidates.push(maybePayload);

    // Support the common `(eventName, payload)` form as well as
    // `{ event, data }` / `{ type, payload }` envelopes.
    if (
      typeof incomingEvent === "string" &&
      maybePayload !== undefined
    ) {
      candidates.unshift({
        type: incomingEvent,
        data: maybePayload
      });
    }

    if (
      incomingEvent === undefined &&
      maybePayload !== undefined
    ) {
      candidates.unshift(maybePayload);
    }

    let candidate = null;
    let giftCandidate = null;

    for (const rawCandidate of candidates) {
      /*
       * FAST STANDARD ENVELOPE:
       * TikTool documents gift frames as:
       *   { event: "gift", data: { user, giftId, giftName, diamondCount, ... } }
       *
       * Prefer the explicit `data` object when the outer frame declares a gift.
       * This avoids losing a valid 1-diamond gift when a transport wrapper is
       * non-enumerable/partial and the generic recursive extractor cannot see
       * the inner fields.
       */
      if (rawCandidate && typeof rawCandidate === "object") {
        const rawType = String(
          rawCandidate.event ??
          rawCandidate.type ??
          rawCandidate.eventType ??
          rawCandidate.event_type ??
          ""
        ).toLowerCase();

        if (
          rawType === "gift" &&
          rawCandidate.data &&
          typeof rawCandidate.data === "object"
        ) {
          giftCandidate = rawCandidate.data;
          break;
        }

        if (
          rawType === "gift" &&
          rawCandidate.payload &&
          typeof rawCandidate.payload === "object"
        ) {
          giftCandidate = rawCandidate.payload;
          break;
        }
      }

      const normalized = normalizeRawEventCandidate(rawCandidate);
      if (!candidate && normalized) candidate = normalized;

      // For gift events, ALWAYS prefer the strict event -> data -> gift
      // extractor. The generic normalizer may otherwise return the outer
      // {event:"gift"} envelope and hide data.diamondCount.
      const found =
        extractGiftPayloadStrict(rawCandidate) ||
        normalizeRawEventCandidate(rawCandidate) ||
        findGiftPayload(rawCandidate);

      if (found) {
        giftCandidate = found;
        break;
      }
    }

    // Also inspect a combined envelope. This catches transports where the
    // event type is supplied in arg #1 and the actual gift is arg #2.
    if (!giftCandidate && candidates.length > 1) {
      const combined = {
        event:
          typeof incomingEvent === "string" ? incomingEvent : undefined,
        data: maybePayload !== undefined ? maybePayload : incomingEvent
      };
      giftCandidate =
        extractGiftPayloadStrict(combined) ||
        normalizeRawEventCandidate(combined);
    }

    const event =
      candidate ||
      (typeof incomingEvent === "object" ? incomingEvent : {}) ||
      {};

    const type = String(
      incomingEvent?.event ||
      incomingEvent?.type ||
      event?.event ||
      event?.type ||
      (typeof incomingEvent === "string" ? incomingEvent : "") ||
      ""
    ).toLowerCase();

    if (type === "streamend") {
      handleStreamEnd(
        conn,
        event?.reason || event?.data?.reason || "creator_offline"
      );
      return;
    }

    if (!giftCandidate) {
      // Keep diagnostics concise. We intentionally do not print full raw
      // payloads because they may contain a large amount of room metadata.
      if (type === "gift" || type.includes("gift")) {
        console.log("[GIFT] generic event gift tidak lengkap -> diabaikan");
      }
      return;
    }

    // IMPORTANT: a gift-shaped envelope with giftId/name but coin=0 is NOT
    // a payable gift. Do not send it into handleGiftEvent(). This removes the
    // repeated `giftId tidak ada / coin=0` noise seen in Railway and, more
    // importantly, prevents partial generic events from competing with the
    // working primary `gift` listener.
    if (!isUsableGenericGiftPayload(giftCandidate)) {
      const partialId =
        giftCandidate?.giftId ??
        giftCandidate?.gift_id ??
        giftCandidate?.gift?.giftId ??
        giftCandidate?.gift?.gift_id ??
        null;
      console.log(
        `[GIFT] generic event non-gift/partial -> diabaikan (coin/diamond=0, giftId=${partialId || "-"})`
      );
      return;
    }

    console.log(
      type === "gift"
        ? "[GIFT] diterima melalui generic event channel"
        : "[GIFT] gift-shaped payload valid melalui generic event channel"
    );

    handleGiftEvent(giftCandidate, "event");
  });

  /*
   * RAW MESSAGE FALLBACK
   *
   * A small number of connector builds expose the underlying websocket frame
   * as `message` instead of forwarding it through the generic `event`
   * listener. If a message is a gift envelope, feed ONLY that gift into the
   * existing single handler. All duplicate protection remains centralized in
   * handleGiftEvent(), so this cannot create a second coin for the same gift.
   */
  conn.on("message", (rawMessage) => {
    let giftCandidate = null;

    if (rawMessage && typeof rawMessage === "object") {
      const rawType = String(
        rawMessage.event ??
        rawMessage.type ??
        rawMessage.eventType ??
        rawMessage.event_type ??
        ""
      ).toLowerCase();

      if (
        rawType === "gift" &&
        rawMessage.data &&
        typeof rawMessage.data === "object"
      ) {
        giftCandidate = rawMessage.data;
      } else if (
        rawType === "gift" &&
        rawMessage.payload &&
        typeof rawMessage.payload === "object"
      ) {
        giftCandidate = rawMessage.payload;
      }
    }

    giftCandidate =
      giftCandidate ||
      extractGiftPayloadStrict(rawMessage) ||
      normalizeRawEventCandidate(rawMessage);
    if (!giftCandidate) return;

    const type = String(
      giftCandidate?.event ||
      giftCandidate?.type ||
      ""
    ).toLowerCase();

    const actualGift =
      type === "gift"
        ? (findGiftPayload(giftCandidate) || giftCandidate)
        : findGiftPayload(giftCandidate);

    if (!actualGift) return;

    // Raw message fallback also must contain a real positive coin/diamond
    // value. giftId/name alone is not enough.
    if (!isUsableGenericGiftPayload(actualGift)) {
      console.log("[GIFT] raw message partial/non-gift -> diabaikan (coin/diamond=0)");
      return;
    }

    console.log("[GIFT] gift-shaped payload valid melalui raw message channel");

    if (
      lastPrimaryGiftAt > 0 &&
      Date.now() - lastPrimaryGiftAt <= GENERIC_GIFT_FALLBACK_TTL
    ) {
      console.log("[GIFT] raw message diabaikan: primary gift path aktif");
      return;
    }

    handleGiftEvent(actualGift, "raw:message");
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

    startGiftCatalogWarmup();
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

    // Warm the official gift catalog in background. This never blocks connect()
    // and is only used if a raw/generic gift frame arrives without diamondCount.
    startGiftCatalogWarmup();

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
      recentComboReceipts.clear();

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
      recentComboReceipts.clear();
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
      recentComboReceipts.clear();
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
      recentComboReceipts.clear();

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
      recentComboReceipts.clear();

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
