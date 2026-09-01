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
| Project menggunakan CommonJS.
| Dynamic import digunakan agar kompatibel dengan package v2.
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
| UTILITY
|--------------------------------------------------------------------------
*/

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/\/live.*$/i, "")
    .replace(/^@/, "")
    .replace(/\s+/g, "");
}

function emitStatus(message, ok = false) {
  console.log(`[STATUS] ${message}`);

  io.emit("live:status", {
    message,
    ok
  });
}

function formatTikTokError(err) {
  const message =
    err?.message ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const lower = message.toLowerCase();

  /*
   * Signing / Euler
   */
  if (
    lower.includes("business plan") ||
    lower.includes("fetchwebcastsignaturefromeulerroute") ||
    lower.includes("signing provider")
  ) {
    return (
      "Signing provider TikTok menolak koneksi. " +
      "Coba redeploy Railway tanpa cache. " +
      "Jika tetap gagal, isi TIKTOK_SIGN_API_KEY dengan API key Euler Stream."
    );
  }

  if (
    lower.includes("sign request") ||
    lower.includes("webcast/im/fetch") ||
    lower.includes("status code 404")
  ) {
    return (
      "TikTok/Euler menolak proses signing WebSocket. " +
      "Pastikan package menggunakan tiktok-live-connector 2.4.4 dan " +
      "redeploy Railway tanpa cache."
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
      "Koneksi ke TikTok timeout. " +
      "Coba ulangi beberapa detik lagi."
    );
  }

  return message;
}

/*
|--------------------------------------------------------------------------
| STOP CONNECTION
|--------------------------------------------------------------------------
*/

async function stopConnection() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  manualDisconnect = true;

  const connection = liveConnection;
  liveConnection = null;

  if (connection) {
    try {
      await connection.disconnect();
    } catch (err) {
      console.warn(
        "[TikTok] Error saat disconnect:",
        err?.message || err
      );
    }
  }
}

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
| NUMBER HELPERS
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
   * Gift Name
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
   * Diamond / Coin per gift
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
   * Gift type 1 dapat melakukan streak.
   * Event yang belum selesai jangan dihitung.
   */
  if (giftType === 1 && !repeatEnd) {
    console.log(
      `[GIFT] Streak masih berjalan: ${user.uniqueId} | ${giftName} | x${repeatCount}`
    );

    return null;
  }

  /*
   * Jangan mengarang nilai coin jika tidak tersedia.
   */
  if (!giftId || diamondCount <= 0) {
    console.warn(
      "[GIFT] Data coin tidak lengkap:",
      {
        giftId,
        giftName,
        diamondCount,
        repeatCount,
        giftType,
        repeatEnd,
        user: user.uniqueId,
        eventKeys: Object.keys(event)
      }
    );

    io.emit("live:gift-debug", {
      message:
        `Gift "${giftName}" diterima tetapi nilai coin/diamond tidak terbaca.`,

      debug: {
        giftId,
        giftName,
        diamondCount,
        repeatCount,
        giftType,
        repeatEnd,
        user: user.uniqueId,
        eventKeys: Object.keys(event)
      }
    });

    return null;
  }

  /*
   * Total coin
   */
  const coinValue =
    diamondCount * repeatCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  /*
   * Deduplication
   */
  const eventKey =
    String(
      event.msgId ||
      event.transactionId ||
      event.transaction_id ||
      (
        `${event.groupId || ""}|` +
        `${user.userId}|` +
        `${giftId}|` +
        `${repeatCount}|` +
        `${event.createTime || event.timestamp || ""}|` +
        `${repeatEnd}`
      )
    );

  cleanupProcessedGiftEvents();

  if (processedGiftEvents.has(eventKey)) {
    console.log(
      "[GIFT] Event duplikat diabaikan:",
      eventKey
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    Date.now()
  );

  /*
   * LOG GIFT VALID
   */
  console.log(
    `[GIFT] VALID | @${user.uniqueId} | ${giftName} | ` +
    `${diamondCount} x ${repeatCount} = ${coinValue} coin`
  );

  /*
   * Data untuk frontend
   */
  return {
    username: user.uniqueId,
    nickname: user.nickname,

    giftName,
    giftId,

    diamondCount,
    repeatCount,
    coinValue,

    giftType,
    repeatEnd,

    msgId:
      event.msgId ||
      null,

    transactionId:
      event.transactionId ||
      event.transaction_id ||
      null,

    groupId:
      event.groupId ||
      event.group_id ||
      null,

    avatar: user.avatar
  };
}

/*
|--------------------------------------------------------------------------
| CONNECT TO TIKTOK LIVE
|--------------------------------------------------------------------------
*/

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

  /*
   * Putuskan koneksi lama
   */
  await stopConnection();

  manualDisconnect = false;
  activeUsername = username;

  /*
   * API key signing
   */
  const signApiKey =
    process.env.TIKTOK_SIGN_API_KEY ||
    process.env.EULER_API_KEY ||
    undefined;

  console.log(
    "================================================"
  );

  console.log(
    `[TikTok] Mencoba koneksi @${username}`
  );

  console.log(
    `[TikTok] Signing API key: ${
      signApiKey ? "TERSEDIA" : "TIDAK ADA"
    }`
  );

  console.log(
    "[TikTok] Package: tiktok-live-connector 2.4.4"
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /*
   * Connector options
   */
  const options = {
    ...(signApiKey
      ? { signApiKey }
      : {}),

    processInitialData: false,

    fetchRoomInfoOnConnect: true,

    enableExtendedGiftInfo: true,

    webClientOptions: {
      timeout: {
        request: 15000
      }
    },

    wsClientOptions: {
      handshakeTimeout: 15000
    }
  };

  /*
   * Buat koneksi
   */
  const conn =
    new Connector(
      username,
      options
    );

  liveConnection = conn;

  /*
   |--------------------------------------------------------------------------
   | GIFT
   |--------------------------------------------------------------------------
   */

  conn.on("gift", (event) => {
    console.log(
      "[TikTok] Gift event diterima:",
      {
        active: auctionActive,

        username:
          event?.user?.uniqueId ||
          event?.uniqueId,

        giftId:
          event?.giftId,

        giftName:
          event?.giftName,

        diamondCount:
          event?.diamondCount,

        repeatCount:
          event?.repeatCount,

        repeatEnd:
          event?.repeatEnd
      }
    );

    /*
     * Gift hanya diteruskan ketika
     * lelang sedang aktif.
     */
    if (!auctionActive) {
      console.log(
        "[GIFT] Diabaikan karena lelang belum aktif."
      );

      return;
    }

    const gift =
      getGiftData(event);

    if (!gift) {
      return;
    }

    /*
     * Kirim gift ke frontend
     */
    io.emit(
      "live:gift",
      gift
    );
  });

  /*
   |--------------------------------------------------------------------------
   | CHAT
   |--------------------------------------------------------------------------
   */

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

  /*
   |--------------------------------------------------------------------------
   | CONNECTED
   |--------------------------------------------------------------------------
   */

  conn.on("connected", (state) => {
    console.log(
      "[TikTok] Event connected:",
      state
    );
  });

  /*
   |--------------------------------------------------------------------------
   | DISCONNECTED
   |--------------------------------------------------------------------------
   */

  conn.on("disconnected", () => {
    console.warn(
      `[TikTok] Koneksi @${activeUsername} terputus.`
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
              `Reconnect gagal: ${formatTikTokError(err)}`
            );
          });
        }
      }, 5000);
  });

  /*
   |--------------------------------------------------------------------------
   | ERROR
   |--------------------------------------------------------------------------
   */

  conn.on("error", (err) => {
    console.error(
      "[TikTok] Error:",
      err
    );

    emitStatus(
      `Error TikTok: ${formatTikTokError(err)}`
    );
  });

  /*
   |--------------------------------------------------------------------------
   | CONNECT
   |--------------------------------------------------------------------------
   */

  try {
    const state =
      await conn.connect();

    /*
     * Pastikan koneksi yang aktif
     * masih connection yang sama.
     */
    if (liveConnection !== conn) {
      try {
        await conn.disconnect();
      } catch (_) {
        // Abaikan error disconnect
      }

      throw new Error(
        "Koneksi TikTok digantikan oleh koneksi lain."
      );
    }

    const roomId =
      state?.roomId ||
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
      formatTikTokError(err);

    console.error(
      "[TikTok] Gagal connect:",
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

/*
|--------------------------------------------------------------------------
| SOCKET.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {
  console.log(
    `[Socket] Client terhubung: ${socket.id}`
  );

  /*
   * Kirim status saat frontend pertama kali membuka halaman.
   */
  const connected =
    Boolean(
      liveConnection?.isConnected ||
      liveConnection?.state?.isConnected
    );

  socket.emit(
    "live:status",
    {
      ok: connected,

      message:
        connected
          ? `Terhubung ke @${activeUsername}`
          : "Belum terhubung ke TikTok LIVE"
    }
  );

  /*
   |--------------------------------------------------------------------------
   | CONNECT
   |--------------------------------------------------------------------------
   */

  socket.on(
    "live:connect",
    async (data = {}) => {
      try {
        const username =
          data.username;

        console.log(
          `[Socket] Request connect: @${username}`
        );

        await connectToLive(
          username
        );

      } catch (err) {
        console.error(
          "[Socket] live:connect error:",
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

  /*
   |--------------------------------------------------------------------------
   | AUCTION STATE
   |--------------------------------------------------------------------------
   */

  socket.on(
    "auction:state",
    (data = {}) => {
      auctionActive =
        Boolean(data.active);

      console.log(
        `[Auction] ${
          auctionActive
            ? "ACTIVE"
            : "INACTIVE"
        }`
      );
    }
  );

  /*
   |--------------------------------------------------------------------------
   | DISCONNECT TIKTOK
   |--------------------------------------------------------------------------
   */

  socket.on(
    "live:disconnect",
    async () => {
      console.log(
        "[Socket] Request disconnect TikTok."
      );

      auctionActive = false;

      await stopConnection();

      activeUsername = null;

      emitStatus(
        "Koneksi TikTok LIVE diputus."
      );
    }
  );

  /*
   |--------------------------------------------------------------------------
   | SOCKET DISCONNECT
   |--------------------------------------------------------------------------
   */

  socket.on(
    "disconnect",
    () => {
      console.log(
        `[Socket] Client terputus: ${socket.id}`
      );
    }
  );
});

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

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

      auctionActive:
        auctionActive
    });
  }
);

/*
|--------------------------------------------------------------------------
| FRONTEND
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      __dirname + "/index.html"
    );
  }
);

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "=============================================="
    );

    console.log(
      `Server berjalan di port ${PORT}`
    );

    console.log(
      "TikTok Live Coin Auction siap."
    );

    console.log(
      "=============================================="
    );
  }
);

/*
|--------------------------------------------------------------------------
| PROCESS ERROR HANDLERS
|--------------------------------------------------------------------------
*/

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
