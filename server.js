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
  process.env.TIKTOK_USERNAME ||
  "hamstillearn"
).replace(/^@/, "").trim();

const TIKTOOL_API_KEY = (
  process.env.TIKTOOL_API_KEY || ""
).trim();

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionRunning = false;
let auctionPaused = false;
let auctionFinished = false;

const participants = new Map();

/*
  Struktur:
  username -> {
    username,
    nickname,
    coins,
    lastGiftAt
  }
*/

/* =========================================================
   DEDUP
   ========================================================= */

/*
  PENTING:
  Jangan menggunakan:
  username + giftName + timestamp

  Karena itu dapat menyebabkan 2 gift asli dianggap duplikat.

  Prioritas ID:
  1. transactionId
  2. msgId

  ID yang sudah diproses disimpan sementara.
*/

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
  ).toString().replace(/^@/, "").trim();
}

function getNickname(event) {
  return (
    event?.user?.nickname ||
    event?.user?.displayName ||
    getUsername(event)
  ).toString().trim();
}

function getGiftId(event) {
  /*
    transactionId adalah ID terbaik untuk gift.
    msgId digunakan sebagai fallback.
  */

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
    console.log("[Gift] Ignored: username kosong");
    return;
  }

  /*
    Ambil ID asli dari TikTok/TikTool.
  */

  const giftEventId = getGiftId(event);

  /*
    Jika ada ID asli, lakukan dedup.
  */

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

  const giftName = (
    event?.giftName ||
    "Unknown Gift"
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
    1 TikTok coin/diamond = 1 coin auction.

    Untuk gift streak:
      diamondCount = nilai 1 gift
      repeatCount  = jumlah gift dalam combo

    Contoh:
      1 coin x 3 repeat = 3 auction coins
      5 coin x 3 repeat = 15 auction coins
  */

  const coinsAdded =
    diamondCount * repeatCount;

  if (coinsAdded <= 0) {
    console.log(
      `[Gift] Ignored: ${giftName} memiliki nilai 0`
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
    `[Gift] @${username} -> ${giftName} | ` +
    `${diamondCount} x ${repeatCount} = +${coinsAdded} coins | ` +
    `TOTAL=${participant.coins}`
  );

  /*
    HANYA kirim state lelang.
    Tidak ada event gift notification.
  */

  emitAuctionState();
}

/* =========================================================
   TIKTOK LIVE
   ========================================================= */

let liveClient = null;
let liveConnected = false;
let connecting = false;

async function connectToLive() {
  if (connecting) {
    return;
  }

  if (liveConnected && liveClient) {
    return;
  }

  if (!TIKTOOL_API_KEY) {
    const message =
      "TIKTOOL_API_KEY belum diisi di Railway Environment Variables.";

    console.error("[TikTok]", message);

    io.emit("live:connect", {
      success: false,
      username: TIKTOK_USERNAME,
      error: message
    });

    return;
  }

  connecting = true;

  console.log(
    `[TikTok] Connecting to @${TIKTOK_USERNAME}...`
  );

  try {
    if (liveClient) {
      try {
        await liveClient.disconnect();
      } catch (_) {}
    }

    /*
      Managed WebSocket TikTool.

      Tidak memakai:
      - tiktok-live-connector
      - Euler signature endpoint
      - /webcast/im/fetch
    */

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

    liveClient.on("connected", () => {
      liveConnected = true;

      console.log(
        `[TikTok] CONNECTED @${TIKTOK_USERNAME}`
      );

      io.emit("live:connect", {
        success: true,
        username: TIKTOK_USERNAME
      });
    });

    /* =====================================================
       DISCONNECTED
       ===================================================== */

    liveClient.on("disconnected", () => {
      liveConnected = false;

      console.log(
        `[TikTok] DISCONNECTED @${TIKTOK_USERNAME}`
      );

      io.emit("live:disconnect", {
        username: TIKTOK_USERNAME
      });
    });

    /* =====================================================
       GIFT
       ===================================================== */

    liveClient.on("gift", (event) => {
      try {
        /*
          TikTok gift streak:

          repeatEnd = false
             -> JANGAN proses

          repeatEnd = true
             -> proses total combo

          Gift biasa:
             repeatEnd biasanya true / tidak ada
             -> tetap proses
        */

        const giftType = safeNumber(
          event?.giftType,
          0
        );

        const repeatEnd = event?.repeatEnd;

        /*
          giftType 1 = streak/combo.

          Hanya event terakhir yang dihitung.
        */

        if (
          giftType === 1 &&
          repeatEnd === false
        ) {
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

    /*
      PENTING:
      Tidak memasang handler untuk:
      chat
      like
      member
      follow
      share
      roomUserSeq

      Jadi event-event tersebut tidak masuk
      ke dashboard auction.
    */

    await liveClient.connect();

    liveConnected = true;

  } catch (error) {
    liveConnected = false;

    const message =
      error?.message ||
      String(error);

    console.error(
      "[TikTok] CONNECTION ERROR:",
      message
    );

    io.emit("live:connect", {
      success: false,
      username: TIKTOK_USERNAME,
      error: message
    });

  } finally {
    connecting = false;
  }
}

/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on("connection", (socket) => {
  console.log(
    `[Socket] Browser connected: ${socket.id}`
  );

  /*
    Kirim kondisi saat ini.
  */

  socket.emit(
    "auction:state",
    getAuctionState()
  );

  socket.emit(
    "live:status",
    {
      connected: liveConnected,
      username: TIKTOK_USERNAME
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
     MANUAL CONNECT
     ======================================================= */

  socket.on("live:connect", async () => {
    await connectToLive();
  });

  /* =======================================================
     DISCONNECT BROWSER
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
    version: "20.0.0",
    tiktokUsername: TIKTOK_USERNAME,
    tiktokConnected: liveConnected,
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
  async () => {
    console.log("========================================");
    console.log(" TikTok LIVE COIN AUCTION");
    console.log("========================================");
    console.log(`Port: ${PORT}`);
    console.log(
      `TikTok: @${TIKTOK_USERNAME}`
    );
    console.log(
      `TikTool API Key: ${
        TIKTOOL_API_KEY ? "CONFIGURED" : "MISSING"
      }`
    );
    console.log("========================================");

    /*
      Tunggu sebentar agar server benar-benar siap
      sebelum membuka koneksi TikTok.
    */

    setTimeout(() => {
      connectToLive();
    }, 1000);
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
   ========================================================= */

process.on("uncaughtException", (error) => {
  console.error(
    "[Process] uncaughtException:",
    error
  );
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "[Process] unhandledRejection:",
    reason
  );
});

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdown(signal) {
  console.log(
    `[Process] ${signal} received. Shutting down...`
  );

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
