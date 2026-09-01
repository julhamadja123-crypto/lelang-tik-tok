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

app.use(express.json());
app.use(express.static(__dirname));

/* =========================================================
   TIKTOK LIVE
   ========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;

let activeUsername = null;
let reconnectTimer = null;

let manualDisconnect = false;
let auctionActive = false;
let connectionGeneration = 0;

/*
 * API KEY SENGAJA TIDAK DIWAJIBKAN.
 *
 * Livestream publik dapat dibaca tanpa API key.
 *
 * Kalau nanti kamu memiliki Euler Stream API key
 * yang benar, bisa ditambahkan lagi.
 */
const SIGN_API_KEY = String(
  process.env.SIGN_API_KEY || ""
).trim();

/*
 * Default:
 * JANGAN gunakan API key.
 *
 * Ini penting karena API key sebelumnya menghasilkan:
 *
 * reason: 'Empty Payload'
 */
const USE_SIGN_API_KEY =
  String(
    process.env.USE_SIGN_API_KEY || "false"
  ).toLowerCase() === "true";

/* =========================================================
   GIFT DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;

/* =========================================================
   LOAD TIKTOK CONNECTOR
   ========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  try {
    const mod = await import(
      "tiktok-live-connector"
    );

    TikTokLiveConnection =
      mod.TikTokLiveConnection ||
      mod.default?.TikTokLiveConnection ||
      mod.default;

    /*
     * Beberapa versi lama menyediakan
     * WebcastPushConnection.
     */
    if (
      typeof TikTokLiveConnection !==
      "function"
    ) {
      TikTokLiveConnection =
        mod.WebcastPushConnection ||
        mod.default?.WebcastPushConnection;
    }

    if (
      typeof TikTokLiveConnection !==
      "function"
    ) {
      throw new Error(
        "TikTokLiveConnection tidak ditemukan."
      );
    }

    console.log(
      "[TikTok] Connector berhasil dimuat."
    );

    return TikTokLiveConnection;
  } catch (err) {
    console.error(
      "[TikTok] Gagal memuat connector:",
      err
    );

    throw new Error(
      "Package tiktok-live-connector tidak dapat dimuat. Pastikan package sudah terinstall."
    );
  }
}

/* =========================================================
   CLEAN USERNAME
   ========================================================= */

function cleanUsername(value) {
  let username = String(
    value || ""
  ).trim();

  username = username
    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\/@/i,
      ""
    )
    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\//i,
      ""
    )
    .replace(/^@/, "")
    .replace(/\/live.*$/i, "")
    .replace(/[/?#].*$/g, "")
    .replace(/\s+/g, "");

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
      message,
      ok
    }
  );
}

/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {
  const raw =
    err?.message ||
    err?.reason ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const msg =
    typeof raw === "string"
      ? raw
      : JSON.stringify(raw);

  const s =
    msg.toLowerCase();

  if (
    s.includes("useroffline") ||
    s.includes("offline") ||
    s.includes("not live")
  ) {
    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }

  if (
    s.includes("empty payload")
  ) {
    return (
      "Signing provider mengembalikan Empty Payload. Server sekarang dibuat tanpa SIGN_API_KEY. Pastikan USE_SIGN_API_KEY=false."
    );
  }

  if (
    s.includes("api key") ||
    s.includes("apikey") ||
    s.includes("signature") ||
    s.includes("signing") ||
    s.includes("euler") ||
    s.includes("401") ||
    s.includes("403")
  ) {
    return (
      "Signing provider menolak request. Server ini tidak mewajibkan API key."
    );
  }

  if (
    s.includes("timeout") ||
    s.includes("timed out")
  ) {
    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik."
    );
  }

  if (
    s.includes("captcha") ||
    s.includes("verify")
  ) {
    return (
      "TikTok meminta verifikasi jaringan. Coba beberapa saat lagi."
    );
  }

  if (
    s.includes("room id")
  ) {
    return (
      "Room LIVE TikTok tidak ditemukan. Pastikan akun benar-benar sedang LIVE."
    );
  }

  return msg;
}

/* =========================================================
   NUMBER HELPER
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

    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n > 0
    ) {
      return n;
    }
  }

  return 0;
}

/* =========================================================
   USER DATA
   ========================================================= */

function userData(event) {
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

function giftData(event) {
  if (!event) {
    return null;
  }

  const user =
    userData(event);

  const giftId = String(
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
   * Gift streak.
   */
  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    return null;
  }

  if (
    !giftId ||
    diamondCount <= 0
  ) {
    return null;
  }

  const coinValue =
    diamondCount *
    repeatCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  const eventKey = String(
    event.msgId ||
    event.transactionId ||
    event.transaction_id ||
    `${event.groupId || ""}|${user.userId}|${giftId}|${repeatCount}|${event.createTime || event.timestamp || ""}|${repeatEnd}`
  );

  const now =
    Date.now();

  /*
   * Bersihkan event lama.
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
   * Cegah duplikat.
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
    `[GIFT] @${user.uniqueId} | ${giftName} | ${diamondCount} x ${repeatCount} = ${coinValue}`
  );

  return {
    username:
      user.uniqueId,

    nickname:
      user.nickname,

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
  clearTimeout(
    reconnectTimer
  );

  reconnectTimer = null;

  manualDisconnect = true;

  connectionGeneration++;

  const conn =
    liveConnection;

  liveConnection = null;

  if (conn) {
    try {
      await conn.disconnect();
    } catch (err) {
      console.warn(
        "[TikTok] disconnect:",
        err?.message ||
          err
      );
    }
  }
}

/* =========================================================
   BUILD CONNECTOR OPTIONS
   ========================================================= */

function buildConnectorOptions() {
  const options = {
    /*
     * Jangan proses chat lama.
     */
    processInitialData:
      false,

    /*
     * Pastikan room info diambil.
     */
    fetchRoomInfoOnConnect:
      true,

    /*
     * Dapatkan informasi gift
     * jika connector mendukungnya.
     */
    enableExtendedGiftInfo:
      true,

    /*
     * HTTP timeout.
     *
     * Connector versi baru menggunakan got.
     */
    webClientOptions: {
      timeout: {
        request: 15000
      }
    },

    /*
     * WebSocket timeout.
     */
    wsClientOptions: {
      handshakeTimeout:
        15000
    }
  };

  /*
   * API key HANYA digunakan jika
   * USE_SIGN_API_KEY=true.
   *
   * Default = false.
   */
  if (
    USE_SIGN_API_KEY &&
    SIGN_API_KEY
  ) {
    options.signApiKey =
      SIGN_API_KEY;

    console.log(
      "[TikTok] SIGN_API_KEY: AKTIF"
    );
  } else {
    console.log(
      "[TikTok] SIGN_API_KEY: TIDAK DIGUNAKAN"
    );
  }

  return options;
}

/* =========================================================
   CONNECT TIKTOK
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
   * Buat ID koneksi baru.
   */
  const generation =
    ++connectionGeneration;

  /*
   * Putus koneksi lama.
   */
  await stopConnection();

  /*
   * stopConnection() menaikkan
   * generation lagi.
   */
  const myGeneration =
    connectionGeneration;

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
    `[TikTok] Connection generation: ${myGeneration}`
  );

  console.log(
    `[TikTok] API KEY mode: ${
      USE_SIGN_API_KEY &&
      SIGN_API_KEY
        ? "AKTIF"
        : "NONAKTIF"
    }`
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /*
   * Buat koneksi.
   */
  const options =
    buildConnectorOptions();

  const conn =
    new Connector(
      username,
      options
    );

  /*
   * Jangan biarkan koneksi lama
   * mengambil alih koneksi baru.
   */
  liveConnection =
    conn;

  /* =======================================================
     GIFT
     ======================================================= */

  conn.on(
    "gift",
    (event) => {
      try {
        if (!auctionActive) {
          return;
        }

        /*
         * Pastikan event berasal dari
         * koneksi aktif.
         */
        if (
          liveConnection !==
          conn
        ) {
          return;
        }

        const gift =
          giftData(event);

        if (gift) {
          io.emit(
            "live:gift",
            gift
          );
        }
      } catch (err) {
        console.error(
          "[TikTok] Gift handler error:",
          err
        );
      }
    }
  );

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on(
    "chat",
    (event) => {
      try {
        if (
          liveConnection !==
          conn
        ) {
          return;
        }

        const user =
          userData(event);

        io.emit(
          "live:event",
          {
            type: "chat",

            username:
              user.uniqueId,

            nickname:
              user.nickname,

            avatar:
              user.avatar,

            message:
              event?.comment ||
              event?.message ||
              ""
          }
        );
      } catch (err) {
        console.error(
          "[TikTok] Chat handler error:",
          err
        );
      }
    }
  );

  /* =======================================================
     CONNECTED
     ======================================================= */

  conn.on(
    "connected",
    (state) => {
      console.log(
        "[TikTok] connected:",
        state
      );
    }
  );

  /* =======================================================
     ERROR
     ======================================================= */

  conn.on(
    "error",
    (err) => {
      console.error(
        "[TikTok] ERROR:",
        err
      );

      /*
       * Jangan langsung memutuskan koneksi
       * hanya karena event error.
       */
      emitStatus(
        `Error TikTok: ${formatError(err)}`
      );
    }
  );

  /* =======================================================
     DISCONNECTED
     ======================================================= */

  conn.on(
    "disconnected",
    () => {
      console.warn(
        `[TikTok] @${activeUsername} terputus.`
      );

      /*
       * Jangan reconnect koneksi lama.
       */
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
        setTimeout(
          () => {
            if (
              manualDisconnect ||
              !activeUsername ||
              liveConnection !==
                conn
            ) {
              return;
            }

            connectToLive(
              activeUsername
            ).catch(
              (err) => {
                console.error(
                  "[TikTok] Reconnect gagal:",
                  err
                );

                emitStatus(
                  `Reconnect gagal: ${formatError(err)}`
                );
              }
            );
          },
          5000
        );
    }
  );

  /* =======================================================
     CONNECT
     ======================================================= */

  try {
    /*
     * Coba koneksi.
     */
    const state =
      await conn.connect();

    /*
     * Kalau selama proses connect
     * koneksi sudah diganti,
     * buang koneksi ini.
     */
    if (
      liveConnection !==
      conn
    ) {
      try {
        await conn.disconnect();
      } catch (_) {}

      throw new Error(
        "Koneksi TikTok digantikan oleh koneksi lain."
      );
    }

    const roomId =
      state?.roomId ||
      conn.roomId ||
      conn.state?.roomId ||
      "aktif";

    emitStatus(
      `Terhubung ke LIVE @${username} • Room ${roomId}`,
      true
    );

    console.log(
      "================================================"
    );

    console.log(
      `[TikTok] BERHASIL TERHUBUNG @${username}`
    );

    console.log(
      `[TikTok] ROOM ID: ${roomId}`
    );

    console.log(
      "================================================"
    );

    return state;
  } catch (err) {
    if (
      liveConnection ===
      conn
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
      "[TikTok] GAGAL CONNECT"
    );

    console.error(
      "[TikTok] Raw error:",
      err
    );

    console.error(
      "[TikTok] Friendly:",
      friendly
    );

    console.error(
      "================================================"
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
   SOCKET.IO
   ========================================================= */

io.on(
  "connection",
  (socket) => {
    console.log(
      `[Socket] Client terhubung: ${socket.id}`
    );

    const connected =
      Boolean(
        liveConnection?.isConnected
      );

    socket.emit(
      "live:status",
      {
        ok:
          connected,

        message:
          connected
            ? `Terhubung ke @${activeUsername}`
            : "Belum terhubung ke TikTok LIVE"
      }
    );

    /* =====================================================
       CONNECT
       ===================================================== */

    socket.on(
      "live:connect",
      async (data = {}) => {
        try {
          const username =
            cleanUsername(
              data.username
            );

          if (!username) {
            throw new Error(
              "Masukkan username TikTok terlebih dahulu."
            );
          }

          /*
           * Kalau username sama dan
           * masih terkoneksi, tidak perlu
           * membuat koneksi baru.
           */
          if (
            liveConnection &&
            liveConnection.isConnected &&
            activeUsername ===
              username
          ) {
            socket.emit(
              "live:status",
              {
                ok: true,

                message:
                  `Sudah terhubung ke @${username}`
              }
            );

            return;
          }

          await connectToLive(
            username
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
          "[Socket] Disconnect TikTok."
        );

        auctionActive =
          false;

        await stopConnection();

        activeUsername =
          null;

        emitStatus(
          "Koneksi TikTok LIVE diputus."
        );
      }
    );

    /* =====================================================
       SOCKET DISCONNECTED
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
        liveConnection?.isConnected
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
       * Informasi mode saja.
       * Tidak pernah mengirim API key.
       */
      apiKeyConfigured:
        Boolean(SIGN_API_KEY),

      apiKeyUsed:
        Boolean(
          USE_SIGN_API_KEY &&
          SIGN_API_KEY
        ),

      signingMode:
        USE_SIGN_API_KEY &&
        SIGN_API_KEY
          ? "api-key"
          : "public"
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
      `SIGN_API_KEY tersedia: ${
        SIGN_API_KEY
          ? "YA"
          : "TIDAK"
      }`
    );

    console.log(
      `SIGN_API_KEY digunakan: ${
        USE_SIGN_API_KEY &&
        SIGN_API_KEY
          ? "YA"
          : "TIDAK"
      }`
    );

    console.log(
      "Mode TikTok: PUBLIC LIVESTREAM"
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

  try {
    await stopConnection();
  } catch (_) {}

  server.close(
    () => {
      console.log(
        "[PROCESS] Server berhenti."
      );

      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    5000
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
