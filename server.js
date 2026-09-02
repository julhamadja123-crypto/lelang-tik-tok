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

function getUsername(event) {
  return (
    event?.user?.uniqueId ||
    event?.user?.unique_id ||
    event?.user?.uniqueIdString ||
    ""
  )
    .toString()
    .replace(/^@/, "")
    .trim();
}

function getNickname(event) {
  return (
    event?.user?.nickname ||
    event?.user?.displayName ||
    getUsername(event)
  )
    .toString()
    .trim();
}

function getGiftId(event) {
  const transactionId = event?.transactionId;

  if (
    transactionId !== undefined &&
    transactionId !== null &&
    String(transactionId).trim() !== ""
  ) {
    return `tx:${String(transactionId)}`;
  }

  const msgId = event?.msgId;

  if (
    msgId !== undefined &&
    msgId !== null &&
    String(msgId).trim() !== ""
  ) {
    return `msg:${String(msgId)}`;
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
    live:connect dipertahankan agar kompatibel
    dengan app.js lama.
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
  io.emit("auction:state", getAuctionState());
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

  emitAuctionState();

  console.log("[Auction] RESET");
}

/* =========================================================
   ADD COINS
   ========================================================= */

function addCoinsFromGift(event) {
  if (!auctionRunning || auctionPaused || auctionFinished) {
    return;
  }

  const username = getUsername(event);

  if (!username) {
    console.log("[Gift] username kosong");
    return;
  }

  /* -------------------------------------------------------
     DEDUP
     ------------------------------------------------------- */

  const giftEventId = getGiftId(event);

  if (giftEventId) {
    if (processedGiftIds.has(giftEventId)) {
      console.log(
        `[Gift] DUPLICATE ignored: ${giftEventId}`
      );

      return;
    }

    processedGiftIds.set(
      giftEventId,
      Date.now()
    );
  }

  /* -------------------------------------------------------
     GIFT DATA
     ------------------------------------------------------- */

  const giftName = (
    event?.giftName || "Unknown Gift"
  ).toString();

  const diamondCount = Math.max(
    0,
    safeNumber(event?.diamondCount, 0)
  );

  const repeatCount = Math.max(
    1,
    safeNumber(event?.repeatCount, 1)
  );

  /*
    Contoh:

    1 diamond x 1 = 1
    1 diamond x 3 = 3
    5 diamond x 3 = 15
  */

  const coinsAdded =
    diamondCount * repeatCount;

  if (coinsAdded <= 0) {
    console.log(
      `[Gift] ignored: ${giftName} nilai 0`
    );

    return;
  }

  const nickname = getNickname(event);

  let participant = participants.get(username);

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
  }

  participant.nickname =
    nickname || participant.nickname;

  participant.coins += coinsAdded;
  participant.lastGiftAt = Date.now();

  console.log(
    `[Gift] @${username} | ${giftName} | ` +
    `${diamondCount} x ${repeatCount} = +${coinsAdded} | ` +
    `TOTAL=${participant.coins}`
  );

  /*
    Hanya update leaderboard.
    Tidak ada notif gift.
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
    `[TikTok] API Key: CONFIGURED`
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
       CONNECTED EVENT
       ===================================================== */

    liveClient.on("connected", () => {
      liveConnected = true;
      connecting = false;
      lastLiveError = null;

      console.log(
        `\n[TikTok] =================================`
      );

      console.log(
        `[TikTok] CONNECTED @${TIKTOK_USERNAME}`
      );

      console.log(
        `[TikTok] LIVE EVENT STREAM AKTIF`
      );

      console.log(
        `[TikTok] =================================\n`
      );

      emitLiveStatus(
        "connected",
        `Terhubung ke TikTok LIVE @${TIKTOK_USERNAME}`
      );
    });

    /* =====================================================
       ERROR EVENT
       ===================================================== */

    liveClient.on("error", (error) => {
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
    });

    /* =====================================================
       DISCONNECTED
       ===================================================== */

    liveClient.on("disconnected", () => {
      liveConnected = false;
      connecting = false;

      console.log(
        `[TikTok] DISCONNECTED @${TIKTOK_USERNAME}`
      );

      emitLiveStatus(
        "disconnected",
        `Koneksi TikTok terputus. Mencoba menghubungkan kembali...`
      );

      scheduleReconnect();
    });

    /* =====================================================
       STREAM END
       ===================================================== */

    liveClient.on("streamEnd", (event) => {
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
    });

    /* =====================================================
       GIFT
       ===================================================== */

    liveClient.on("gift", (event) => {
      try {
        /*
          Gift streak:

          repeatEnd === false
          berarti combo belum selesai.

          Jangan proses dulu.

          Event terakhir akan membawa total
          repeatCount.
        */

        if (event?.repeatEnd === false) {
          return;
        }

        addCoinsFromGift(event);

      } catch (error) {
        console.error(
          "[TikTok] Gift handler error:",
          error
        );
      }
    });

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
      Jangan langsung menganggap connected hanya
      karena Promise selesai.

      Event "connected" adalah penentu utama.

      Tetapi untuk kompatibilitas beberapa versi SDK,
      gunakan property connected sebagai fallback.
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

    console.error(
      "\n[TikTok] CONNECTION ERROR:"
    );

    console.error(
      message
    );

    console.error(
      ""
    );

    emitLiveStatus(
      "error",
      `Gagal terhubung: ${message}`
    );

    /*
      Jangan langsung reconnect terlalu cepat.
    */

    scheduleReconnect();
  }
}

/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on("connection", (socket) => {
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

  socket.on("auction:start", () => {
    auctionRunning = true;
    auctionPaused = false;
    auctionFinished = false;

    console.log("[Auction] START");

    emitAuctionState();
  });

  /* =======================================================
     PAUSE
     ======================================================= */

  socket.on("auction:pause", () => {
    if (!auctionRunning || auctionFinished) {
      return;
    }

    auctionPaused = true;

    console.log("[Auction] PAUSE");

    emitAuctionState();
  });

  /* =======================================================
     RESUME
     ======================================================= */

  socket.on("auction:resume", () => {
    if (!auctionRunning || auctionFinished) {
      return;
    }

    auctionPaused = false;

    console.log("[Auction] RESUME");

    emitAuctionState();
  });

  /* =======================================================
     RESET
     ======================================================= */

  socket.on("auction:reset", () => {
    resetAuction();
  });

  /* =======================================================
     FINISH
     ======================================================= */

  socket.on("auction:finish", () => {
    if (!auctionRunning) {
      return;
    }

    auctionFinished = true;
    auctionPaused = false;

    console.log("[Auction] FINISH");

    emitAuctionState();
  });

  /* =======================================================
     MANUAL TIKTOK CONNECT
     ======================================================= */

  socket.on("live:connect", async () => {
    console.log(
      `[Socket] Manual TikTok connect requested by ${socket.id}`
    );

    await connectToLive();
  });

  /* =======================================================
     MANUAL STATUS
     ======================================================= */

  socket.on("live:status:request", () => {
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
          (liveConnected
            ? `Terhubung ke @${TIKTOK_USERNAME}`
            : "Belum terhubung"),
        error: lastLiveError
      }
    );
  });

  /* =======================================================
     BROWSER DISCONNECT
     ======================================================= */

  socket.on("disconnect", () => {
    console.log(
      `[Socket] Browser disconnected: ${socket.id}`
    );
  });
});

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "tiktok-live-coin-auction",
    version: "21.0.0",

    tiktokUsername: TIKTOK_USERNAME,

    tiktokConnected: liveConnected,
    tiktokConnecting: connecting,

    tiktokStatus: liveConnected
      ? "connected"
      : connecting
        ? "connecting"
        : "disconnected",

    tiktokError: lastLiveError,

    auctionRunning,
    auctionPaused,
    auctionFinished,

    participants: participants.size
  });
});

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
      " TIKTOK LIVE COIN AUCTION"
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
      "========================================"
    );

    /*
      Tunggu server siap.
    */

    setTimeout(() => {
      connectToLive();
    }, 1500);
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
    clearTimeout(reconnectTimer);
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

  server.close(() => {
    console.log(
      "[Server] Closed."
    );

    process.exit(0);
  });
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
