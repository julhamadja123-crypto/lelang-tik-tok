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

/*
 * ========================================================
 * SIGNING MODE
 * ========================================================
 *
 * DEFAULT:
 * PUBLIC
 *
 * Artinya server TIDAK membutuhkan SIGN_API_KEY.
 *
 * Kalau suatu saat ingin memakai API key:
 *
 * USE_SIGN_API_KEY=true
 *
 * lalu isi:
 *
 * SIGN_API_KEY=xxxxx
 *
 * ========================================================
 */

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
   GIFT DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL =
  60 * 1000;

/* =========================================================
   CONNECTOR LOADER
   ========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  let mod;

  try {
    mod = await import(
      "tiktok-live-connector"
    );
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
    typeof TikTokLiveConnection !==
    "function"
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

  /*
   * EMPTY PAYLOAD
   */

  if (
    lower.includes(
      "empty payload"
    )
  ) {
    return (
      "TikTok signing server mengembalikan Empty Payload. " +
      "Server akan mencoba ulang otomatis."
    );
  }

  /*
   * OFFLINE
   */

  if (
    lower.includes("offline") ||
    lower.includes("not live") ||
    lower.includes("useroffline")
  ) {
    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }

  /*
   * TIMEOUT
   */

  if (
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik kemudian."
    );
  }

  /*
   * RATE LIMIT
   */

  if (
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {
    return (
      "TikTok/signing server sedang membatasi request. Tunggu beberapa saat."
    );
  }

  /*
   * API KEY
   */

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

  /*
   * 404
   */

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

/* =========================================================
   GIFT DATA
   ========================================================= */

function parseGift(event) {
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
    (
      giftId
        ? `Gift #${giftId}`
        : "Gift"
    );

  const diamondCount =
    numberPositive(
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

  const repeatCount =
    Math.max(
      1,
      Math.floor(
        numberPositive(
          event.repeatCount,
          event.repeat_count,
          event.gift?.repeatCount,
          event.gift?.repeat_count,
          1
        )
      )
    );

  const giftType =
    Number(
      event.giftType ??
      event.gift_type ??
      event.gift?.giftType ??
      event.gift?.gift_type ??
      event.giftDetails?.giftType ??
      event.giftDetails?.gift_type ??
      0
    );

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

  /*
   * Gift streak belum selesai.
   */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    return null;
  }

  /*
   * Kalau connector tidak memberikan diamondCount,
   * tetap kirim gift supaya frontend dapat memprosesnya.
   */

  if (!giftId) {
    return null;
  }

  const coinValue =
    diamondCount > 0
      ? diamondCount * repeatCount
      : 0;

  /*
   * Event ID
   */

  const eventKey =
    String(
      event.msgId ||
      event.transactionId ||
      event.transaction_id ||
      event.messageId ||
      `${event.groupId || ""}|${user.userId}|${giftId}|${repeatCount}|${event.createTime || event.timestamp || ""}|${repeatEnd}`
    );

  const now =
    Date.now();

  /*
   * Hapus event lama.
   */

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

  /*
   * Duplicate
   */

  if (
    processedGiftEvents.has(
      eventKey
    )
  ) {
    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  console.log(
    `[GIFT] @${user.uniqueId} | ${giftName} | diamonds=${diamondCount} | repeat=${repeatCount} | coins=${coinValue}`
  );

  return {
    username:
      user.uniqueId,

    nickname:
      user.nickname,

    userId:
      user.userId,

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

    avatar:
      user.avatar
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

    reconnectTimer =
      null;
  }

  manualDisconnect =
    true;

  const connection =
    liveConnection;

  liveConnection =
    null;

  if (!connection) {
    return;
  }

  try {
    await connection.disconnect();
  } catch (err) {
    console.warn(
      "[TikTok] disconnect:",
      err?.message ||
      err
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
        reconnectTimer =
          null;

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
            err?.message ||
            err
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

  /*
   * Putus koneksi lama.
   */

  await stopConnection();

  manualDisconnect =
    false;

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

  if (
    signingMode ===
    "api-key"
  ) {
    console.log(
      "[TikTok] SIGN_API_KEY digunakan."
    );
  } else {
    console.log(
      "[TikTok] Public signing digunakan. Tidak membutuhkan API key."
    );
  }

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /*
   * ======================================================
   * OPTIONS
   * ======================================================
   *
   * PENTING:
   *
   * fetchRoomInfoOnConnect = false
   *
   * Ini sengaja dimatikan agar connector tidak melakukan
   * request room-info tambahan saat proses connect.
   *
   * Ini membantu menghindari error:
   *
   * "Empty Payload"
   *
   * yang terlihat pada log Railway sebelumnya.
   */

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

  /*
   * API KEY HANYA DIPAKAI JIKA:
   *
   * USE_SIGN_API_KEY=true
   *
   */

  if (
    signingMode ===
    "api-key"
  ) {
    options.signApiKey =
      SIGN_API_KEY;
  }

  /*
   * Buat connection.
   */

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

      /*
       * Gift hanya dihitung kalau
       * lelang sedang aktif.
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
        parseGift(event);

      if (!gift) {
        return;
      }

      io.emit(
        "live:gift",
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
            user.userId
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
            user.userId
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
            user.userId
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

      /*
       * Jangan reconnect kalau:
       *
       * - user sengaja disconnect
       * - koneksi sudah diganti
       * - username kosong
       */

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

    /*
     * Pastikan koneksi ini masih aktif.
     */

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
      connection?.roomId ||
      "";

    console.log(
      "================================================"
    );

    console.log(
      `[TikTok] BERHASIL TERHUBUNG @${username}`
    );

    console.log(
      `[TikTok] Room ID: ${roomId || "unknown"}`
    );

    console.log(
      "================================================"
    );

    emitStatus(
      `Terhubung ke LIVE @${username}`,
      true
    );

    /*
     * Kirim event connected ke browser.
     */

    io.emit(
      "live:connected",
      {
        username,
        roomId:
          roomId || null
      }
    );

    return state;

  } catch (err) {
    /*
     * Kalau koneksi ini masih koneksi aktif,
     * kosongkan reference.
     */

    if (
      liveConnection ===
      connection
    ) {
      liveConnection =
        null;
    }

    const friendly =
      formatError(err);

    console.error(
      "================================================"
    );

    console.error(
      `[TikTok] GAGAL CONNECT @${username}`
    );

    console.error(
      "Friendly:",
      friendly
    );

    console.error(
      "Original:",
      err
    );

    console.error(
      "Message:",
      err?.message
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
      "================================================"
    );

    emitStatus(
      `Gagal terhubung @${username}: ${friendly}`
    );

    throw err;
  }
}

/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on(
  "connection",
  (socket) => {
    console.log(
      `[Socket] Client terhubung: ${socket.id}`
    );

    /*
     * Kirim status saat client pertama masuk.
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

        connected,

        username:
          activeUsername ||
          null,

        message:
          connected
            ? `Terhubung ke @${activeUsername}`
            : "Belum terhubung ke TikTok LIVE"
      }
    );

    /* =====================================================
       LIVE CONNECT
       ===================================================== */

    socket.on(
      "live:connect",
      async (data = {}) => {
        const username =
          cleanUsername(
            data.username
          );

        if (!username) {
          socket.emit(
            "live:error",
            {
              message:
                "Masukkan username TikTok terlebih dahulu."
            }
          );

          return;
        }

        try {
          await connectToLive(
            username
          );

          socket.emit(
            "live:connected",
            {
              username
            }
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
                formatError(err),

              raw:
                err?.message ||
                String(err)
            }
          );
        }
      }
    );

    /* =====================================================
       AUCTION STATE
       ===================================================== */

    socket.on(
      "auction:state",
      (data = {}) => {
        auctionActive =
          Boolean(
            data.active
          );

        console.log(
          `[Auction] ${
            auctionActive
              ? "ACTIVE"
              : "INACTIVE"
          }`
        );

        io.emit(
          "auction:state",
          {
            active:
              auctionActive
          }
        );
      }
    );

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {
        console.log(
          "[Socket] User meminta disconnect TikTok."
        );

        auctionActive =
          false;

        await stopConnection();

        activeUsername =
          null;

        io.emit(
          "auction:state",
          {
            active: false
          }
        );

        emitStatus(
          "Koneksi TikTok LIVE diputus."
        );
      }
    );

    /* =====================================================
       SOCKET DISCONNECT
       ===================================================== */

    socket.on(
      "disconnect",
      () => {
        console.log(
          `[Socket] Client terputus: ${socket.id}`
        );
      }
    );
  }
);

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/health",
  (req, res) => {
    const connected =
      Boolean(
        liveConnection?.isConnected ||
        liveConnection?.state?.isConnected
      );

    res.status(200).json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      connected,

      username:
        activeUsername,

      auctionActive,

      /*
       * API key sengaja bukan syarat.
       */

      apiKeyConfigured:
        Boolean(SIGN_API_KEY),

      apiKeyUsed:
        signingMode ===
        "api-key",

      signingMode
    });
  }
);

/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      __dirname +
      "/index.html"
    );
  }
);

/* =========================================================
   SERVER
   ========================================================= */

const PORT =
  Number(
    process.env.PORT
  ) || 3000;

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
      `Signing mode: ${signingMode}`
    );

    console.log(
      `SIGN_API_KEY tersedia: ${
        SIGN_API_KEY
          ? "YA"
          : "TIDAK"
      }`
    );

    console.log(
      `SIGN_API_KEY digunakan: ${
        signingMode === "api-key"
          ? "YA"
          : "TIDAK"
      }`
    );

    console.log(
      "================================================"
    );
  }
);

/* =========================================================
   PROCESS ERROR
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

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdown(
  signal
) {
  console.log(
    `[PROCESS] ${signal} diterima. Shutdown...`
  );

  manualDisconnect =
    true;

  try {
    if (liveConnection) {
      await liveConnection.disconnect();
    }
  } catch (err) {
    console.warn(
      "[PROCESS] Disconnect error:",
      err?.message ||
      err
    );
  }

  server.close(
    () => {
      console.log(
        "[PROCESS] Server berhenti."
      );

      process.exit(0);
    }
  );

  /*
   * Safety timeout.
   */

  setTimeout(
    () => {
      process.exit(0);
    },
    5000
  ).unref();
}

process.on(
  "SIGTERM",
  () => {
    shutdown("SIGTERM");
  }
);

process.on(
  "SIGINT",
  () => {
    shutdown("SIGINT");
  }
);
