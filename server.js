const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { TikTokLive } = require("tiktok-live-api");

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
   CONFIG
   ========================================================= */

const PORT = Number(process.env.PORT || 3000);

const TIKTOK_USERNAME = (
  process.env.TIKTOK_USERNAME || "hamstillearn"
)
  .replace(/^@/, "")
  .trim();

const TIKTOOL_API_KEY = (
  process.env.TIKTOOL_API_KEY || ""
).trim();

const CONNECT_TIMEOUT = 30000;
const RECONNECT_DELAY = 10000;

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionRunning = false;
let auctionPaused = false;
let auctionFinished = false;

const participants = new Map();

/* =========================================================
   GIFT DIAGNOSTIC
   ========================================================= */

let giftEventsReceived = 0;
let giftEventsProcessed = 0;
let giftCoinsAdded = 0;

let lastGift = null;
let lastGiftAt = null;

/* =========================================================
   DEDUP
   ========================================================= */

const processedGiftIds = new Map();

const DEDUP_TTL = 10 * 60 * 1000;

function cleanupDedup() {
  const now = Date.now();

  for (const [id, timestamp] of processedGiftIds) {
    if (now - timestamp > DEDUP_TTL) {
      processedGiftIds.delete(id);
    }
  }
}

setInterval(cleanupDedup, 60 * 1000);

/* =========================================================
   TIKTOK CONNECTION STATE
   ========================================================= */

let liveClient = null;
let liveConnected = false;
let connecting = false;
let reconnectTimer = null;
let lastLiveError = null;

/* =========================================================
   HELPERS
   ========================================================= */

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

/* ---------------------------------------------------------
   USERNAME
   --------------------------------------------------------- */

function getUsername(event) {
  return (
    event?.user?.uniqueId ||
    event?.user?.unique_id ||
    event?.user?.uniqueIdString ||
    event?.uniqueId ||
    event?.unique_id ||
    ""
  )
    .toString()
    .replace(/^@/, "")
    .trim();
}

/* ---------------------------------------------------------
   NICKNAME
   --------------------------------------------------------- */

function getNickname(event) {
  return (
    event?.user?.nickname ||
    event?.user?.displayName ||
    event?.nickname ||
    getUsername(event)
  )
    .toString()
    .trim();
}

/* ---------------------------------------------------------
   GIFT ID
   --------------------------------------------------------- */

function getGiftId(event) {
  const transactionId =
    event?.transactionId ??
    event?.transaction_id;

  if (
    transactionId !== undefined &&
    transactionId !== null &&
    String(transactionId).trim() !== ""
  ) {
    return `tx:${String(transactionId)}`;
  }

  const msgId =
    event?.msgId ??
    event?.msg_id;

  if (
    msgId !== undefined &&
    msgId !== null &&
    String(msgId).trim() !== ""
  ) {
    return `msg:${String(msgId)}`;
  }

  /*
    giftId + user + repeatCount sebagai fallback.

    Ini hanya digunakan apabila API tidak memberikan
    transactionId maupun msgId.
  */

  const giftId =
    event?.giftId ??
    event?.gift_id;

  const username = getUsername(event);

  const repeatCount = Math.max(
    1,
    safeNumber(event?.repeatCount, 1)
  );

  if (
    giftId !== undefined &&
    giftId !== null &&
    String(giftId).trim() !== "" &&
    username
  ) {
    return (
      `gift:${username}:` +
      `${String(giftId)}:` +
      `${repeatCount}:` +
      `${event?.repeatEnd === true || event?.repeatEnd === 1 ? "end" : "live"}`
    );
  }

  return null;
}

/* =========================================================
   LIVE STATUS
   ========================================================= */

function emitLiveStatus(status, message = "") {
  const payload = {
    connected: liveConnected,
    connecting,
    status,
    username: TIKTOK_USERNAME,
    message: message || "",
    error: lastLiveError || null
  };

  io.emit("live:status", payload);

  /*
    Kompatibilitas dengan app.js lama.
  */

  io.emit("live:connect", {
    success: liveConnected,
    username: TIKTOK_USERNAME,
    status,
    message: message || "",
    error: lastLiveError || null
  });
}

/* =========================================================
   AUCTION SNAPSHOT
   ========================================================= */

function getParticipantsArray() {
  return [...participants.values()]
    .sort((a, b) => {
      if (b.coins !== a.coins) {
        return b.coins - a.coins;
      }

      return a.username.localeCompare(b.username);
    })
    .map((p, index) => ({
      rank: index + 1,
      username: p.username,
      nickname: p.nickname,
      coins: p.coins
    }));
}

function getAuctionState() {
  return {
    running: auctionRunning,
    paused: auctionPaused,
    finished: auctionFinished,
    participants: getParticipantsArray()
  };
}

function emitAuctionState() {
  io.emit(
    "auction:state",
    getAuctionState()
  );
}

/* =========================================================
   RESET AUCTION
   ========================================================= */

function resetAuction() {
  participants.clear();

  auctionRunning = false;
  auctionPaused = false;
  auctionFinished = false;

  processedGiftIds.clear();

  giftEventsReceived = 0;
  giftEventsProcessed = 0;
  giftCoinsAdded = 0;

  lastGift = null;
  lastGiftAt = null;

  emitAuctionState();

  console.log("[Auction] RESET");
}

/* =========================================================
   ADD COINS FROM GIFT
   ========================================================= */

function addCoinsFromGift(event) {
  /*
    Jangan menerima coin apabila lelang belum dimulai.
  */

  if (!auctionRunning) {
    console.log(
      "[Gift] DITERIMA tetapi lelang belum START - diabaikan."
    );

    return;
  }

  if (auctionPaused) {
    console.log(
      "[Gift] DITERIMA tetapi lelang PAUSE - diabaikan."
    );

    return;
  }

  if (auctionFinished) {
    console.log(
      "[Gift] DITERIMA tetapi lelang SUDAH SELESAI - diabaikan."
    );

    return;
  }

  /* -------------------------------------------------------
     USER
     ------------------------------------------------------- */

  const username = getUsername(event);

  if (!username) {
    console.log(
      "[Gift] Username kosong - gift tidak dapat dimasukkan."
    );

    return;
  }

  const nickname = getNickname(event);

  /* -------------------------------------------------------
     GIFT DATA
     ------------------------------------------------------- */

  const giftName = (
    event?.giftName ||
    event?.gift_name ||
    "Unknown Gift"
  )
    .toString();

  const diamondCount = Math.max(
    0,
    safeNumber(
      event?.diamondCount ??
      event?.diamond_count,
      0
    )
  );

  const repeatCount = Math.max(
    1,
    safeNumber(
      event?.repeatCount ??
      event?.repeat_count,
      1
    )
  );

  const repeatEnd =
    event?.repeatEnd ??
    event?.repeat_end ??
    null;

  const transactionId =
    event?.transactionId ??
    event?.transaction_id ??
    null;

  const msgId =
    event?.msgId ??
    event?.msg_id ??
    null;

  const giftId =
    event?.giftId ??
    event?.gift_id ??
    null;

  /* -------------------------------------------------------
     DIAGNOSTIC LOG
     ------------------------------------------------------- */

  console.log("");
  console.log(
    "========== GIFT EVENT RECEIVED =========="
  );

  console.log(
    `[Gift] User       : @${username}`
  );

  console.log(
    `[Gift] Nickname   : ${nickname}`
  );

  console.log(
    `[Gift] Gift       : ${giftName}`
  );

  console.log(
    `[Gift] Gift ID    : ${giftId ?? "-"}`
  );

  console.log(
    `[Gift] Diamonds   : ${diamondCount}`
  );

  console.log(
    `[Gift] Repeat     : ${repeatCount}`
  );

  console.log(
    `[Gift] Repeat End : ${repeatEnd ?? "-"}`
  );

  console.log(
    `[Gift] Tx ID      : ${transactionId ?? "-"}`
  );

  console.log(
    `[Gift] Msg ID     : ${msgId ?? "-"}`
  );

  console.log(
    "========================================="
  );

  /* -------------------------------------------------------
     DEDUP
     ------------------------------------------------------- */

  const giftEventId = getGiftId(event);

  if (giftEventId) {
    if (processedGiftIds.has(giftEventId)) {
      console.log(
        `[Gift] DUPLICATE IGNORED: ${giftEventId}`
      );

      return;
    }

    processedGiftIds.set(
      giftEventId,
      Date.now()
    );
  }

  /* -------------------------------------------------------
     COIN CALCULATION
     ------------------------------------------------------- */

  /*
    Contoh:

    1 diamond x 1 = +1
    1 diamond x 3 = +3
    5 diamond x 3 = +15
  */

  const coinsAdded =
    diamondCount * repeatCount;

  if (coinsAdded <= 0) {
    console.log(
      `[Gift] NILAI 0 - tidak dimasukkan. ` +
      `diamondCount=${diamondCount}`
    );

    return;
  }

  /* -------------------------------------------------------
     PARTICIPANT
     ------------------------------------------------------- */

  let participant =
    participants.get(username);

  if (!participant) {
    participant = {
      username,
      nickname,
      coins: 0,
      lastGiftAt: Date.now()
    };

    participants.set(
      username,
      participant
    );

    console.log(
      `[Participant] PESERTA BARU: @${username}`
    );
  }

  participant.nickname =
    nickname || participant.nickname;

  participant.coins += coinsAdded;

  participant.lastGiftAt =
    Date.now();

  /* -------------------------------------------------------
     DIAGNOSTIC COUNTERS
     ------------------------------------------------------- */

  giftEventsProcessed++;

  giftCoinsAdded += coinsAdded;

  lastGiftAt =
    new Date().toISOString();

  lastGift = {
    username,
    nickname,
    giftName,
    giftId,
    diamondCount,
    repeatCount,
    coinsAdded,
    totalCoins: participant.coins,
    transactionId,
    msgId,
    receivedAt: lastGiftAt
  };

  /* -------------------------------------------------------
     LOG SUCCESS
     ------------------------------------------------------- */

  console.log("");
  console.log(
    "========== COIN ADDED =========="
  );

  console.log(
    `@${username}`
  );

  console.log(
    `${giftName}`
  );

  console.log(
    `${diamondCount} x ${repeatCount} = +${coinsAdded}`
  );

  console.log(
    `TOTAL PESERTA = ${participant.coins}`
  );

  console.log(
    "================================"
  );

  /*
    Hanya update leaderboard.

    Tidak mengirim event gift/notifikasi
    ke tampilan.
  */

  emitAuctionState();
}

/* =========================================================
   DISCONNECT OLD CLIENT
   ========================================================= */

async function disconnectLiveClient() {
  if (!liveClient) {
    return;
  }

  try {
    await liveClient.disconnect();
  } catch (error) {
    console.log(
      "[TikTok] disconnect old client:",
      error?.message || error
    );
  }

  liveClient = null;
  liveConnected = false;
}

/* =========================================================
   RECONNECT
   ========================================================= */

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    console.log(
      "[TikTok] Mencoba koneksi ulang..."
    );

    connectToLive();
  }, RECONNECT_DELAY);
}

/* =========================================================
   CONNECT TO TIKTOK LIVE
   ========================================================= */

async function connectToLive() {
  if (connecting) {
    console.log(
      "[TikTok] Connection already in progress."
    );

    return;
  }

  if (liveConnected && liveClient) {
    console.log(
      "[TikTok] Already connected."
    );

    emitLiveStatus(
      "connected",
      `Terhubung ke @${TIKTOK_USERNAME}`
    );

    return;
  }

  if (!TIKTOOL_API_KEY) {
    lastLiveError =
      "TIKTOOL_API_KEY belum diisi.";

    console.error(
      "[TikTok] TIKTOOL_API_KEY MISSING"
    );

    emitLiveStatus(
      "error",
      "API Key TikTool belum diisi di Environment Variables."
    );

    return;
  }

  connecting = true;
  liveConnected = false;
  lastLiveError = null;

  emitLiveStatus(
    "connecting",
    `Menghubungkan ke @${TIKTOK_USERNAME}...`
  );

  console.log(
    "========================================"
  );

  console.log(
    `[TikTok] Connecting @${TIKTOK_USERNAME}`
  );

  console.log(
    "[TikTok] API Key: CONFIGURED"
  );

  console.log(
    "[TikTok] Package: tiktok-live-api"
  );

  console.log(
    "[TikTok] Gift listener: ENABLED"
  );

  console.log(
    "========================================"
  );

  await disconnectLiveClient();

  try {
    liveClient = new TikTokLive(
      TIKTOK_USERNAME,
      {
        apiKey: TIKTOOL_API_KEY,
        autoReconnect: true,
        maxReconnectAttempts: 10
      }
    );

    /* =====================================================
       CONNECTED
       ===================================================== */

    liveClient.on(
      "connected",
      () => {
        liveConnected = true;
        connecting = false;
        lastLiveError = null;

        console.log("");
        console.log(
          "[TikTok] ================================="
        );

        console.log(
          `[TikTok] CONNECTED @${TIKTOK_USERNAME}`
        );

        console.log(
          "[TikTok] LIVE EVENT STREAM AKTIF"
        );

        console.log(
          "[TikTok] GIFT LISTENER AKTIF"
        );

        console.log(
          "[TikTok] ================================="
        );

        console.log("");

        emitLiveStatus(
          "connected",
          `Terhubung ke TikTok LIVE @${TIKTOK_USERNAME}`
        );
      }
    );

    /* =====================================================
       ERROR
       ===================================================== */

    liveClient.on(
      "error",
      (error) => {
        const message =
          error?.message ||
          error?.error ||
          String(error);

        lastLiveError = message;

        console.error(
          "[TikTok] EVENT ERROR:",
          message
        );

        if (!liveConnected) {
          connecting = false;
        }

        emitLiveStatus(
          "error",
          `TikTok error: ${message}`
        );
      }
    );

    /* =====================================================
       DISCONNECTED
       ===================================================== */

    liveClient.on(
      "disconnected",
      () => {
        liveConnected = false;
        connecting = false;

        console.log(
          `[TikTok] DISCONNECTED @${TIKTOK_USERNAME}`
        );

        emitLiveStatus(
          "disconnected",
          "Koneksi TikTok terputus. Mencoba menghubungkan kembali..."
        );

        scheduleReconnect();
      }
    );

    /* =====================================================
       STREAM END
       ===================================================== */

    liveClient.on(
      "streamEnd",
      (event) => {
        liveConnected = false;
        connecting = false;

        console.log(
          "[TikTok] LIVE SELESAI:",
          event?.reason || "unknown"
        );

        emitLiveStatus(
          "ended",
          "TikTok LIVE telah berakhir."
        );
      }
    );

    /* =====================================================
       GIFT
       ===================================================== */

    liveClient.on(
      "gift",
      (event) => {
        /*
          PENTING:

          Hitung setiap event yang benar-benar
          diterima dari TikTok.

          Ini membuktikan apakah server
          benar-benar mendapatkan gift.
        */

        giftEventsReceived++;

        console.log("");
        console.log(
          "########################################"
        );

        console.log(
          `[TikTok] GIFT EVENT #${giftEventsReceived} DITERIMA`
        );

        console.log(
          `User: @${getUsername(event) || "UNKNOWN"}`
        );

        console.log(
          `Gift: ${
            event?.giftName ||
            event?.gift_name ||
            "UNKNOWN"
          }`
        );

        console.log(
          `Diamond: ${
            event?.diamondCount ??
            event?.diamond_count ??
            0
          }`
        );

        console.log(
          `Repeat: ${
            event?.repeatCount ??
            event?.repeat_count ??
            1
          }`
        );

        console.log(
          `RepeatEnd: ${
            event?.repeatEnd ??
            event?.repeat_end ??
            "-"
          }`
        );

        console.log(
          "########################################"
        );

        try {
          /*
            Untuk gift streak:

            repeatEnd === false

            berarti combo masih berjalan.

            Tunggu event terakhir supaya
            repeatCount bisa digunakan sebagai
            jumlah total combo.

            Gift biasa biasanya tidak memiliki
            repeatEnd=false sehingga langsung
            diproses.
          */

          if (
            event?.repeatEnd === false ||
            event?.repeat_end === false
          ) {
            console.log(
              "[Gift] Combo masih berjalan - menunggu event terakhir."
            );

            return;
          }

          addCoinsFromGift(event);

        } catch (error) {
          console.error(
            "[TikTok] Gift handler error:",
            error
          );
        }
      }
    );

    /* =====================================================
       CONNECT WITH TIMEOUT
       ===================================================== */

    let timeoutHandle;

    const timeoutPromise =
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `Timeout ${CONNECT_TIMEOUT / 1000} detik. ` +
              `Server tidak menerima koneksi TikTok.`
            )
          );
        }, CONNECT_TIMEOUT);
      });

    await Promise.race([
      liveClient.connect(),
      timeoutPromise
    ]);

    clearTimeout(timeoutHandle);

    /*
      Jangan langsung menganggap connected
      hanya karena Promise selesai.

      Event connected tetap menjadi indikator utama.

      Property connected digunakan sebagai fallback.
    */

    if (liveClient.connected) {
      liveConnected = true;
      connecting = false;
      lastLiveError = null;

      console.log(
        `[TikTok] Connection confirmed @${TIKTOK_USERNAME}`
      );

      emitLiveStatus(
        "connected",
        `Terhubung ke @${TIKTOK_USERNAME}`
      );
    }

  } catch (error) {
    liveConnected = false;
    connecting = false;

    const message =
      error?.message ||
      error?.error ||
      String(error);

    lastLiveError = message;

    console.error("");
    console.error(
      "[TikTok] CONNECTION ERROR:"
    );

    console.error(
      message
    );

    console.error("");

    emitLiveStatus(
      "error",
      `Gagal terhubung: ${message}`
    );

    scheduleReconnect();
  }
}

/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on(
  "connection",
  (socket) => {
    console.log(
      `[Socket] Browser connected: ${socket.id}`
    );

    /* -------------------------------------------------------
       AUCTION STATE
       ------------------------------------------------------- */

    socket.emit(
      "auction:state",
      getAuctionState()
    );

    /* -------------------------------------------------------
       LIVE STATUS
       ------------------------------------------------------- */

    socket.emit(
      "live:status",
      {
        connected: liveConnected,
        connecting,
        status: liveConnected
          ? "connected"
          : connecting
            ? "connecting"
            : "disconnected",
        username: TIKTOK_USERNAME,
        message: liveConnected
          ? `Terhubung ke @${TIKTOK_USERNAME}`
          : lastLiveError || "",
        error: lastLiveError
      }
    );

    /* =======================================================
       START
       ======================================================= */

    socket.on(
      "auction:start",
      () => {
        auctionRunning = true;
        auctionPaused = false;
        auctionFinished = false;

        console.log(
          "[Auction] START"
        );

        emitAuctionState();
      }
    );

    /* =======================================================
       PAUSE
       ======================================================= */

    socket.on(
      "auction:pause",
      () => {
        if (
          !auctionRunning ||
          auctionFinished
        ) {
          return;
        }

        auctionPaused = true;

        console.log(
          "[Auction] PAUSE"
        );

        emitAuctionState();
      }
    );

    /* =======================================================
       RESUME
       ======================================================= */

    socket.on(
      "auction:resume",
      () => {
        if (
          !auctionRunning ||
          auctionFinished
        ) {
          return;
        }

        auctionPaused = false;

        console.log(
          "[Auction] RESUME"
        );

        emitAuctionState();
      }
    );

    /* =======================================================
       RESET
       ======================================================= */

    socket.on(
      "auction:reset",
      () => {
        resetAuction();
      }
    );

    /* =======================================================
       FINISH
       ======================================================= */

    socket.on(
      "auction:finish",
      () => {
        if (!auctionRunning) {
          return;
        }

        auctionFinished = true;
        auctionPaused = false;

        console.log(
          "[Auction] FINISH"
        );

        emitAuctionState();
      }
    );

    /* =======================================================
       MANUAL TIKTOK CONNECT
       ======================================================= */

    socket.on(
      "live:connect",
      async () => {
        console.log(
          `[Socket] Manual TikTok connect requested by ${socket.id}`
        );

        await connectToLive();
      }
    );

    /* =======================================================
       MANUAL STATUS
       ======================================================= */

    socket.on(
      "live:status:request",
      () => {
        socket.emit(
          "live:status",
          {
            connected: liveConnected,
            connecting,
            status: liveConnected
              ? "connected"
              : connecting
                ? "connecting"
                : "disconnected",
            username: TIKTOK_USERNAME,
            message:
              lastLiveError ||
              (
                liveConnected
                  ? `Terhubung ke @${TIKTOK_USERNAME}`
                  : "Belum terhubung"
              ),
            error: lastLiveError
          }
        );
      }
    );

    /* =======================================================
       BROWSER DISCONNECT
       ======================================================= */

    socket.on(
      "disconnect",
      () => {
        console.log(
          `[Socket] Browser disconnected: ${socket.id}`
        );
      }
    );
  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      version:
        "22.0.0",

      package:
        "tiktok-live-api@1.4.9",

      tiktokUsername:
        TIKTOK_USERNAME,

      tiktokConnected:
        liveConnected,

      tiktokConnecting:
        connecting,

      tiktokStatus:
        liveConnected
          ? "connected"
          : connecting
            ? "connecting"
            : "disconnected",

      tiktokError:
        lastLiveError,

      /*
        DIAGNOSTIC GIFT
      */

      giftEventsReceived,

      giftEventsProcessed,

      giftCoinsAdded,

      lastGiftAt,

      lastGift,

      /*
        AUCTION
      */

      auctionRunning,

      auctionPaused,

      auctionFinished,

      participants:
        participants.size
    });
  }
);

/* =========================================================
   START SERVER
   ========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      " TIKTOK LIVE COIN AUCTION V22"
    );

    console.log(
      "========================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `TikTok: @${TIKTOK_USERNAME}`
    );

    console.log(
      `TikTok Live API: 1.4.9`
    );

    console.log(
      `TikTool API Key: ${
        TIKTOOL_API_KEY
          ? "CONFIGURED"
          : "MISSING"
      }`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      "Gift listener: ENABLED"
    );

    console.log(
      "========================================"
    );

    /*
      Tunggu server siap sebelum koneksi.
    */

    setTimeout(
      () => {
        connectToLive();
      },
      1500
    );
  }
);

/* =========================================================
   PROCESS ERROR
   ========================================================= */

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[Process] uncaughtException:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[Process] unhandledRejection:",
      reason
    );
  }
);

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdown(signal) {
  console.log(
    `[Process] ${signal} received. Shutting down...`
  );

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  try {
    if (liveClient) {
      await liveClient.disconnect();
    }
  } catch (error) {
    console.error(
      "[TikTok] Disconnect error:",
      error
    );
  }

  server.close(
    () => {
      console.log(
        "[Server] Closed."
      );

      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);
