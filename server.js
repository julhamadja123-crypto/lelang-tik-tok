"use strict";

/* =========================================================
   COIN AUCTION SERVER
   SERVER.JS - FINAL
   =========================================================

   FITUR:
   - Express
   - Socket.IO
   - TikTok LIVE Connector
   - Username TikTok
   - Public mode tanpa API key
   - Optional API key
   - Auto reconnect
   - Gift coin 1:1 berdasarkan diamondCount
   - Streak gift hanya dihitung pada repeatEnd
   - Duplicate protection
   - Avatar TikTok
   - Auction state
   - Compatible dengan app.js V5
   ========================================================= */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/* =========================================================
   EXPRESS SERVER
   ========================================================= */

const app = express();

const server =
  http.createServer(app);

const io =
  new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(__dirname)
);

/* =========================================================
   PORT
   ========================================================= */

const PORT =
  Number(
    process.env.PORT
  ) || 8080;

/* =========================================================
   GLOBAL STATE
   ========================================================= */

let TikTokLiveConnection =
  null;

let liveConnection =
  null;

let activeUsername =
  null;

let reconnectTimer =
  null;

let manualDisconnect =
  false;

let liveConnected =
  false;

let auctionActive =
  false;

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionState = {
  active: false,
  running: false,

  duration: 300,
  remaining: 300,

  extraTime: 30,
  extraRemaining: 0,
  extraActive: false,

  drawDuration: 20,
  drawRemaining: 20,
  inDraw: false,

  finished: false
};

/* =========================================================
   SIGNING MODE
   ========================================================= */

const SIGN_API_KEY =
  String(
    process.env.SIGN_API_KEY || ""
  ).trim();

const USE_SIGN_API_KEY =
  String(
    process.env.USE_SIGN_API_KEY || ""
  )
    .trim()
    .toLowerCase() === "true";

const signingMode =
  USE_SIGN_API_KEY &&
  SIGN_API_KEY
    ? "api-key"
    : "public";

/* =========================================================
   GIFT DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents =
  new Map();

const GIFT_TTL =
  60 * 1000;

/* =========================================================
   STARTUP LOG
   ========================================================= */

console.log(
  "================================================"
);

console.log(
  "COIN AUCTION SERVER"
);

console.log(
  "Signing mode:",
  signingMode
);

console.log(
  "Port:",
  PORT
);

console.log(
  "================================================"
);

/* =========================================================
   CONNECTOR LOADER
   ========================================================= */

async function loadTikTokConnector() {

  if (
    TikTokLiveConnection
  ) {
    return TikTokLiveConnection;
  }

  let mod;

  try {

    mod =
      await import(
        "tiktok-live-connector"
      );

  } catch (err) {

    console.error(
      "[TikTok] Gagal memuat package:"
    );

    console.error(
      err
    );

    throw new Error(
      "Package tiktok-live-connector tidak ditemukan. Pastikan package sudah ada di package.json."
    );
  }

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (
    typeof TikTokLiveConnection !==
    "function"
  ) {

    console.error(
      "[TikTok] Isi module:",
      Object.keys(mod || {})
    );

    throw new Error(
      "TikTokLiveConnection tidak ditemukan pada package tiktok-live-connector."
    );
  }

  return TikTokLiveConnection;
}

/* =========================================================
   CLEAN USERNAME
   ========================================================= */

function cleanUsername(value) {

  let username =
    String(
      value || ""
    ).trim();

  if (!username) {
    return "";
  }

  username =
    username.replace(
      /^https?:\/\/(www\.)?tiktok\.com\/@/i,
      ""
    );

  username =
    username.replace(
      /^https?:\/\/(www\.)?tiktok\.com\//i,
      ""
    );

  username =
    username.replace(
      /^@/,
      ""
    );

  username =
    username.replace(
      /\/live.*$/i,
      ""
    );

  username =
    username.replace(
      /[/?#].*$/g,
      ""
    );

  username =
    username.replace(
      /\s+/g,
      ""
    );

  return username;
}

/* =========================================================
   STATUS EMITTER
   ========================================================= */

function emitStatus(
  message,
  ok = false
) {

  console.log(
    `[STATUS] ${message}`
  );

  io.emit(
    "live:status",
    {
      ok,

      message,

      username:
        activeUsername ||
        null,

      connected:
        liveConnected,

      active:
        liveConnected
    }
  );
}

/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {

  if (!err) {
    return "Unknown error.";
  }

  const message =
    err?.message ||
    String(err);

  const lower =
    message.toLowerCase();

  if (
    lower.includes(
      "empty payload"
    )
  ) {

    return (
      "TikTok signing server mengembalikan Empty Payload. Server akan mencoba ulang otomatis."
    );
  }

  if (
    lower.includes("offline") ||
    lower.includes("not live") ||
    lower.includes("useroffline")
  ) {

    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {

    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik kemudian."
    );
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {

    return (
      "TikTok/signing server sedang membatasi request. Tunggu beberapa saat."
    );
  }

  if (
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("euler") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {

    return (
      "Signing provider menolak request. Periksa API key jika mode API key digunakan."
    );
  }

  if (
    lower.includes("404")
  ) {

    return (
      "Endpoint TikTok/signing tidak ditemukan. Pastikan versi package tiktok-live-connector sesuai."
    );
  }

  return message;
}

/* =========================================================
   NUMBER
   ========================================================= */

function numberPositive(
  ...values
) {

  for (
    const value of values
  ) {

    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const number =
      Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return 0;
}

/* =========================================================
   USER DATA
   ========================================================= */

function getUserData(event) {

  const user =
    event?.user || {};

  const userDetails =
    event?.userDetails ||
    user?.userDetails ||
    {};

  let avatar =
    user.profilePictureUrl ||
    user.profilePicture?.url ||
    user.profilePicture?.urls?.[0] ||
    userDetails.profilePictureUrl ||
    userDetails.profilePictureUrls?.[0] ||
    event?.profilePictureUrl ||
    event?.profilePicture ||
    null;

  if (
    !avatar &&
    Array.isArray(
      user.profilePictureUrls
    )
  ) {

    avatar =
      user.profilePictureUrls[0] ||
      null;
  }

  if (
    !avatar &&
    Array.isArray(
      event?.userDetails
        ?.profilePictureUrls
    )
  ) {

    avatar =
      event
        .userDetails
        .profilePictureUrls[0] ||
      null;
  }

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
      event?.unique_id ||
      event?.nickname ||
      "Viewer",

    nickname:
      user.nickname ||
      event?.nickname ||
      user.uniqueId ||
      event?.uniqueId ||
      "Viewer",

    avatar
  };
}

/* =========================================================
   TIKTOK DIAMOND COUNT
   ========================================================= */

function getTikTokCoinValue(
  event
) {

  const diamondCount =
    numberPositive(

      event?.diamondCount,

      event?.diamond_count,

      event?.gift?.diamondCount,

      event?.gift?.diamond_count,

      event?.giftDetails
        ?.diamondCount,

      event?.giftDetails
        ?.diamond_count,

      event?.extendedGiftInfo
        ?.diamondCount,

      event?.extendedGiftInfo
        ?.diamond_count
    );

  if (
    diamondCount > 0
  ) {
    return Math.floor(
      diamondCount
    );
  }

  return 0;
}

/* =========================================================
   REPEAT COUNT
   ========================================================= */

function getRepeatCount(
  event
) {

  const repeatCount =
    numberPositive(

      event?.repeatCount,

      event?.repeat_count,

      event?.gift?.repeatCount,

      event?.gift?.repeat_count,

      event?.giftDetails
        ?.repeatCount,

      event?.giftDetails
        ?.repeat_count
    );

  if (
    repeatCount <= 0
  ) {
    return 1;
  }

  return Math.max(
    1,
    Math.floor(
      repeatCount
    )
  );
}

/* =========================================================
   GIFT TYPE
   ========================================================= */

function getGiftType(
  event
) {

  const value =
    event?.giftType ??
    event?.gift_type ??
    event?.gift?.giftType ??
    event?.gift?.gift_type ??
    event?.giftDetails?.giftType ??
    event?.giftDetails?.gift_type ??
    0;

  const result =
    Number(value);

  return Number.isFinite(
    result
  )
    ? result
    : 0;
}

/* =========================================================
   REPEAT END
   ========================================================= */

function getRepeatEnd(
  event
) {

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
   CLEAN DUPLICATES
   ========================================================= */

function cleanupGiftEvents() {

  const now =
    Date.now();

  for (
    const [
      key,
      time
    ]
    of processedGiftEvents
  ) {

    if (
      now - time >
      GIFT_TTL
    ) {

      processedGiftEvents.delete(
        key
      );
    }
  }
}

/* =========================================================
   GIFT EVENT KEY
   ========================================================= */

function createGiftEventKey(
  event,
  user,
  repeatCount,
  repeatEnd
) {

  const stableId =
    event?.msgId ||
    event?.msg_id ||
    event?.transactionId ||
    event?.transaction_id ||
    event?.messageId ||
    event?.message_id;

  if (
    stableId
  ) {

    return String(
      stableId
    );
  }

  return [

    event?.groupId ||
      event?.group_id ||
      "",

    user.userId ||
      "",

    event?.giftId ||
      event?.gift_id ||
      event?.gift?.giftId ||
      event?.gift?.gift_id ||
      "",

    repeatCount,

    event?.createTime ||
      event?.create_time ||
      event?.timestamp ||
      "",

    repeatEnd
      ? "END"
      : "LIVE"

  ].join("|");
}

/* =========================================================
   PARSE GIFT
   ========================================================= */

function parseGift(
  event
) {

  if (!event) {
    return null;
  }

  const user =
    getUserData(event);

  const giftId =
    String(

      event.giftId ??
      event.gift_id ??
      event.gift?.giftId ??
      event.gift?.gift_id ??
      event.giftDetails?.giftId ??
      event.giftDetails?.gift_id ??
      ""

    );

  const giftName =
    event.giftName ||
    event.gift_name ||
    event.gift?.giftName ||
    event.gift?.name ||
    event.giftDetails?.giftName ||
    event.giftDetails?.name ||
    "Gift";

  const diamondCount =
    getTikTokCoinValue(
      event
    );

  if (
    diamondCount <= 0
  ) {

    console.warn(
      "[Gift] diamondCount tidak ditemukan."
    );

    console.warn(
      "[Gift] Gift diabaikan."
    );

    console.log(
      "[Gift] Nama:",
      giftName
    );

    console.log(
      "[Gift] ID:",
      giftId
    );

    return null;
  }

  const repeatCount =
    getRepeatCount(
      event
    );

  const giftType =
    getGiftType(
      event
    );

  const repeatEnd =
    getRepeatEnd(
      event
    );

  /* =======================================================
     STREAK
     ======================================================= */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {

    console.log(
      `[Gift] Streak sementara @${user.uniqueId}: ${repeatCount}x`
    );

    return null;
  }

  /* =======================================================
     FINAL TOTAL
     =======================================================

     Contoh:

     Rose = 1 diamond
     repeatCount = 10

     TOTAL = 1 × 10 = 10 coin

     BUKAN:
     10 × 2
     10 × 10
     atau perkalian lainnya.
     ======================================================= */

  const totalCoin =
    Math.floor(
      diamondCount *
      repeatCount
    );

  cleanupGiftEvents();

  const eventKey =
    createGiftEventKey(
      event,
      user,
      repeatCount,
      repeatEnd
    );

  if (
    processedGiftEvents.has(
      eventKey
    )
  ) {

    console.log(
      `[Gift] Duplicate diabaikan: ${eventKey}`
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    Date.now()
  );

  console.log(
    "================================================"
  );

  console.log(
    "[GIFT FINAL]"
  );

  console.log(
    `User         : @${user.uniqueId}`
  );

  console.log(
    `Gift         : ${giftName}`
  );

  console.log(
    `Gift ID      : ${giftId || "-"}`
  );

  console.log(
    `diamondCount : ${diamondCount}`
  );

  console.log(
    `repeatCount  : ${repeatCount}`
  );

  console.log(
    `giftType     : ${giftType}`
  );

  console.log(
    `repeatEnd    : ${repeatEnd}`
  );

  console.log(
    `TOTAL COIN   : ${totalCoin}`
  );

  console.log(
    "================================================"
  );

  return {

    username:
      user.uniqueId,

    nickname:
      user.nickname,

    userId:
      user.userId,

    avatar:
      user.avatar,

    giftName,

    giftId,

    giftUnitCoins:
      diamondCount,

    diamondCount,

    repeatCount,

    coins:
      totalCoin,

    coinValue:
      totalCoin,

    giftType,

    repeatEnd,

    msgId:
      event.msgId ||
      event.msg_id ||
      null,

    transactionId:
      event.transactionId ||
      event.transaction_id ||
      null,

    groupId:
      event.groupId ||
      event.group_id ||
      null
  };
}

/* =========================================================
   STOP CONNECTION
   ========================================================= */

async function stopConnection() {

  if (
    reconnectTimer
  ) {

    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      null;
  }

  manualDisconnect =
    true;

  liveConnected =
    false;

  const connection =
    liveConnection;

  liveConnection =
    null;

  if (!connection) {

    io.emit(
      "live:status",
      {
        ok: false,

        message:
          "Tidak terhubung ke TikTok.",

        username:
          activeUsername ||
          null,

        connected: false,

        active: false
      }
    );

    return;
  }

  try {

    if (
      typeof connection.disconnect ===
      "function"
    ) {

      await connection.disconnect();
    }

  } catch (err) {

    console.warn(
      "[TikTok] disconnect error:",
      err?.message ||
      err
    );
  }

  io.emit(
    "live:status",
    {
      ok: false,

      message:
        "Koneksi TikTok dihentikan.",

      username:
        activeUsername ||
        null,

      connected: false,

      active: false
    }
  );
}

/* =========================================================
   SCHEDULE RECONNECT
   ========================================================= */

function scheduleReconnect() {

  if (
    manualDisconnect ||
    !activeUsername
  ) {
    return;
  }

  if (
    reconnectTimer
  ) {
    return;
  }

  const username =
    activeUsername;

  console.log(
    `[TikTok] Reconnect @${username} dalam 8 detik...`
  );

  emitStatus(
    `Koneksi @${username} terputus. Mencoba ulang dalam 8 detik...`,
    false
  );

  reconnectTimer =
    setTimeout(
      async () => {

        reconnectTimer =
          null;

        if (
          manualDisconnect ||
          !activeUsername
        ) {
          return;
        }

        try {

          await connectToLive(
            username
          );

        } catch (err) {

          console.error(
            "[TikTok] Reconnect gagal:",
            formatError(err)
          );

          scheduleReconnect();
        }

      },
      8000
    );
}

/* =========================================================
   BROADCAST AUCTION STATE
   ========================================================= */

function broadcastAuctionState() {

  io.emit(
    "auction:state",
    {
      ...auctionState
    }
  );
}

/* =========================================================
   UPDATE AUCTION STATE
   ========================================================= */

function updateAuctionState(
  data = {}
) {

  if (
    typeof data.active ===
    "boolean"
  ) {

    auctionActive =
      data.active;

    auctionState.active =
      data.active;
  }

  if (
    typeof data.running ===
    "boolean"
  ) {

    auctionState.running =
      data.running;
  }

  if (
    Number.isFinite(
      Number(data.duration)
    ) &&
    Number(data.duration) >= 0
  ) {

    auctionState.duration =
      Math.floor(
        Number(data.duration)
      );
  }

  if (
    Number.isFinite(
      Number(data.remaining)
    ) &&
    Number(data.remaining) >= 0
  ) {

    auctionState.remaining =
      Math.floor(
        Number(data.remaining)
      );
  }

  if (
    Number.isFinite(
      Number(data.extraTime)
    ) &&
    Number(data.extraTime) >= 0
  ) {

    auctionState.extraTime =
      Math.floor(
        Number(data.extraTime)
      );
  }

  if (
    Number.isFinite(
      Number(data.extraRemaining)
    ) &&
    Number(data.extraRemaining) >= 0
  ) {

    auctionState.extraRemaining =
      Math.floor(
        Number(data.extraRemaining)
      );
  }

  if (
    typeof data.extraActive ===
    "boolean"
  ) {

    auctionState.extraActive =
      data.extraActive;
  }

  if (
    Number.isFinite(
      Number(data.drawDuration)
    ) &&
    Number(data.drawDuration) >= 0
  ) {

    auctionState.drawDuration =
      Math.floor(
        Number(data.drawDuration)
      );
  }

  if (
    Number.isFinite(
      Number(data.drawRemaining)
    ) &&
    Number(data.drawRemaining) >= 0
  ) {

    auctionState.drawRemaining =
      Math.floor(
        Number(data.drawRemaining)
      );
  }

  if (
    typeof data.inDraw ===
    "boolean"
  ) {

    auctionState.inDraw =
      data.inDraw;
  }

  if (
    typeof data.finished ===
    "boolean"
  ) {

    auctionState.finished =
      data.finished;
  }

  broadcastAuctionState();
}

/* =========================================================
   CONNECT TO TIKTOK LIVE
   ========================================================= */

async function connectToLive(
  rawUsername
) {

  const Connector =
    await loadTikTokConnector();

  const username =
    cleanUsername(
      rawUsername
    );

  if (!username) {

    throw new Error(
      "Username TikTok kosong."
    );
  }

  /*
   * Hentikan koneksi sebelumnya.
   */

  await stopConnection();

  manualDisconnect =
    false;

  activeUsername =
    username;

  liveConnected =
    false;

  console.log(
    "================================================"
  );

  console.log(
    `[TikTok] Mencoba koneksi @${username}`
  );

  console.log(
    `[TikTok] Signing mode: ${signingMode}`
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`,
    false
  );

  const options = {

    processInitialData:
      false,

    fetchRoomInfoOnConnect:
      false,

    enableExtendedGiftInfo:
      false,

    webClientOptions: {

      timeout: {
        request: 20000
      }

    },

    wsClientOptions: {

      handshakeTimeout:
        20000

    }

  };

  /*
   * API key hanya digunakan jika
   * environment variable diaktifkan.
   */

  if (
    signingMode ===
    "api-key"
  ) {

    options.signApiKey =
      SIGN_API_KEY;
  }

  let connection;

  try {

    connection =
      new Connector(
        username,
        options
      );

  } catch (err) {

    console.error(
      "[TikTok] Constructor error:",
      err
    );

    throw err;
  }

  liveConnection =
    connection;

  /* =====================================================
     CONNECTED
     ===================================================== */

  connection.on(
    "connected",
    () => {

      liveConnected =
        true;

      console.log(
        `[TikTok] BERHASIL TERHUBUNG @${username}`
      );

      emitStatus(
        `Terhubung ke LIVE @${username}`,
        true
      );

      io.emit(
        "live:connected",
        {
          username,
          connected: true,
          active: true
        }
      );

    }
  );

  /* =====================================================
     DISCONNECTED
     ===================================================== */

  connection.on(
    "disconnected",
    () => {

      liveConnected =
        false;

      liveConnection =
        null;

      console.warn(
        `[TikTok] @${username} disconnected.`
      );

      emitStatus(
        `Koneksi @${username} terputus.`,
        false
      );

      io.emit(
        "live:disconnected",
        {
          username,
          connected: false,
          active: false
        }
      );

      scheduleReconnect();
    }
  );

  /* =====================================================
     ERROR
     ===================================================== */

  connection.on(
    "error",
    (err) => {

      console.error(
        "[TikTok] ERROR:",
        formatError(err)
      );

      emitStatus(
        formatError(err),
        false
      );
    }
  );

  /* =====================================================
     STREAM END
     ===================================================== */

  connection.on(
    "streamEnd",
    (event) => {

      console.log(
        `[TikTok] LIVE @${username} berakhir.`
      );

      liveConnected =
        false;

      liveConnection =
        null;

      emitStatus(
        `LIVE @${username} telah berakhir.`,
        false
      );

      io.emit(
        "live:streamEnd",
        {
          username,
          data: event || {}
        }
      );

      scheduleReconnect();
    }
  );

  /* =====================================================
     GIFT
     ===================================================== */

  connection.on(
    "gift",
    (event) => {

      console.log(
        "[TikTok] Gift event diterima."
      );

      /*
       * Hanya gift ketika auction aktif.
       */

      if (
        !auctionActive
      ) {

        console.log(
          "[Gift] Diabaikan karena auction belum aktif."
        );

        return;
      }

      const gift =
        parseGift(
          event
        );

      if (!gift) {
        return;
      }

      /*
       * Event utama untuk app.js
       */

      io.emit(
        "live:gift",
        gift
      );

      /*
       * Alias event.
       */

      io.emit(
        "gift",
        gift
      );

      io.emit(
        "tiktok:gift",
        gift
      );

      io.emit(
        "gift:event",
        gift
      );

      /*
       * Event umum.
       */

      io.emit(
        "live:event",
        {
          type: "gift",
          data: gift
        }
      );
    }
  );

  /* =====================================================
     CHAT
     ===================================================== */

  connection.on(
    "chat",
    (event) => {

      const user =
        getUserData(
          event
        );

      const data = {

        type: "chat",

        username:
          user.uniqueId,

        nickname:
          user.nickname,

        userId:
          user.userId,

        avatar:
          user.avatar,

        comment:
          event?.comment ||
          event?.message ||
          ""
      };

      io.emit(
        "live:event",
        data
      );

      io.emit(
        "chat",
        data
      );
    }
  );

  /* =====================================================
     MEMBER
     ===================================================== */

  connection.on(
    "member",
    (event) => {

      const user =
        getUserData(
          event
        );

      const data = {

        type: "member",

        username:
          user.uniqueId,

        nickname:
          user.nickname,

        userId:
          user.userId,

        avatar:
          user.avatar
      };

      io.emit(
        "live:event",
        data
      );

      io.emit(
        "member",
        data
      );
    }
  );

  /* =====================================================
     LIKE
     ===================================================== */

  connection.on(
    "like",
    (event) => {

      const user =
        getUserData(
          event
        );

      const data = {

        type: "like",

        username:
          user.uniqueId,

        nickname:
          user.nickname,

        userId:
          user.userId,

        avatar:
          user.avatar,

        likeCount:
          Number(
            event?.likeCount ||
            event?.like_count ||
            0
          ) || 0,

        totalLikes:
          Number(
            event?.totalLikes ||
            event?.total_likes ||
            0
          ) || 0
      };

      io.emit(
        "live:event",
        data
      );

      io.emit(
        "like",
        data
      );
    }
  );

  /* =====================================================
     ROOM USER
     ===================================================== */

  connection.on(
    "roomUser",
    (event) => {

      const viewerCount =
        Number(
          event?.viewerCount ||
          event?.viewer_count ||
          0
        ) || 0;

      io.emit(
        "live:event",
        {
          type:
            "roomUser",

          viewerCount
        }
      );

      io.emit(
        "live:viewers",
        {
          viewerCount
        }
      );
    }
  );

  /* =====================================================
     CONNECT
     ===================================================== */

  try {

    await connection.connect();

    /*
     * Beberapa versi connector tidak selalu
     * mengirim event connected dengan cara
     * yang sama. Setelah connect() berhasil,
     * kita pastikan status menjadi connected.
     */

    liveConnected =
      true;

    liveConnection =
      connection;

    emitStatus(
      `Terhubung ke LIVE @${username}`,
      true
    );

    io.emit(
      "live:connected",
      {
        username,
        connected: true,
        active: true
      }
    );

    return {
      ok: true,
      username
    };

  } catch (err) {

    liveConnected =
      false;

    if (
      liveConnection ===
      connection
    ) {

      liveConnection =
        null;
    }

    const message =
      formatError(
        err
      );

    console.error(
      `[TikTok] Gagal connect @${username}:`,
      message
    );

    emitStatus(
      message,
      false
    );

    /*
     * Jangan reconnect langsung
     * jika user baru saja menekan connect.
     */

    throw err;
  }
}

/* =========================================================
   HTTP ROUTES
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
   HEALTH CHECK
   ========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.json(
      {
        ok: true,

        server:
          "coin-auction",

        uptime:
          process.uptime(),

        port:
          PORT,

        tikTokConnected:
          liveConnected,

        username:
          activeUsername,

        auctionActive
      }
    );
  }
);

/* =========================================================
   STATUS API
   ========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json(
      {
        ok: true,

        connected:
          liveConnected,

        active:
          liveConnected,

        username:
          activeUsername,

        signingMode,

        auctionActive,

        auction:
          auctionState
      }
    );
  }
);

/* =========================================================
   CONNECT API
   ========================================================= */

app.post(
  "/api/connect",
  async (req, res) => {

    const username =
      cleanUsername(
        req.body?.username ||
        req.body?.uniqueId ||
        req.body?.user ||
        req.body?.tiktok ||
        ""
      );

    if (!username) {

      return res
        .status(400)
        .json(
          {
            ok: false,
            message:
              "Username TikTok wajib diisi."
          }
        );
    }

    try {

      const result =
        await connectToLive(
          username
        );

      return res.json(
        {
          ok: true,

          message:
            `Berhasil terhubung ke @${username}`,

          ...result
        }
      );

    } catch (err) {

      return res
        .status(500)
        .json(
          {
            ok: false,

            message:
              formatError(
                err
              )
          }
        );
    }
  }
);

/* =========================================================
   DISCONNECT API
   ========================================================= */

app.post(
  "/api/disconnect",
  async (req, res) => {

    await stopConnection();

    return res.json(
      {
        ok: true,

        message:
          "Koneksi TikTok dihentikan."
      }
    );
  }
);

/* =========================================================
   AUCTION API
   ========================================================= */

app.post(
  "/api/auction/state",
  (req, res) => {

    updateAuctionState(
      req.body || {}
    );

    return res.json(
      {
        ok: true,

        auction:
          auctionState
      }
    );
  }
);

/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on(
  "connection",
  (socket) => {

    console.log(
      `[Socket] Client connected: ${socket.id}`
    );

    /* =====================================================
       SEND CURRENT STATUS
       ===================================================== */

    socket.emit(
      "live:status",
      {
        ok:
          liveConnected,

        message:
          liveConnected
            ? `Terhubung ke @${activeUsername}`
            : "Belum terhubung ke TikTok.",

        username:
          activeUsername ||
          null,

        connected:
          liveConnected,

        active:
          liveConnected
      }
    );

    /* =====================================================
       SEND AUCTION STATE
       ===================================================== */

    socket.emit(
      "auction:state",
      {
        ...auctionState
      }
    );

    /* =====================================================
       CONNECT USERNAME
       ===================================================== */

    const connectHandler =
      async (data) => {

        let username;

        if (
          typeof data ===
          "string"
        ) {

          username =
            cleanUsername(
              data
            );

        } else {

          username =
            cleanUsername(
              data?.username ||
              data?.uniqueId ||
              data?.user ||
              data?.tiktok ||
              ""
            );
        }

        if (!username) {

          socket.emit(
            "live:status",
            {
              ok: false,

              message:
                "Username TikTok kosong.",

              username:
                activeUsername ||
                null,

              connected:
                liveConnected
            }
          );

          return;
        }

        try {

          await connectToLive(
            username
          );

        } catch (err) {

          socket.emit(
            "live:status",
            {
              ok: false,

              message:
                formatError(
                  err
                ),

              username:
                activeUsername ||
                username,

              connected:
                false
            }
          );
        }
      };

    /* =====================================================
       MULTIPLE CONNECT EVENT ALIASES
       ===================================================== */

    socket.on(
      "connect:tiktok",
      connectHandler
    );

    socket.on(
      "tiktok:connect",
      connectHandler
    );

    socket.on(
      "connectLive",
      connectHandler
    );

    socket.on(
      "connect-live",
      connectHandler
    );

    socket.on(
      "connectToLive",
      connectHandler
    );

    socket.on(
      "live:connect",
      connectHandler
    );

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

    const disconnectHandler =
      async () => {

        await stopConnection();

      };

    socket.on(
      "disconnect:tiktok",
      disconnectHandler
    );

    socket.on(
      "tiktok:disconnect",
      disconnectHandler
    );

    socket.on(
      "disconnectLive",
      disconnectHandler
    );

    socket.on(
      "disconnect-live",
      disconnectHandler
    );

    socket.on(
      "live:disconnect",
      disconnectHandler
    );

    /* =====================================================
       AUCTION STATE
       ===================================================== */

    socket.on(
      "auction:state",
      (data = {}) => {

        updateAuctionState(
          data
        );
      }
    );

    /* =====================================================
       AUCTION START
       ===================================================== */

    socket.on(
      "auction:start",
      (data = {}) => {

        auctionActive =
          true;

        auctionState.active =
          true;

        auctionState.running =
          true;

        auctionState.finished =
          false;

        updateAuctionState(
          data
        );
      }
    );

    /* =====================================================
       AUCTION STOP
       ===================================================== */

    socket.on(
      "auction:stop",
      () => {

        auctionActive =
          false;

        auctionState.active =
          false;

        auctionState.running =
          false;

        broadcastAuctionState();
      }
    );

    /* =====================================================
       AUCTION RESET
       ===================================================== */

    socket.on(
      "auction:reset",
      (data = {}) => {

        auctionActive =
          false;

        auctionState = {

          active: false,

          running: false,

          duration:
            Number(
              data.duration
            ) > 0
              ? Math.floor(
                  Number(
                    data.duration
                  )
                )
              : 300,

          remaining:
            Number(
              data.duration
            ) > 0
              ? Math.floor(
                  Number(
                    data.duration
                  )
                )
              : 300,

          extraTime:
            Number(
              data.extraTime
            ) >= 0
              ? Math.floor(
                  Number(
                    data.extraTime
                  )
                )
              : 30,

          extraRemaining: 0,

          extraActive: false,

          drawDuration:
            Number(
              data.drawDuration
            ) > 0
              ? Math.floor(
                  Number(
                    data.drawDuration
                  )
                )
              : 20,

          drawRemaining:
            Number(
              data.drawDuration
            ) > 0
              ? Math.floor(
                  Number(
                    data.drawDuration
                  )
                )
              : 20,

          inDraw: false,

          finished: false
        };

        broadcastAuctionState();
      }
    );

    /* =====================================================
       SOCKET DISCONNECT
       ===================================================== */

    socket.on(
      "disconnect",
      (reason) => {

        console.log(
          `[Socket] Client disconnected: ${socket.id} (${reason})`
        );
      }
    );
  }
);

/* =========================================================
   GLOBAL ERROR HANDLERS
   ========================================================= */

process.on(
  "uncaughtException",
  (err) => {

    console.error(
      "================================================"
    );

    console.error(
      "[FATAL] uncaughtException"
    );

    console.error(
      err
    );

    console.error(
      "================================================"
    );

    /*
     * Jangan langsung process.exit().
     * Supaya Railway tidak crash hanya karena
     * satu event runtime.
     */
  }
);

process.on(
  "unhandledRejection",
  (reason) => {

    console.error(
      "================================================"
    );

    console.error(
      "[ERROR] unhandledRejection"
    );

    console.error(
      reason
    );

    console.error(
      "================================================"
    );
  }
);

/* =========================================================
   SERVER LISTEN
   ========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================================"
    );

    console.log(
      `🚀 SERVER BERJALAN DI PORT ${PORT}`
    );

    console.log(
      `🌐 Static folder: ${__dirname}`
    );

    console.log(
      `🔌 Socket.IO: aktif`
    );

    console.log(
      `🎵 TikTok connector: siap`
    );

    console.log(
      `🔐 Signing mode: ${signingMode}`
    );

    console.log(
      "================================================"
    );

  }
);

/* =========================================================
   EXPORT
   ========================================================= */

module.exports = {
  app,
  server,
  io,

  connectToLive,
  stopConnection,

  getState: () => ({
    liveConnected,
    activeUsername,
    auctionActive,
    auctionState
  })
};
