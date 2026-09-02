"use strict";

/*
=========================================================
 TIKTOK LIVE COIN AUCTION
 SERVER.JS
 Compatible:
   express              4.21.2
   socket.io             4.8.1
   tiktok-live-connector 2.4.4
   Node.js               >= 20

 IMPORTANT:
 - Gift coin menggunakan diamondCount 1:1
 - Tidak ada multiplier x2
 - Gift streak hanya diproses saat repeatEnd = true
 - Bisa berjalan tanpa SIGN_API_KEY
=========================================================
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/* =========================================================
   EXPRESS + SOCKET.IO
========================================================= */

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/*
  Menyajikan index.html, app.js, CSS, gambar, dll.
*/
app.use(express.static(__dirname));

/* =========================================================
   GLOBAL STATE
========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;

let activeUsername = null;

let reconnectTimer = null;

let manualDisconnect = false;

let auctionActive = false;

let connectedAt = null;

let currentRoomId = null;

let currentViewerCount = 0;

/* =========================================================
   SIGNING CONFIGURATION
========================================================= */

const SIGN_API_KEY =
  process.env.SIGN_API_KEY ||
  process.env.TIKTOK_SIGN_API_KEY ||
  "";

const USE_SIGN_API_KEY =
  String(process.env.USE_SIGN_API_KEY || "")
    .toLowerCase()
    .trim();

let signingMode = "public";

if (
  SIGN_API_KEY &&
  USE_SIGN_API_KEY !== "false" &&
  USE_SIGN_API_KEY !== "0" &&
  USE_SIGN_API_KEY !== "no"
) {
  signingMode = "api-key";
}

/* =========================================================
   GIFT DUPLICATE PROTECTION
========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;

/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanUsername(value) {
  if (value === undefined || value === null) {
    return "";
  }

  let username = String(value).trim();

  if (!username) {
    return "";
  }

  /*
    Support:
      username
      @username
      https://www.tiktok.com/@username
      https://www.tiktok.com/@username/live
  */

  username = username
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
    .replace(/^@/, "")
    .split("?")[0]
    .split("#")[0]
    .replace(/\/live.*$/i, "")
    .replace(/\/.*$/i, "")
    .trim();

  return username;
}

function numberPositive(...values) {
  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }

  return 0;
}

function emitStatus(message, ok = false, extra = {}) {
  const payload = {
    ok: Boolean(ok),
    message: String(message || ""),
    username: activeUsername || null,
    connected: Boolean(liveConnection),
    connectedAt: connectedAt || null,
    roomId: currentRoomId || null,
    viewerCount: currentViewerCount || 0,
    signingMode,
    ...extra
  };

  io.emit("live:status", payload);

  console.log(
    `[STATUS] ${ok ? "OK" : "INFO"} - ${payload.message}`
  );
}

function emitAuctionState() {
  io.emit("auction:state", {
    active: auctionActive
  });

  /*
    Alias tambahan agar kompatibel dengan app.js versi berbeda.
  */
  io.emit("auctionActive", {
    active: auctionActive
  });
}

function formatError(error) {
  if (!error) {
    return "Terjadi error yang tidak diketahui.";
  }

  const message = String(
    error.message ||
    error.error ||
    error.reason ||
    error
  );

  const lower = message.toLowerCase();

  if (
    lower.includes("empty payload") ||
    lower.includes("payload is empty")
  ) {
    return "TikTok mengembalikan data kosong. Coba koneksi LIVE lagi.";
  }

  if (
    lower.includes("offline") ||
    lower.includes("not live") ||
    lower.includes("useroffline")
  ) {
    return "Username TikTok tersebut sedang tidak LIVE.";
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return "Koneksi ke TikTok timeout. Server akan mencoba lagi.";
  }

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return "TikTok sedang membatasi koneksi. Server akan mencoba lagi.";
  }

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "Koneksi membutuhkan signing/API key atau layanan signing sedang bermasalah.";
  }

  if (
    lower.includes("404") ||
    lower.includes("not found")
  ) {
    return "Username atau LIVE TikTok tidak ditemukan.";
  }

  return message;
}

/* =========================================================
   LOAD TIKTOK CONNECTOR
========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  console.log(
    "[TIKTOK] Loading tiktok-live-connector..."
  );

  /*
    package 2.4.4 adalah ESM.
    server.js tetap CommonJS.
    Karena itu kita menggunakan dynamic import().
  */

  const mod = await import("tiktok-live-connector");

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (typeof TikTokLiveConnection !== "function") {
    throw new Error(
      "TikTokLiveConnection tidak ditemukan di tiktok-live-connector."
    );
  }

  console.log(
    "[TIKTOK] TikTokLiveConnection berhasil dimuat."
  );

  return TikTokLiveConnection;
}

/* =========================================================
   USER DATA
========================================================= */

function getUserData(event) {
  const user =
    event?.user ||
    event?.userDetails ||
    event?.author ||
    {};

  const uniqueId =
    user.uniqueId ||
    user.unique_id ||
    event?.uniqueId ||
    event?.unique_id ||
    "";

  const userId =
    user.userId ||
    user.user_id ||
    event?.userId ||
    event?.user_id ||
    "";

  const nickname =
    user.nickname ||
    user.displayName ||
    user.display_name ||
    event?.nickname ||
    uniqueId ||
    "Unknown";

  /*
    Prioritaskan foto profil TikTok.
  */

  const avatar =
    user.avatarLarger ||
    user.avatarMedium ||
    user.avatarThumb ||
    user.avatarThumbUrl ||
    user.avatarLargerUrl ||
    user.profilePictureUrl ||
    user.profilePicUrl ||
    user.avatar_url ||
    event?.avatarLarger ||
    event?.avatarMedium ||
    event?.avatarThumb ||
    event?.profilePictureUrl ||
    event?.avatar ||
    "";

  return {
    username: cleanUsername(uniqueId),
    nickname: String(nickname || "Unknown"),
    userId: String(userId || ""),
    avatar: String(avatar || "")
  };
}

/* =========================================================
   TIKTOK COIN VALUE
========================================================= */

function getTikTokCoinValue(event) {
  /*
    PENTING:

    TikTok LIVE Connector memberikan diamondCount
    sebagai nilai diamond gift.

    Kita sengaja TIDAK menggunakan:
      coinValue
      coinCount

    supaya tidak terjadi multiplier / perhitungan ganda.
  */

  return numberPositive(
    event?.diamondCount,
    event?.diamond_count,

    event?.gift?.diamondCount,
    event?.gift?.diamond_count,

    event?.giftDetails?.diamondCount,
    event?.giftDetails?.diamond_count,

    event?.extendedGiftInfo?.diamondCount,
    event?.extendedGiftInfo?.diamond_count
  );
}

/* =========================================================
   REPEAT COUNT
========================================================= */

function getRepeatCount(event) {
  return Math.max(
    1,
    Math.floor(
      numberPositive(
        event?.repeatCount,
        event?.repeat_count,

        event?.gift?.repeatCount,
        event?.gift?.repeat_count,

        event?.giftDetails?.repeatCount,
        event?.giftDetails?.repeat_count
      ) || 1
    )
  );
}

/* =========================================================
   GIFT TYPE
========================================================= */

function getGiftType(event) {
  const value =
    event?.giftType ??
    event?.gift_type ??
    event?.gift?.giftType ??
    event?.gift?.gift_type ??
    event?.giftDetails?.giftType ??
    event?.giftDetails?.gift_type;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

/* =========================================================
   REPEAT END
========================================================= */

function getRepeatEnd(event) {
  const value =
    event?.repeatEnd ??
    event?.repeat_end ??
    event?.gift?.repeatEnd ??
    event?.gift?.repeat_end ??
    event?.giftDetails?.repeatEnd ??
    event?.giftDetails?.repeat_end;

  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}

/* =========================================================
   CLEANUP DUPLICATES
========================================================= */

function cleanupGiftEvents() {
  const now = Date.now();

  for (const [key, timestamp] of processedGiftEvents.entries()) {
    if (now - timestamp > GIFT_TTL) {
      processedGiftEvents.delete(key);
    }
  }
}

setInterval(cleanupGiftEvents, 30 * 1000);

/* =========================================================
   CREATE GIFT EVENT KEY
========================================================= */

function createGiftEventKey(
  event,
  user,
  repeatCount,
  repeatEnd
) {
  const stableId =
    event?.msgId ||
    event?.messageId ||
    event?.message_id ||
    event?.transactionId ||
    event?.transaction_id;

  if (stableId) {
    return `stable:${String(stableId)}`;
  }

  const groupId =
    event?.groupId ||
    event?.group_id ||
    event?.gift?.groupId ||
    event?.gift?.group_id ||
    "";

  const giftId =
    event?.giftId ||
    event?.gift_id ||
    event?.gift?.giftId ||
    event?.gift?.gift_id ||
    "";

  const createTime =
    event?.createTime ||
    event?.create_time ||
    event?.timestamp ||
    "";

  return [
    "fingerprint",
    user.userId,
    user.username,
    giftId,
    groupId,
    repeatCount,
    repeatEnd ? 1 : 0,
    createTime
  ].join(":");
}

/* =========================================================
   PARSE GIFT
========================================================= */

function parseGift(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const user = getUserData(event);

  const giftId =
    event.giftId ??
    event.gift_id ??
    event.gift?.giftId ??
    event.gift?.gift_id ??
    "";

  const giftName =
    event.giftName ||
    event.gift_name ||
    event.giftDetails?.giftName ||
    event.giftDetails?.gift_name ||
    event.gift?.giftName ||
    event.gift?.gift_name ||
    "Unknown Gift";

  const tikTokCoin = getTikTokCoinValue(event);

  /*
    Jika diamondCount tidak tersedia,
    jangan tebak nilai coin.
  */

  if (tikTokCoin <= 0) {
    console.warn(
      "[GIFT] Gift diabaikan karena diamondCount tidak ditemukan:",
      {
        giftId,
        giftName
      }
    );

    return null;
  }

  const repeatCount = getRepeatCount(event);

  const giftType = getGiftType(event);

  const repeatEnd = getRepeatEnd(event);

  /*
    Gift streak:
      giftType = 1
      repeatEnd = false

    Event tersebut hanya update sementara.
    Jangan dihitung dulu.

    Event final akan datang dengan:
      repeatEnd = true
  */

  if (giftType === 1 && !repeatEnd) {
    console.log(
      `[GIFT] Streak sementara diabaikan: ${giftName} x${repeatCount}`
    );

    return null;
  }

  /*
    TOTAL COIN:

    1 gift = diamondCount
    x repeatCount untuk streak final

    TIDAK ADA x2.
  */

  const totalCoin =
    tikTokCoin * repeatCount;

  const msgId =
    event?.msgId ||
    event?.messageId ||
    event?.message_id ||
    "";

  const transactionId =
    event?.transactionId ||
    event?.transaction_id ||
    "";

  const groupId =
    event?.groupId ||
    event?.group_id ||
    event?.gift?.groupId ||
    event?.gift?.group_id ||
    "";

  const key = createGiftEventKey(
    event,
    user,
    repeatCount,
    repeatEnd
  );

  /*
    Duplicate protection.
  */

  if (processedGiftEvents.has(key)) {
    console.log(
      `[GIFT] Duplicate diabaikan: ${key}`
    );

    return null;
  }

  processedGiftEvents.set(key, Date.now());

  const result = {
    username: user.username,
    nickname: user.nickname,
    userId: user.userId,

    avatar: user.avatar,

    giftName: String(giftName),
    giftId: String(giftId),

    /*
      Nilai satu gift.
    */
    giftUnitCoins: tikTokCoin,

    diamondCount: tikTokCoin,

    /*
      Jumlah streak.
    */
    repeatCount,

    /*
      Total coin final.
    */
    coinValue: totalCoin,

    giftType,
    repeatEnd,

    msgId: String(msgId || ""),
    transactionId: String(transactionId || ""),
    groupId: String(groupId || "")
  };

  console.log(
    "[GIFT] VALID:",
    JSON.stringify(result)
  );

  return result;
}

/* =========================================================
   STOP CONNECTION
========================================================= */

async function stopConnection() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  manualDisconnect = true;

  const connection = liveConnection;

  liveConnection = null;

  connectedAt = null;

  currentRoomId = null;

  currentViewerCount = 0;

  if (!connection) {
    emitStatus(
      "Tidak ada koneksi TikTok yang aktif.",
      true
    );

    return;
  }

  try {
    if (
      typeof connection.disconnect === "function"
    ) {
      await connection.disconnect();
    }
  } catch (error) {
    console.warn(
      "[TIKTOK] Error saat disconnect:",
      formatError(error)
    );
  }

  emitStatus(
    "Koneksi TikTok diputus.",
    true
  );
}

/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect() {
  if (manualDisconnect) {
    return;
  }

  if (!activeUsername) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  console.log(
    `[TIKTOK] Reconnect dijadwalkan dalam 8 detik untuk @${activeUsername}`
  );

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    if (
      manualDisconnect ||
      !activeUsername
    ) {
      return;
    }

    try {
      await connectToLive(activeUsername);
    } catch (error) {
      console.error(
        "[TIKTOK] Reconnect gagal:",
        formatError(error)
      );

      scheduleReconnect();
    }
  }, 8000);
}

/* =========================================================
   CONNECT TO TIKTOK LIVE
========================================================= */

async function connectToLive(rawUsername) {
  const username = cleanUsername(rawUsername);

  if (!username) {
    throw new Error(
      "Username TikTok kosong."
    );
  }

  const Connector =
    await loadTikTokConnector();

  /*
    Putuskan koneksi lama terlebih dahulu.
  */

  if (liveConnection) {
    await stopConnection();
  }

  manualDisconnect = false;

  activeUsername = username;

  console.log(
    "================================================="
  );

  console.log(
    `[TIKTOK] Connecting to @${username}`
  );

  console.log(
    `[TIKTOK] Signing mode: ${signingMode}`
  );

  console.log(
    "================================================="
  );

  emitStatus(
    `Menghubungkan ke TikTok LIVE @${username}...`,
    false
  );

  /*
    Options kompatibel dengan connector 2.4.4.
  */

  const options = {
    processInitialData: false,

    /*
      Jika tidak LIVE, connect() akan reject.
      Ini lebih baik supaya status langsung jelas.
    */
    fetchRoomInfoOnConnect: true,

    /*
      Tidak perlu extended gift info.
      diamondCount tersedia pada event gift.
    */
    enableExtendedGiftInfo: false,

    webClientOptions: {
      timeout: {
        request: 20000
      }
    },

    wsClientOptions: {
      handshakeTimeout: 20000
    }
  };

  /*
    API key hanya digunakan jika tersedia.
  */

  if (
    signingMode === "api-key" &&
    SIGN_API_KEY
  ) {
    options.signApiKey = SIGN_API_KEY;
  }

  const connection =
    new Connector(
      username,
      options
    );

  /*
    Set connection sebelum connect
    supaya status dapat diketahui.
  */

  liveConnection = connection;

  /* =======================================================
     CONNECTED
  ======================================================= */

  connection.on(
    "connected",
    (state) => {
      /*
        Pastikan ini masih connection aktif.
      */
      if (liveConnection !== connection) {
        return;
      }

      connectedAt =
        new Date().toISOString();

      currentRoomId =
        state?.roomId ||
        connection?.roomId ||
        null;

      currentViewerCount =
        Number(
          state?.roomInfo?.user_count ||
          state?.roomInfo?.userCount ||
          0
        ) || 0;

      console.log(
        `[TIKTOK] CONNECTED @${username}`
      );

      console.log(
        `[TIKTOK] Room ID: ${currentRoomId || "-"}`
      );

      emitStatus(
        `Berhasil terhubung ke TikTok LIVE @${username}.`,
        true
      );

      io.emit(
        "live:connected",
        {
          username,
          roomId: currentRoomId,
          viewerCount: currentViewerCount,
          connectedAt
        }
      );
    }
  );

  /*
    Alias untuk compatibility dengan connector/versi lama.
  */
  connection.on(
    "connect",
    () => {
      if (liveConnection !== connection) {
        return;
      }

      console.log(
        `[TIKTOK] WebSocket connect event @${username}`
      );
    }
  );

  /* =======================================================
     GIFT
  ======================================================= */

  connection.on(
    "gift",
    (event) => {
      try {
        console.log(
          `[GIFT] Event diterima dari @${username}`
        );

        /*
          Jangan proses gift jika auction belum aktif.
        */

        if (!auctionActive) {
          console.log(
            "[GIFT] Diabaikan karena auction tidak aktif."
          );

          return;
        }

        const gift =
          parseGift(event);

        if (!gift) {
          return;
        }

        /*
          Kirim ke app.js.
        */

        io.emit(
          "live:gift",
          gift
        );

        /*
          Event umum.
        */

        io.emit(
          "live:event",
          {
            type: "gift",
            data: gift
          }
        );

        /*
          Alias tambahan.
        */

        io.emit(
          "gift",
          gift
        );
      } catch (error) {
        console.error(
          "[GIFT] Handler error:",
          error
        );
      }
    }
  );

  /* =======================================================
     CHAT
  ======================================================= */

  connection.on(
    "chat",
    (event) => {
      try {
        const user =
          getUserData(event);

        const data = {
          ...user,

          comment:
            event?.comment ||
            event?.message ||
            ""
        };

        io.emit(
          "live:event",
          {
            type: "chat",
            data
          }
        );

        io.emit(
          "live:chat",
          data
        );
      } catch (error) {
        console.error(
          "[CHAT] Handler error:",
          error
        );
      }
    }
  );

  /* =======================================================
     MEMBER / JOIN
  ======================================================= */

  connection.on(
    "member",
    (event) => {
      try {
        const user =
          getUserData(event);

        io.emit(
          "live:event",
          {
            type: "member",
            data: user
          }
        );

        io.emit(
          "live:member",
          user
        );
      } catch (error) {
        console.error(
          "[MEMBER] Handler error:",
          error
        );
      }
    }
  );

  /* =======================================================
     LIKE
  ======================================================= */

  connection.on(
    "like",
    (event) => {
      try {
        const user =
          getUserData(event);

        const likeCount =
          numberPositive(
            event?.likeCount,
            event?.like_count,
            event?.count
          );

        const totalLikes =
          numberPositive(
            event?.totalLikes,
            event?.total_likes
          );

        const data = {
          username: user.username,
          nickname: user.nickname,
          userId: user.userId,
          avatar: user.avatar,

          likeCount,
          totalLikes
        };

        io.emit(
          "live:event",
          {
            type: "like",
            data
          }
        );

        io.emit(
          "live:like",
          data
        );
      } catch (error) {
        console.error(
          "[LIKE] Handler error:",
          error
        );
      }
    }
  );

  /* =======================================================
     ROOM USER / VIEWER COUNT
  ======================================================= */

  connection.on(
    "roomUser",
    (event) => {
      try {
        const viewerCount =
          numberPositive(
            event?.viewerCount,
            event?.viewer_count,
            event?.userCount,
            event?.user_count
          );

        currentViewerCount =
          viewerCount;

        const data = {
          viewerCount:
            currentViewerCount
        };

        io.emit(
          "live:viewer",
          data
        );

        io.emit(
          "live:event",
          {
            type: "viewer",
            data
          }
        );
      } catch (error) {
        console.error(
          "[ROOM USER] Handler error:",
          error
        );
      }
    }
  );

  /* =======================================================
     STREAM END
  ======================================================= */

  connection.on(
    "streamEnd",
    (event) => {
      if (liveConnection !== connection) {
        return;
      }

      console.log(
        `[TIKTOK] LIVE @${username} telah berakhir.`
      );

      auctionActive = false;

      emitAuctionState();

      io.emit(
        "live:event",
        {
          type: "streamEnd",
          data: event || {}
        }
      );

      emitStatus(
        `TikTok LIVE @${username} telah berakhir.`,
        false
      );
    }
  );

  /* =======================================================
     DISCONNECTED
  ======================================================= */

  connection.on(
    "disconnected",
    (event) => {
      /*
        Jangan biarkan koneksi lama
        memengaruhi koneksi baru.
      */

      if (liveConnection !== connection) {
        return;
      }

      console.warn(
        "[TIKTOK] Disconnected:",
        event || ""
      );

      liveConnection = null;

      connectedAt = null;

      currentRoomId = null;

      currentViewerCount = 0;

      io.emit(
        "live:disconnected",
        {
          username,
          reason:
            event?.reason ||
            "",
          code:
            event?.code ||
            null
        }
      );

      emitStatus(
        `Koneksi TikTok @${username} terputus.`,
        false
      );

      /*
        Jangan reconnect jika user sengaja disconnect.
      */

      if (!manualDisconnect) {
        scheduleReconnect();
      }
    }
  );

  /* =======================================================
     ERROR
  ======================================================= */

  connection.on(
    "error",
    (error) => {
      console.error(
        "[TIKTOK] Connection error:",
        formatError(error)
      );

      io.emit(
        "live:error",
        {
          message:
            formatError(error),
          username
        }
      );
    }
  );

  /* =======================================================
     ACTUAL CONNECT
  ======================================================= */

  try {
    const state =
      await connection.connect();

    /*
      Beberapa versi/event flow bisa menyelesaikan
      connect() sebelum event connected diproses.
      Pastikan state tetap disimpan.
    */

    if (liveConnection === connection) {
      currentRoomId =
        state?.roomId ||
        connection?.roomId ||
        currentRoomId;

      if (!connectedAt) {
        connectedAt =
          new Date().toISOString();
      }

      emitStatus(
        `Berhasil terhubung ke TikTok LIVE @${username}.`,
        true
      );

      io.emit(
        "live:connected",
        {
          username,
          roomId: currentRoomId,
          viewerCount: currentViewerCount,
          connectedAt
        }
      );
    }

    return state;
  } catch (error) {
    /*
      Jangan biarkan connection gagal
      menggantung sebagai connection aktif.
    */

    if (liveConnection === connection) {
      liveConnection = null;
    }

    connectedAt = null;

    currentRoomId = null;

    currentViewerCount = 0;

    const friendlyError =
      formatError(error);

    console.error(
      `[TIKTOK] Gagal connect @${username}:`,
      friendlyError
    );

    emitStatus(
      friendlyError,
      false,
      {
        error: friendlyError
      }
    );

    io.emit(
      "live:error",
      {
        username,
        message: friendlyError
      }
    );

    /*
      Jangan langsung reconnect berkali-kali
      jika username memang offline.
    */

    if (!manualDisconnect) {
      scheduleReconnect();
    }

    throw error;
  }
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  "connection",
  (socket) => {
    console.log(
      `[SOCKET] Client connected: ${socket.id}`
    );

    /*
      Kirim status saat browser pertama kali connect.
    */

    socket.emit(
      "live:status",
      {
        ok: Boolean(liveConnection),
        message: liveConnection
          ? `Terhubung ke @${activeUsername}`
          : "Belum terhubung ke TikTok LIVE.",
        username:
          activeUsername || null,
        connected:
          Boolean(liveConnection),
        connectedAt,
        roomId:
          currentRoomId || null,
        viewerCount:
          currentViewerCount || 0,
        signingMode
      }
    );

    socket.emit(
      "auction:state",
      {
        active: auctionActive
      }
    );

    /* =====================================================
       CONNECT LIVE
    ===================================================== */

    socket.on(
      "live:connect",
      async (payload) => {
        try {
          let username = "";

          if (typeof payload === "string") {
            username = payload;
          } else if (
            payload &&
            typeof payload === "object"
          ) {
            username =
              payload.username ||
              payload.uniqueId ||
              payload.unique_id ||
              payload.user ||
              payload.tiktokUsername ||
              "";
          }

          username =
            cleanUsername(username);

          if (!username) {
            socket.emit(
              "live:error",
              {
                message:
                  "Masukkan username TikTok."
              }
            );

            return;
          }

          await connectToLive(username);
        } catch (error) {
          socket.emit(
            "live:error",
            {
              message:
                formatError(error)
            }
          );
        }
      }
    );

    /*
      Alias.
    */

    socket.on(
      "connectTikTok",
      async (payload) => {
        try {
          let username =
            typeof payload === "string"
              ? payload
              : payload?.username ||
                payload?.uniqueId ||
                payload?.user ||
                "";

          username =
            cleanUsername(username);

          if (!username) {
            throw new Error(
              "Username TikTok kosong."
            );
          }

          await connectToLive(username);
        } catch (error) {
          socket.emit(
            "live:error",
            {
              message:
                formatError(error)
            }
          );
        }
      }
    );

    /* =====================================================
       DISCONNECT LIVE
    ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {
        try {
          await stopConnection();

          /*
            Username tetap disimpan supaya
            bisa reconnect manual jika user connect lagi.
          */

          socket.emit(
            "live:status",
            {
              ok: true,
              message:
                "Koneksi TikTok diputus.",
              username:
                activeUsername || null,
              connected: false
            }
          );
        } catch (error) {
          socket.emit(
            "live:error",
            {
              message:
                formatError(error)
            }
          );
        }
      }
    );

    /*
      Alias.
    */

    socket.on(
      "disconnectTikTok",
      async () => {
        await stopConnection();
      }
    );

    /* =====================================================
       AUCTION STATE
    ===================================================== */

    socket.on(
      "auction:state",
      (payload) => {
        let active;

        if (
          typeof payload === "boolean"
        ) {
          active = payload;
        } else if (
          payload &&
          typeof payload === "object"
        ) {
          active =
            payload.active ??
            payload.running ??
            payload.enabled;
        }

        if (
          typeof active !== "boolean"
        ) {
          return;
        }

        auctionActive = active;

        console.log(
          `[AUCTION] Active = ${auctionActive}`
        );

        emitAuctionState();
      }
    );

    /* =====================================================
       AUCTION START
    ===================================================== */

    socket.on(
      "auction:start",
      () => {
        auctionActive = true;

        console.log(
          "[AUCTION] START"
        );

        emitAuctionState();
      }
    );

    /* =====================================================
       AUCTION STOP
    ===================================================== */

    socket.on(
      "auction:stop",
      () => {
        auctionActive = false;

        console.log(
          "[AUCTION] STOP"
        );

        emitAuctionState();
      }
    );

    /*
      Alias untuk compatibility.
    */

    socket.on(
      "setAuctionActive",
      (value) => {
        if (
          typeof value === "boolean"
        ) {
          auctionActive = value;
        } else if (
          value &&
          typeof value === "object"
        ) {
          auctionActive =
            Boolean(
              value.active
            );
        } else {
          return;
        }

        emitAuctionState();
      }
    );

    /* =====================================================
       SOCKET DISCONNECT
    ===================================================== */

    socket.on(
      "disconnect",
      (reason) => {
        console.log(
          `[SOCKET] Client disconnected: ${socket.id} - ${reason}`
        );
      }
    );
  }
);

/* =========================================================
   HTTP API
========================================================= */

/*
  Health check Railway.
*/

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      ok: true,
      service:
        "tiktok-live-coin-auction",
      timestamp:
        new Date().toISOString(),
      node:
        process.version,
      tiktokConnector:
        TikTokLiveConnection
          ? "loaded"
          : "not-loaded",
      connected:
        Boolean(liveConnection),
      username:
        activeUsername || null,
      auctionActive,
      viewerCount:
        currentViewerCount,
      signingMode
    });
  }
);

/*
  Status.
*/

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,
      connected:
        Boolean(liveConnection),
      username:
        activeUsername || null,
      roomId:
        currentRoomId || null,
      connectedAt,
      viewerCount:
        currentViewerCount,
      auctionActive,
      signingMode
    });
  }
);

/*
  Connect API.

  POST /api/connect
  {
    "username": "username"
  }
*/

app.post(
  "/api/connect",
  async (req, res) => {
    try {
      let username =
        req.body?.username ||
        req.body?.uniqueId ||
        req.body?.unique_id ||
        req.body?.user ||
        req.query?.username ||
        "";

      username =
        cleanUsername(username);

      if (!username) {
        return res.status(400).json({
          ok: false,
          message:
            "Username TikTok wajib diisi."
        });
      }

      await connectToLive(username);

      return res.json({
        ok: true,
        message:
          `Menghubungkan ke @${username}`,
        username
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          formatError(error)
      });
    }
  }
);

/*
  Disconnect API.
*/

app.post(
  "/api/disconnect",
  async (req, res) => {
    try {
      await stopConnection();

      return res.json({
        ok: true,
        message:
          "Koneksi TikTok diputus."
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          formatError(error)
      });
    }
  }
);

/*
  Auction API.

  POST /api/auction
  {
    "active": true
  }
*/

app.post(
  "/api/auction",
  (req, res) => {
    const value =
      req.body?.active ??
      req.body?.running ??
      req.body?.enabled;

    if (
      typeof value !== "boolean"
    ) {
      return res.status(400).json({
        ok: false,
        message:
          "Field active harus true atau false."
      });
    }

    auctionActive = value;

    emitAuctionState();

    return res.json({
      ok: true,
      auctionActive
    });
  }
);

/* =========================================================
   ROOT FALLBACK
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      require("path").join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================================================
   SERVER
========================================================= */

const PORT =
  Number(process.env.PORT) || 3000;

const HOST =
  process.env.HOST || "0.0.0.0";

server.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "================================================="
    );
    console.log(
      " TIKTOK LIVE COIN AUCTION SERVER"
    );
    console.log(
      "================================================="
    );
    console.log(
      ` Server : http://${HOST}:${PORT}`
    );
    console.log(
      ` Port   : ${PORT}`
    );
    console.log(
      ` Node   : ${process.version}`
    );
    console.log(
      ` Signing: ${signingMode}`
    );
    console.log(
      " Connector: tiktok-live-connector 2.4.4"
    );
    console.log(
      "================================================="
    );
    console.log("");
  }
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(signal) {
  console.log(
    `\n[SERVER] ${signal} diterima. Shutdown...`
  );

  manualDisconnect = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (liveConnection) {
      const connection =
        liveConnection;

      liveConnection = null;

      if (
        typeof connection.disconnect ===
        "function"
      ) {
        await connection.disconnect();
      }
    }
  } catch (error) {
    console.warn(
      "[SERVER] Disconnect error:",
      formatError(error)
    );
  }

  server.close(() => {
    console.log(
      "[SERVER] Server stopped."
    );

    process.exit(0);
  });

  /*
    Fallback supaya Railway tidak menggantung.
  */

  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);

/* =========================================================
   UNHANDLED ERROR PROTECTION
========================================================= */

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "[PROCESS] Unhandled Rejection:",
      error
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
