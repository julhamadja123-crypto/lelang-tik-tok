const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

/* =========================================================
   SERVER
   ========================================================= */

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
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

/* =========================================================
   SIGNING MODE
   ========================================================= */

const SIGN_API_KEY =
  String(process.env.SIGN_API_KEY || "").trim();

const USE_SIGN_API_KEY =
  String(process.env.USE_SIGN_API_KEY || "")
    .trim()
    .toLowerCase() === "true";

const signingMode =
  USE_SIGN_API_KEY && SIGN_API_KEY
    ? "api-key"
    : "public";

/* =========================================================
   DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;

/* =========================================================
   CONNECTOR LOADER
   ========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  let mod;

  try {
    mod = await import("tiktok-live-connector");
  } catch (err) {
    console.error(
      "[TikTok] Gagal load tiktok-live-connector:",
      err
    );

    throw new Error(
      "Package tiktok-live-connector tidak ditemukan."
    );
  }

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (
    typeof TikTokLiveConnection !== "function"
  ) {
    throw new Error(
      "TikTokLiveConnection tidak ditemukan di package tiktok-live-connector."
    );
  }

  return TikTokLiveConnection;
}

/* =========================================================
   USERNAME CLEANER
   ========================================================= */

function cleanUsername(value) {
  let username =
    String(value || "").trim();

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
    username.replace(/^@/, "");

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
   STATUS
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
        activeUsername || null,
      connected:
        Boolean(liveConnection)
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
    lower.includes("empty payload")
  ) {
    return (
      "TikTok signing server mengembalikan Empty Payload. " +
      "Server akan mencoba ulang otomatis."
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
      "Signing provider menolak request."
    );
  }

  if (
    lower.includes("404")
  ) {
    return (
      "Endpoint TikTok/signing tidak ditemukan. Kemungkinan package connector perlu diperbarui."
    );
  }

  return message;
}

/* =========================================================
   NUMBER
   ========================================================= */

function numberPositive(...values) {
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
      event?.userDetails?.profilePictureUrls
    )
  ) {
    avatar =
      event.userDetails.profilePictureUrls[0] ||
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
   TIKTOK COIN VALUE
   =========================================================

   PENTING:

   HANYA diamondCount yang digunakan sebagai
   nilai 1 gift.

   TIDAK menggunakan:
   - coinValue
   - coinCount
   - coin_value
   - coin_count

   Karena field tersebut tidak kita jadikan
   sumber harga gift.

   ========================================================= */

function getTikTokCoinValue(event) {
  const diamondCount =
    numberPositive(
      event?.diamondCount,
      event?.diamond_count,

      event?.gift?.diamondCount,
      event?.gift?.diamond_count,

      event?.giftDetails?.diamondCount,
      event?.giftDetails?.diamond_count,

      event?.extendedGiftInfo?.diamondCount,
      event?.extendedGiftInfo?.diamond_count
    );

  if (diamondCount > 0) {
    return diamondCount;
  }

  return 0;
}

/* =========================================================
   GET REPEAT COUNT
   ========================================================= */

function getRepeatCount(event) {
  const repeatCount =
    numberPositive(
      event?.repeatCount,
      event?.repeat_count,

      event?.gift?.repeatCount,
      event?.gift?.repeat_count,

      event?.giftDetails?.repeatCount,
      event?.giftDetails?.repeat_count
    );

  if (repeatCount <= 0) {
    return 1;
  }

  return Math.max(
    1,
    Math.floor(repeatCount)
  );
}

/* =========================================================
   GET GIFT TYPE
   ========================================================= */

function getGiftType(event) {
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

  return Number.isFinite(result)
    ? result
    : 0;
}

/* =========================================================
   GET REPEAT END
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
   DUPLICATE CLEANUP
   ========================================================= */

function cleanupGiftEvents() {
  const now =
    Date.now();

  for (
    const [
      key,
      time
    ] of processedGiftEvents
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
   CREATE DUPLICATE KEY
   ========================================================= */

function createGiftEventKey(
  event,
  user,
  repeatCount,
  repeatEnd
) {
  /*
   * Gunakan ID event TikTok jika tersedia.
   */

  const stableId =
    event?.msgId ||
    event?.msg_id ||
    event?.transactionId ||
    event?.transaction_id ||
    event?.messageId ||
    event?.message_id;

  if (stableId) {
    return String(stableId);
  }

  /*
   * Kalau tidak ada ID,
   * buat fingerprint dari data event.
   */

  return [
    event?.groupId ||
      event?.group_id ||
      "",

    user.userId,

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

function parseGift(event) {
  if (!event) {
    return null;
  }

  const user =
    getUserData(event);

  /* =======================================================
     GIFT NAME / ID
     ======================================================= */

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

  /* =======================================================
     NILAI DASAR GIFT
     ======================================================= */

  const tikTokCoin =
    getTikTokCoinValue(event);

  if (
    tikTokCoin <= 0
  ) {
    console.warn(
      "[Gift] COIN TIKTOK TIDAK DITEMUKAN."
    );

    console.warn(
      "[Gift] Gift diabaikan agar tidak salah hitung."
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

  /* =======================================================
     REPEAT COUNT
     ======================================================= */

  const repeatCount =
    getRepeatCount(event);

  /* =======================================================
     GIFT TYPE
     ======================================================= */

  const giftType =
    getGiftType(event);

  /* =======================================================
     REPEAT END
     ======================================================= */

  const repeatEnd =
    getRepeatEnd(event);

  /* =======================================================
     STREAK HANDLING
     ======================================================= */

  /*
   * giftType 1 = gift yang dapat melakukan streak.
   *
   * Event sebelum streak selesai tidak dihitung.
   */

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
     TOTAL COIN
     ======================================================= */

  const totalCoin =
    tikTokCoin *
    repeatCount;

  /* =======================================================
     LOG PERHITUNGAN
     ======================================================= */

  console.log(
    "================================================"
  );

  console.log(
    "[GIFT CHECK]"
  );

  console.log(
    `User        : @${user.uniqueId}`
  );

  console.log(
    `diamondCount: ${tikTokCoin}`
  );

  console.log(
    `repeatCount : ${repeatCount}`
  );

  console.log(
    `giftType    : ${giftType}`
  );

  console.log(
    `repeatEnd   : ${repeatEnd}`
  );

  console.log(
    `TOTAL       : ${totalCoin}`
  );

  console.log(
    `Nama gift   : ${giftName}`
  );

  console.log(
    `Gift ID     : ${giftId || "-"}`
  );

  console.log(
    "================================================"
  );

  /* =======================================================
     DUPLICATE PROTECTION
     ======================================================= */

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

  /* =======================================================
     HASIL
     ======================================================= */

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
      tikTokCoin,

    diamondCount:
      tikTokCoin,

    repeatCount,

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
  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  manualDisconnect = true;

  const connection =
    liveConnection;

  liveConnection = null;

  if (!connection) {
    return;
  }

  try {
    await connection.disconnect();
  } catch (err) {
    console.warn(
      "[TikTok] disconnect:",
      err?.message || err
    );
  }
}

/* =========================================================
   RECONNECT
   ========================================================= */

function scheduleReconnect() {
  if (
    manualDisconnect ||
    !activeUsername
  ) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  console.log(
    "[TikTok] Reconnect dijadwalkan dalam 8 detik..."
  );

  emitStatus(
    `Koneksi @${activeUsername} terputus. Mencoba ulang dalam 8 detik...`
  );

  reconnectTimer =
    setTimeout(
      async () => {
        reconnectTimer = null;

        if (
          manualDisconnect ||
          !activeUsername
        ) {
          return;
        }

        const username =
          activeUsername;

        try {
          await connectToLive(
            username
          );
        } catch (err) {
          console.error(
            "[TikTok] Reconnect gagal:",
            err?.message || err
          );

          scheduleReconnect();
        }
      },
      8000
    );
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

  await stopConnection();

  manualDisconnect = false;

  activeUsername =
    username;

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
    `Mencari LIVE @${username}...`
  );

  const options = {
    processInitialData: false,

    fetchRoomInfoOnConnect: false,

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
     GIFT
     ===================================================== */

  connection.on(
    "gift",
    (event) => {
      console.log(
        "[TikTok] Gift event diterima."
      );

      if (
        !auctionActive
      ) {
        console.log(
          "[Gift] Diabaikan karena auction belum aktif."
        );

        return;
      }

      const gift =
        parseGift(event);

      if (!gift) {
        return;
      }

      io.emit(
        "live:gift",
        gift
      );

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
        getUserData(event);

      io.emit(
        "live:event",
        {
          type: "chat",

          username:
            user.uniqueId,

          nickname:
            user.nickname,

          userId:
            user.userId,

          avatar:
            user.avatar
        }
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
        getUserData(event);

      io.emit(
        "live:event",
        {
          type: "member",

          username:
            user.uniqueId,

          nickname:
            user.nickname,

          userId:
            user.userId,

          avatar:
            user.avatar
        }
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
        getUserData(event);

      io.emit(
        "live:event",
        {
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
            numberPositive(
              event?.likeCount,
              event?.like_count
            )
        }
      );
    }
  );

  /* =====================================================
     SHARE
     ===================================================== */

  connection.on(
    "social",
    (event) => {
      const user =
        getUserData(event);

      io.emit(
        "live:event",
        {
          type: "social",

          username:
            user.uniqueId,

          nickname:
            user.nickname,

          userId:
            user.userId,

          avatar:
            user.avatar
        }
      );
    }
  );

  /* =====================================================
     CONNECTED
     ===================================================== */

  connection.on(
    "connected",
    (state) => {
      console.log(
        "[TikTok] CONNECTED EVENT"
      );

      console.log(
        "[TikTok] Room ID:",
        state?.roomId ||
        connection?.roomId ||
        "unknown"
      );
    }
  );

  /* =====================================================
     ERROR
     ===================================================== */

  connection.on(
    "error",
    (err) => {
      console.error(
        "================================================"
      );

      console.error(
        "[TikTok] CONNECTOR ERROR"
      );

      console.error(
        "Message:",
        err?.message
      );

      console.error(
        "Name:",
        err?.name
      );

      console.error(
        "Reason:",
        err?.reason
      );

      console.error(
        "Request ID:",
        err?.requestId
      );

      console.error(
        "Agent ID:",
        err?.agentId
      );

      console.error(
        "Full error:",
        err
      );

      console.error(
        "================================================"
      );

      emitStatus(
        `Error TikTok: ${formatError(err)}`
      );
    }
  );

  /* =====================================================
     DISCONNECTED
     ===================================================== */

  connection.on(
    "disconnected",
    () => {
      console.warn(
        `[TikTok] @${activeUsername} terputus.`
      );

      if (
        manualDisconnect ||
        liveConnection !== connection ||
        !activeUsername
      ) {
        return;
      }

      scheduleReconnect();
    }
  );

  /* =====================================================
     CONNECT
     ===================================================== */

  try {
    console.log(
      `[TikTok] Menjalankan connect() @${username}...`
    );

    const state =
      await connection.connect();

    if (
      liveConnection !==
      connection
    ) {
      try {
        await connection.disconnect();
      } catch (_) {}

      throw new Error(
        "Koneksi TikTok digantikan oleh koneksi lain."
      );
    }

    const roomId =
      state?.roomId ||
      connection?.roomId
