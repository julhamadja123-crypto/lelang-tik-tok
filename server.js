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

/*
|--------------------------------------------------------------------------
| TIKTOK LIVE CONNECTOR
|--------------------------------------------------------------------------
| Package:
|   tiktok-live-connector 2.4.4
|
| IMPORTANT:
|   Server ini TIDAK menggunakan API KEY.
|
| User cukup memasukkan username TikTok.
|--------------------------------------------------------------------------
*/

let TikTokLiveConnection = null;

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  const mod = await import("tiktok-live-connector");

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (typeof TikTokLiveConnection !== "function") {
    throw new Error(
      "TikTokLiveConnection tidak ditemukan. Pastikan tiktok-live-connector versi 2.4.4 terinstall."
    );
  }

  return TikTokLiveConnection;
}

/*
|--------------------------------------------------------------------------
| STATE
|--------------------------------------------------------------------------
*/

let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
let manualDisconnect = false;

let auctionActive = false;

/*
|--------------------------------------------------------------------------
| GIFT DEDUPLICATION
|--------------------------------------------------------------------------
*/

const processedGiftEvents = new Map();

const PROCESSED_GIFT_TTL = 60 * 1000;

function cleanupProcessedGiftEvents(now = Date.now()) {
  for (const [key, time] of processedGiftEvents.entries()) {
    if (now - time > PROCESSED_GIFT_TTL) {
      processedGiftEvents.delete(key);
    }
  }
}

/*
|--------------------------------------------------------------------------
| UTILITY
|--------------------------------------------------------------------------
*/

function cleanUsername(value) {
  let username = String(value || "").trim();

  username = username
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/live.*$/i, "")
    .replace(/[/?#].*$/g, "")
    .replace(/\s+/g, "");

  return username;
}

function emitStatus(message, ok = false) {
  console.log(`[STATUS] ${message}`);

  io.emit("live:status", {
    message,
    ok
  });
}

/*
|--------------------------------------------------------------------------
| ERROR FORMATTER
|--------------------------------------------------------------------------
*/

function formatTikTokError(err) {
  const message =
    err?.message ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const lower = message.toLowerCase();

  /*
   * Signing provider
   */
  if (
    lower.includes("business plan") ||
    lower.includes("premium") ||
    lower.includes("permission from the signature provider") ||
    lower.includes("signature provider") ||
    lower.includes("signing provider")
  ) {
    return (
      "Sign server TikTok menolak request ini. " +
      "Server sedang berjalan tanpa API key, tetapi signing pihak ketiga " +
      "dapat memiliki pembatasan atau rate limit."
    );
  }

  /*
   * 404 signing
   */
  if (
    lower.includes("failed to sign request") ||
    lower.includes("webcast/im/fetch") ||
    lower.includes("status code 404")
  ) {
    return (
      "TikTok gagal menyediakan koneksi WebSocket. " +
      "Coba beberapa saat lagi atau gunakan username lain yang sedang LIVE."
    );
  }

  /*
   * Offline
   */
  if (
    lower.includes("offline") ||
    lower.includes("not live") ||
    lower.includes("useroffline")
  ) {
    return (
      "Akun TikTok tidak sedang LIVE atau username TikTok tidak benar."
    );
  }

  /*
   * Username
   */
  if (
    lower.includes("invalid unique") ||
    lower.includes("invalid username") ||
    lower.includes("uniqueid")
  ) {
    return "Username TikTok tidak valid.";
  }

  /*
   * Timeout
   */
  if (
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return (
      "Koneksi ke TikTok timeout. Coba ulangi beberapa detik lagi."
    );
  }

  /*
   * Network
   */
  if (
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network")
  ) {
    return (
      "Koneksi jaringan ke TikTok terputus. Silakan coba lagi."
    );
  }

  return message;
}

/*
|--------------------------------------------------------------------------
| NUMBER HELPER
|--------------------------------------------------------------------------
*/

function toPositiveNumber(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return 0;
}

/*
|--------------------------------------------------------------------------
| USER DATA
|--------------------------------------------------------------------------
*/

function getUserData(event) {
  const user = event?.user || {};

  return {
    userId:
      user.userId ||
      user.id ||
      event?.userId ||
      event?.user_id ||
      "unknown",

    uniqueId:
      user.uniqueId ||
      event?.uniqueId ||
      event?.nickname ||
      "Viewer",

    nickname:
      user.nickname ||
      event?.nickname ||
      user.uniqueId ||
      event?.uniqueId ||
      "Viewer",

    avatar:
      user.profilePictureUrl ||
      user.profilePicture?.url ||
      user.profilePicture?.urls?.[0] ||
      event?.profilePictureUrl ||
      event?.profilePicture ||
      null
  };
}

/*
|--------------------------------------------------------------------------
| GIFT DATA
|--------------------------------------------------------------------------
*/

function getGiftData(event) {
  if (!event) {
    return null;
  }

  const user = getUserData(event);

  /*
   * Gift ID
   */
  const giftId = String(
    event.giftId ??
    event.gift_id ??
    event.gift?.giftId ??
    event.gift?.gift_id ??
    event.giftDetails?.giftId ??
    event.giftDetails?.gift_id ??
    ""
  );

  /*
   * Gift name
   */
  const giftName =
    event.giftName ||
    event.gift_name ||
    event.gift?.giftName ||
    event.gift?.name ||
    event.giftDetails?.giftName ||
    event.giftDetails?.name ||
    (giftId ? `Gift #${giftId}` : "Gift");

  /*
   * Diamond / coin per gift
   */
  const diamondCount = toPositiveNumber(
    event.diamondCount,
    event.diamond_count,

    event.gift?.diamondCount,
    event.gift?.diamond_count,
    event.gift?.diamondCost,
    event.gift?.diamond_cost,

    event.giftDetails?.diamondCount,
    event.giftDetails?.diamond_count,
    event.giftDetails?.diamondCost,
    event.giftDetails?.diamond_cost,

    event.extendedGiftInfo?.diamondCount,
    event.extendedGiftInfo?.diamond_count,
    event.extendedGiftInfo?.diamondCost,
    event.extendedGiftInfo?.diamond_cost,

    event.extendedGiftInfo?.diamond_count,
    event.extendedGiftInfo?.diamond_cost
  );

  /*
   * Repeat count
   */
  const repeatCountRaw = toPositiveNumber(
    event.repeatCount,
    event.repeat_count,

    event.gift?.repeatCount,
    event.gift?.repeat_count,

    1
  );

  const repeatCount = Math.max(
    1,
    Math.floor(repeatCountRaw)
  );

  /*
   * Gift type
   */
  const giftType = Number(
    event.giftType ??
    event.gift_type ??
    event.gift?.giftType ??
    event.gift?.gift_type ??
    event.giftDetails?.giftType ??
    event.giftDetails?.gift_type ??
    0
  );

  /*
   * Repeat end
   */
  const repeatEndValue =
    event.repeatEnd ??
    event.repeat_end ??
    event.gift?.repeatEnd ??
    event.gift?.repeat_end;

  const repeatEnd =
    repeatEndValue === true ||
    repeatEndValue === 1 ||
    repeatEndValue === "1" ||
    repeatEndValue === "true";

  /*
   * Streak gift
   *
   * Tunggu sampai streak selesai.
   */
  if (giftType === 1 && !repeatEnd) {
    console.log(
      `[GIFT] Streak masih berjalan: @${user.uniqueId} | ${giftName} | x${repeatCount}`
    );

    return null;
  }

  /*
   * Data gift tidak lengkap
   */
  if (!gift
