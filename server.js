/* =========================================================
   TIKTOK LIVE COIN AUCTION
   SERVER.JS - FINAL
   Compatible:
   - Node.js >= 20
   - express
   - socket.io
   - tiktok-live-connector 2.4.4

   FITUR:
   - Connect TikTok LIVE
   - Disconnect TikTok LIVE
   - Auto reconnect
   - Gift -> Coin
   - Gift streak aman
   - Duplicate gift protection
   - Peserta auction realtime
   - Mulai / Pause / Reset / Selesai
   - Timer server
   - Hanya menerima gift ketika auction RUNNING
   ========================================================= */

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
   CONFIG
   ========================================================= */

const PORT = process.env.PORT || 3000;

const DEFAULT_USERNAME =
  process.env.TIKTOK_USERNAME || "hamstillearn";

const DEFAULT_DURATION = 50;

const RECONNECT_DELAY = 5000;

const DUPLICATE_TTL = 60 * 1000;

/* =========================================================
   TIKTOK CONNECTOR
   ========================================================= */

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
      "TikTokLiveConnection tidak ditemukan. Pastikan tiktok-live-connector terinstall."
    );
  }

  return TikTokLiveConnection;
}

/* =========================================================
   GLOBAL STATE
   ========================================================= */

let tiktokConnection = null;

let currentUsername = DEFAULT_USERNAME;

let tiktokConnected = false;

let reconnectTimer = null;

let manualDisconnect = false;

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionState = "idle";

/*
   idle
   running
   paused
   finished
*/

let auctionDuration = DEFAULT_DURATION;

let auctionRemaining = DEFAULT_DURATION;

let auctionTimer = null;

/* =========================================================
   PARTICIPANTS
   ========================================================= */

const participants = new Map();

/*
   Struktur:

   userId -> {
      userId,
      uniqueId,
      nickname,
      coins,
      gifts
   }
*/

/* =========================================================
   DUPLICATE GIFT CACHE
   ========================================================= */

const processedGifts = new Map();

/* =========================================================
   UTILITY
   ========================================================= */

function cleanUsername(username) {
  if (!username) {
    return "";
  }

  let value = String(username).trim();

  value = value
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .trim();

  return value;
}

/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {
  const s = String(err?.message || err || "");

  if (
    s.toLowerCase().includes("sign") ||
    s.toLowerCase().includes("signature") ||
    s.toLowerCase().includes("euler") ||
    s.toLowerCase().includes("business plan")
  ) {
    return "Layanan signing TikTok menolak permintaan. Coba koneksi lagi.";
  }

  if (s.includes("404")) {
    return "LIVE atau username TikTok tidak ditemukan. Pastikan @hamstillearn sedang LIVE.";
  }

  return (
    s ||
    "Terjadi kesalahan saat menghubungkan ke TikTok LIVE."
  );
}

/* =========================================================
   NUMBER HELPER
   ========================================================= */

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number >= 0
    ) {
      return number;
    }
  }

  return 0;
}

/* =========================================================
   STATUS
   ========================================================= */

function emitStatus(message, type = "info") {
  io.emit("live:status", {
    connected: tiktokConnected,
    username: currentUsername,
    state: auctionState,
    message,
    type,
    timestamp: Date.now()
  });
}

/* =========================================================
   AUCTION STATE BROADCAST
   ========================================================= */

function emitAuctionState() {
  io.emit("auction:state", {
    state: auctionState,
    remaining: auctionRemaining,
    duration: auctionDuration,
    participants: Array.from(participants.values())
  });
}

/* =========================================================
   PARTICIPANT BROADCAST
   ========================================================= */

function emitParticipants() {
  io.emit(
    "auction:participants",
    Array.from(participants.values())
  );
}

/* =========================================================
   USER DATA
   ========================================================= */

function userData(event) {
  const user =
    event?.user ||
    event?.userInfo ||
    event?.sender ||
    event?.author ||
    {};

  const userId =
    user?.userId ||
    user?.id ||
    event?.userId ||
    event?.uid ||
    event?.senderId ||
    event?.user?.userId ||
    "";

  const uniqueId =
    user?.uniqueId ||
    user?.unique_id ||
    user?.username ||
    event?.uniqueId ||
    event?.unique_id ||
    event?.username ||
    "";

  const nickname =
    user?.nickname ||
    user?.displayName ||
    user?.display_name ||
    event?.nickname ||
    event?.displayName ||
    uniqueId ||
    "TikTok User";

  return {
    userId: String(userId || uniqueId || nickname),
    uniqueId: String(uniqueId || ""),
    nickname: String(nickname || uniqueId || "TikTok User")
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

  /*
     TikTok Live Connector 2.x biasanya memberikan:

     giftId
     repeatCount
     repeatEnd
     diamondCount
     giftName
     giftType
     groupId
     userId
     uniqueId
     nickname
  */

  const giftId =
    event?.giftId ??
    event?.gift?.giftId ??
    event?.gift?.id ??
    event?.giftId;

  const giftName =
    event?.giftName ||
    event?.gift?.giftName ||
    event?.gift?.name ||
    "Gift";

  const diamondCount = firstNumber(
    event?.diamondCount,
    event?.gift?.diamondCount,
    event?.diamond_count,
    event?.gift?.diamond_count
  );

  const repeatCount = Math.max(
    1,
    firstNumber(
      event?.repeatCount,
      event?.repeat_count,
      event?.gift?.repeatCount,
      event?.gift?.repeat_count
    )
  );

  const giftType = firstNumber(
    event?.giftType,
    event?.gift?.giftType,
    event?.gift_type
  );

  const repeatEnd =
    event?.repeatEnd !== undefined
      ? Boolean(event.repeatEnd)
      : event?.repeat_end !== undefined
      ? Boolean(event.repeat_end)
      : event?.gift?.repeatEnd !== undefined
      ? Boolean(event.gift.repeatEnd)
      : true;

  /*
     Gift type 1 = streakable gift.

     Jangan proses event sementara.
     Tunggu event terakhir repeatEnd=true.

     Contoh:
       1 Rose -> repeatCount 1
       2 Rose -> repeatCount 2
       3 Rose -> repeatCount 3

     Hanya event terakhir yang diproses.
  */

  if (
    Number(giftType) === 1 &&
    repeatEnd === false
  ) {
    return null;
  }

  /*
     ID untuk duplicate protection.

     Prioritas:
       msgId
       messageId
       transactionId
       groupId + giftId + userId + repeatCount

  */

  const msgId =
    event?.msgId ||
    event?.messageId ||
    event?.transactionId ||
    event?.transaction_id ||
    event?.groupId ||
    "";

  const fallbackKey = [
    user.userId,
    giftId || "unknown",
    repeatCount,
    diamondCount,
    giftName
  ].join(":");

  const duplicateKey =
    String(msgId || fallbackKey);

  /*
     Nilai coin:

     diamondCount x repeatCount

     Contoh:
       diamondCount 1, repeatCount 3
       = 3 coin
  */

  const coinValue =
    diamondCount * repeatCount;

  return {
    userId: user.userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname,

    giftId: giftId || null,
    giftName,

    diamondCount,
    repeatCount,
    giftType,
    repeatEnd,

    coinValue,

    duplicateKey,

    timestamp: Date.now()
  };
}

/* =========================================================
   DUPLICATE CHECK
   ========================================================= */

function isDuplicateGift(key) {
  if (!key) {
    return false;
  }

  const now = Date.now();

  /*
     Bersihkan cache lama
  */

  for (const [
    storedKey,
    timestamp
  ] of processedGifts.entries()) {
    if (now - timestamp > DUPLICATE_TTL) {
      processedGifts.delete(storedKey);
    }
  }

  if (processedGifts.has(key)) {
    return true;
  }

  processedGifts.set(key, now);

  return false;
}

/* =========================================================
   APPLY GIFT
   ========================================================= */

function applyGift(gift) {
  if (!gift) {
    return;
  }

  if (!gift.userId) {
    return;
  }

  if (gift.coinValue <= 0) {
    return;
  }

  /*
     Hanya gift ketika auction running
  */

  if (auctionState !== "running") {
    return;
  }

  /*
     Duplicate protection
  */

  if (isDuplicateGift(gift.duplicateKey)) {
    return;
  }

  let participant =
    participants.get(gift.userId);

  if (!participant) {
    participant = {
      userId: gift.userId,
      uniqueId: gift.uniqueId,
      nickname: gift.nickname,
      coins: 0,
      gifts: 0
    };

    participants.set(
      gift.userId,
      participant
    );
  }

  /*
     Update participant
  */

  participant.coins += gift.coinValue;

  participant.gifts += gift.repeatCount;

  /*
     Update realtime peserta
  */

  emitParticipants();

  /*
     Tidak mengirim event notifikasi gift
     ke tampilan agar tidak ada kedipan/notifikasi.
  */

  console.log(
    `[GIFT] ${gift.nickname} | ${gift.giftName} | ` +
    `${gift.repeatCount}x | ` +
    `${gift.coinValue} coin`
  );
}

/* =========================================================
   TIKTOK CONNECT
   ========================================================= */

async function connectTikTok(username) {
  username = cleanUsername(username);

  if (!username) {
    throw new Error(
      "Username TikTok belum diisi."
    );
  }

  /*
     Jika masih terhubung ke akun lain,
     putuskan dulu.
  */

  await disconnectTikTok(false);

  currentUsername = username;

  manualDisconnect = false;

  const Connector =
    await loadTikTokConnector();

  /*
     TikTok Live Connector 2.4.4
  */

  const conn = new Connector(
    username,
    {
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

  tiktokConnection = conn;

  /*
     CONNECTED
  */

  conn.on(
    "connected",
    (state) => {
      tiktokConnected = true;

      emitStatus(
        `Terhubung ke TikTok LIVE @${currentUsername}`,
        "success"
      );

      emitAuctionState();

      console.log(
        `[TIKTOK] Connected: @${currentUsername}`
      );
    }
  );

  /*
     GIFT
  */

  conn.on(
    "gift",
    (event) => {
      try {
        /*
           Jangan proses gift jika auction tidak running
        */

        if (auctionState !== "running") {
          return;
        }

        const gift =
          giftData(event);

        if (!gift) {
          return;
        }

        applyGift(gift);
      } catch (error) {
        console.error(
          "[TIKTOK] Gift processing error:",
          error
        );
      }
    }
  );

  /*
     CHAT

     Tidak diteruskan ke UI agar tampilan
     tetap bersih dan tidak berkedip.
  */

  conn.on(
    "chat",
    () => {
      /*
         Sengaja kosong.
      */
    }
  );

  /*
     ERROR
  */

  conn.on(
    "error",
    (error) => {
      console.error(
        "[TIKTOK] Error:",
        error
      );

      tiktokConnected = false;

      emitStatus(
        formatError(error),
        "error"
      );
    }
  );

  /*
     DISCONNECTED
  */

  conn.on(
    "disconnected",
    () => {
      console.log(
        "[TIKTOK] Disconnected"
      );

      tiktokConnected = false;

      emitStatus(
        "Koneksi TikTok LIVE terputus.",
        "warning"
      );

      /*
         Auto reconnect jika bukan disconnect manual
      */

      if (!manualDisconnect) {
        scheduleReconnect();
      }
    }
  );

  /*
     CONNECT
  */

  try {
    emitStatus(
      `Menghubungkan ke @${currentUsername}...`,
      "info"
    );

    await conn.connect();

    return true;
  } catch (error) {
    tiktokConnected = false;

    console.error(
      "[TIKTOK] Connect error:",
      error
    );

    emitStatus(
      formatError(error),
      "error"
    );

    if (!manualDisconnect) {
      scheduleReconnect();
    }

    return false;
  }
}

/* =========================================================
   RECONNECT
   ========================================================= */

function scheduleReconnect() {
  if (manualDisconnect) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(
    async () => {
      reconnectTimer = null;

      if (manualDisconnect) {
        return;
      }

      if (!currentUsername) {
        return;
      }

      console.log(
        `[TIKTOK] Reconnecting @${currentUsername}...`
      );

      await connectTikTok(
        currentUsername
      );
    },
    RECONNECT_DELAY
  );
}

/* =========================================================
   DISCONNECT
   ========================================================= */

async function disconnectTikTok(
  setManual = true
) {
  if (setManual) {
    manualDisconnect = true;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (tiktokConnection) {
    try {
      if (
        typeof tiktokConnection.disconnect ===
        "function"
      ) {
        await tiktokConnection.disconnect();
      }
    } catch (error) {
      console.error(
        "[TIKTOK] Disconnect error:",
        error
      );
    }
  }

  tiktokConnection = null;

  tiktokConnected = false;

  emitStatus(
    "TikTok LIVE tidak terhubung.",
    "info"
  );
}

/* =========================================================
   AUCTION TIMER
   ========================================================= */

function stopAuctionTimer() {
  if (auctionTimer) {
    clearInterval(auctionTimer);
    auctionTimer = null;
  }
}

function startAuctionTimer() {
  stopAuctionTimer();

  auctionTimer = setInterval(
    () => {
      if (
        auctionState !== "running"
      ) {
        return;
      }

      if (auctionRemaining <= 0) {
        auctionRemaining = 0;

        auctionState = "finished";

        stopAuctionTimer();

        emitAuctionState();

        console.log(
          "[AUCTION] Finished"
        );

        return;
      }

      auctionRemaining--;

      emitAuctionState();
    },
    1000
  );
}

/* =========================================================
   AUCTION START
   ========================================================= */

function startAuction(duration) {
  const parsedDuration =
    Number(duration);

  if (
    Number.isFinite(parsedDuration) &&
    parsedDuration > 0
  ) {
    auctionDuration =
      Math.floor(parsedDuration);
  }

  auctionRemaining =
    auctionDuration;

  auctionState = "running";

  emitAuctionState();

  startAuctionTimer();

  console.log(
    `[AUCTION] Started ${auctionDuration}s`
  );
}

/* =========================================================
   AUCTION PAUSE
   ========================================================= */

function pauseAuction() {
  if (
    auctionState !== "running"
  ) {
    return;
  }

  auctionState = "paused";

  stopAuctionTimer();

  emitAuctionState();

  console.log(
    "[AUCTION] Paused"
  );
}

/* =========================================================
   AUCTION RESET
   ========================================================= */

function resetAuction(duration) {
  stopAuctionTimer();

  const parsedDuration =
    Number(duration);

  if (
    Number.isFinite(parsedDuration) &&
    parsedDuration > 0
  ) {
    auctionDuration =
      Math.floor(parsedDuration);
  }

  auctionRemaining =
    auctionDuration;

  auctionState = "idle";

  /*
     Reset peserta
  */

  participants.clear();

  /*
     Reset duplicate cache
  */

  processedGifts.clear();

  emitParticipants();

  emitAuctionState();

  console.log(
    "[AUCTION] Reset"
  );
}

/* =========================================================
   AUCTION FINISH
   ========================================================= */

function finishAuction() {
  stopAuctionTimer();

  auctionState = "finished";

  auctionRemaining = 0;

  emitAuctionState();

  console.log(
    "[AUCTION] Finished manually"
  );
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
       Kirim kondisi awal
    */

    socket.emit(
      "live:status",
      {
        connected: tiktokConnected,
        username: currentUsername,
        state: auctionState,
        message: tiktokConnected
          ? `Terhubung ke @${currentUsername}`
          : "TikTok LIVE belum terhubung.",
        type: tiktokConnected
          ? "success"
          : "info",
        timestamp: Date.now()
      }
    );

    socket.emit(
      "auction:state",
      {
        state: auctionState,
        remaining: auctionRemaining,
        duration: auctionDuration,
        participants:
          Array.from(
            participants.values()
          )
      }
    );

    socket.emit(
      "auction:participants",
      Array.from(
        participants.values()
      )
    );

    /* =====================================================
       CONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:connect",
      async (data = {}) => {
        const username =
          cleanUsername(
            data.username ||
            currentUsername ||
            DEFAULT_USERNAME
          );

        if (!username) {
          socket.emit(
            "live:status",
            {
              connected: false,
              username: "",
              state: auctionState,
              message:
                "Masukkan username TikTok terlebih dahulu.",
              type: "error",
              timestamp: Date.now()
            }
          );

          return;
        }

        await connectTikTok(
          username
        );
      }
    );

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {
        await disconnectTikTok(true);
      }
    );

    /* =====================================================
       AUCTION STATE
       ===================================================== */

    socket.on(
      "auction:state",
      (data = {}) => {
        const requestedState =
          data.state;

        switch (requestedState) {
          case "running":
            startAuction(
              data.duration
            );
            break;

          case "paused":
            pauseAuction();
            break;

          case "finished":
            finishAuction();
            break;

          case "idle":
            resetAuction(
              data.duration
            );
            break;

          default:
            console.log(
              "[AUCTION] Unknown state:",
              requestedState
            );
        }
      }
    );

    /* =====================================================
       MULAI
       ===================================================== */

    socket.on(
      "auction:start",
      (data = {}) => {
        startAuction(
          data.duration
        );
      }
    );

    /* =====================================================
       PAUSE
       ===================================================== */

    socket.on(
      "auction:pause",
      () => {
        pauseAuction();
      }
    );

    /* =====================================================
       RESET
       ===================================================== */

    socket.on(
      "auction:reset",
      (data = {}) => {
        resetAuction(
          data.duration
        );
      }
    );

    /* =====================================================
       SELESAI
       ===================================================== */

    socket.on(
      "auction:finish",
      () => {
        finishAuction();
      }
    );

    /* =====================================================
       CLIENT DISCONNECT
       ===================================================== */

    socket.on(
      "disconnect",
      () => {
        console.log(
          `[SOCKET] Client disconnected: ${socket.id}`
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
    res.json({
      ok: true,

      server: "tiktok-live-coin-auction",

      tiktok: {
        connected: tiktokConnected,
        username: currentUsername
      },

      auction: {
        state: auctionState,
        remaining: auctionRemaining,
        duration: auctionDuration
      },

      participants:
        participants.size,

      uptime:
        process.uptime(),

      timestamp:
        Date.now()
    });
  }
);

/* =========================================================
   API STATUS
   ========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      connected: tiktokConnected,
      username: currentUsername,

      auction: {
        state: auctionState,
        remaining: auctionRemaining,
        duration: auctionDuration
      },

      participants:
        Array.from(
          participants.values()
        )
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
      __dirname + "/index.html"
    );
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
   ========================================================= */

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[PROCESS] Uncaught Exception:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "[PROCESS] Unhandled Rejection:",
      error
    );
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
      "================================================="
    );

    console.log(
      " TIKTOK LIVE COIN AUCTION SERVER"
    );

    console.log(
      "================================================="
    );

    console.log(
      `Port      : ${PORT}`
    );

    console.log(
      `Username  : @${currentUsername}`
    );

    console.log(
      `Auction   : ${auctionState}`
    );

    console.log(
      "TikTok    : tiktok-live-connector 2.4.4"
    );

    console.log(
      "================================================="
    );
  }
);
