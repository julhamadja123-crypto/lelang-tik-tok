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
   API KEY
   ========================================================= */

/*
 * API key TikTok/Euler Stream diambil dari:
 *
 * SIGN_API_KEY
 *
 * Railway:
 * Project
 *   -> Variables
 *   -> New Variable
 *
 * Name:
 * SIGN_API_KEY
 *
 * Value:
 * API KEY KAMU
 */

const SIGN_API_KEY =
  process.env.SIGN_API_KEY ||
  "";

if (!SIGN_API_KEY) {
  console.warn(
    "================================================"
  );

  console.warn(
    "[WARNING] SIGN_API_KEY BELUM DIATUR."
  );

  console.warn(
    "[WARNING] TikTok LIVE kemungkinan gagal terhubung."
  );

  console.warn(
    "Tambahkan environment variable:"
  );

  console.warn(
    "SIGN_API_KEY=API_KEY_EULER_STREAM_KAMU"
  );

  console.warn(
    "================================================"
  );
} else {
  console.log(
    "[TikTok] SIGN_API_KEY ditemukan."
  );
}

/* =========================================================
   TIKTOK CONNECTION
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

/* =========================================================
   GIFT DEDUPLICATION
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

  const mod = await import("tiktok-live-connector");

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (typeof TikTokLiveConnection !== "function") {
    throw new Error(
      "TikTokLiveConnection tidak ditemukan. Pastikan tiktok-live-connector terinstall."
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
    s.includes("api key") ||
    s.includes("apikey") ||
    s.includes("unauthorized") ||
    s.includes("401") ||
    s.includes("403")
  ) {
    return "API key TikTok/Euler Stream tidak valid atau belum diatur.";
  }

  if (
    s.includes("sign") ||
    s.includes("signature") ||
    s.includes("euler") ||
    s.includes("business plan") ||
    s.includes("404")
  ) {
    return "TikTok/signing provider menolak koneksi. Periksa SIGN_API_KEY.";
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

function userData(event) {
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

/* =========================================================
   GIFT DATA
   ========================================================= */

function giftData(event) {
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
     DIAMOND / COIN VALUE
     ------------------------------------------------------- */

  const diamondCount = numberPositive(
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

  /* -------------------------------------------------------
     REPEAT COUNT
     ------------------------------------------------------- */

  const repeatCount = Math.max(
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

  /* -------------------------------------------------------
     GIFT TYPE
     ------------------------------------------------------- */

  const giftType = Number(
    event.giftType ??
    event.gift_type ??
    event.gift?.giftType ??
    event.gift?.gift_type ??
    event.giftDetails?.giftType ??
    event.giftDetails?.gift_type ??
    0
  );

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

  /*
   * Gift type 1 biasanya merupakan streak.
   * Jangan menghitung update streak yang belum selesai.
   */

  if (giftType === 1 && !repeatEnd) {
    return null;
  }

  /* -------------------------------------------------------
     VALIDATION
     ------------------------------------------------------- */

  if (!giftId) {
    return null;
  }

  if (diamondCount <= 0) {
    return null;
  }

  /* -------------------------------------------------------
     TOTAL COIN
     ------------------------------------------------------- */

  const coinValue =
    diamondCount * repeatCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  /* -------------------------------------------------------
     UNIQUE EVENT ID
     ------------------------------------------------------- */

  const msgId =
    event.msgId ??
    event.msg_id ??
    null;

  const transactionId =
    event.transactionId ??
    event.transaction_id ??
    null;

  let eventKey = null;

  if (msgId) {
    eventKey = `msg:${String(msgId)}`;
  } else if (transactionId) {
    eventKey =
      `transaction:${String(transactionId)}`;
  }

  /* -------------------------------------------------------
     CLEAN OLD DEDUP EVENTS
     ------------------------------------------------------- */

  const now = Date.now();

  for (const [key, time] of processedGiftEvents) {
    if (now - time > GIFT_TTL) {
      processedGiftEvents.delete(key);
    }
  }

  /* -------------------------------------------------------
     DEDUP ONLY REAL EVENT ID
     ------------------------------------------------------- */

  if (eventKey) {
    if (processedGiftEvents.has(eventKey)) {
      console.log(
        `[GIFT] Duplicate diabaikan: ${eventKey}`
      );

      return null;
    }

    processedGiftEvents.set(
      eventKey,
      now
    );
  }

  /* -------------------------------------------------------
     LOG
     ------------------------------------------------------- */

  console.log(
    `[GIFT] @${user.uniqueId} | ` +
    `${giftName} | ` +
    `${diamondCount} x ${repeatCount} = ${coinValue}`
  );

  /* -------------------------------------------------------
     RETURN
     ------------------------------------------------------- */

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

    msgId,
    transactionId,

    avatar: user.avatar,

    /*
     * FRONTEND:
     *
     * Data tetap dikirim untuk penambahan coin.
     * Tidak perlu menampilkan notifikasi.
     */

    silent: true,
    displayNotification: false,
    showNotification: false
  };
}

/* =========================================================
   STOP CONNECTION
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
   CONNECT TO TIKTOK LIVE
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

  /* -------------------------------------------------------
     API KEY CHECK
     ------------------------------------------------------- */

  if (!SIGN_API_KEY) {
    throw new Error(
      "SIGN_API_KEY belum diatur di Environment Variables."
    );
  }

  await stopConnection();

  manualDisconnect = false;

  activeUsername = username;

  console.log(
    "================================================"
  );

  console.log(
    `[TikTok] Mencoba koneksi @${username}`
  );

  console.log(
    "[TikTok] MODE API KEY AKTIF"
  );

  console.log(
    "[TikTok] SIGN_API_KEY: tersedia"
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /* -------------------------------------------------------
     CREATE CONNECTION
     ------------------------------------------------------- */

  const conn = new Connector(
    username,
    {
      /*
       * ===================================================
       * API KEY DIKEMBALIKAN DI SINI
       * ===================================================
       *
       * tiktok-live-connector menggunakan opsi
       * signApiKey untuk Euler Stream.
       */

      signApiKey: SIGN_API_KEY,

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
    }
  );

  liveConnection = conn;

  /* =======================================================
     GIFT EVENT
     ======================================================= */

  conn.on("gift", (event) => {
    /*
     * Jangan proses gift ketika lelang tidak aktif.
     */

    if (!auctionActive) {
      return;
    }

    const gift =
      giftData(event);

    if (!gift) {
      return;
    }

    /*
     * Data coin tetap dikirim.
     *
     * Tidak mengirim event notifikasi tambahan.
     */

    io.emit(
      "live:gift",
      gift
    );
  });

  /* =======================================================
     CHAT EVENT
     ======================================================= */

  conn.on("chat", () => {
    /*
     * Chat TikTok sengaja tidak dikirim
     * ke frontend.
     */
  });

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
        "[TikTok] error:",
        err
      );

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
    }
  );

  /* =======================================================
     CONNECT
     ======================================================= */

  try {
    const state =
      await conn.connect();

    /*
     * Pastikan koneksi yang berhasil
     * memang koneksi terbaru.
     */

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
   SOCKET.IO
   ========================================================= */

io.on(
  "connection",
  (socket) => {

    console.log(
      `[Socket] Client terhubung: ${socket.id}`
    );

    /* -----------------------------------------------------
       CURRENT CONNECTION STATUS
       ----------------------------------------------------- */

    const connected =
      Boolean(
        liveConnection?.isConnected ||
        liveConnection?.state?.isConnected
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

    /* -----------------------------------------------------
       CONNECT
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       AUCTION STATE
       ----------------------------------------------------- */

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

        io.emit(
          "auction:state",
          {
            active:
              auctionActive
          }
        );
      }
    );

    /* -----------------------------------------------------
       DISCONNECT TIKTOK
       ----------------------------------------------------- */

    socket.on(
      "live:disconnect",
      async () => {

        console.log(
          "[Socket] Disconnect TikTok."
        );

        auctionActive = false;

        await stopConnection();

        activeUsername = null;

        processedGiftEvents.clear();

        emitStatus(
          "Koneksi TikTok LIVE diputus."
        );
      }
    );

    /* -----------------------------------------------------
       SOCKET DISCONNECT
       ----------------------------------------------------- */

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

    res.status(200).json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      connected:
        Boolean(liveConnection),

      username:
        activeUsername,

      auctionActive,

      apiKeyRequired:
        true,

      apiKeyConfigured:
        Boolean(SIGN_API_KEY)
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
   SERVER START
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
      "MODE: API KEY AKTIF"
    );

    console.log(
      `SIGN_API_KEY: ${
        SIGN_API_KEY
          ? "TERSEDIA"
          : "BELUM DIATUR"
      }`
    );

    console.log(
      "================================================"
    );
  }
);

/* =========================================================
   ERROR HANDLING
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
