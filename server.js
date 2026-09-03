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

app.use(express.static(__dirname));

/* =========================================================
   TIKTOK CONNECTION
   BAGIAN INI DIPERTAHANKAN
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
let participants = new Map();
let participantVersion = 0;

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

  const mod = await import("tiktok-live-connector");

  // tiktok-live-connector 2.4.4 is ESM-only.
  // The official export is the named TikTokLiveConnection export.
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
    s.includes("sign") ||
    s.includes("signature") ||
    s.includes("euler") ||
    s.includes("business plan") ||
    s.includes("api key") ||
    s.includes("401") ||
    s.includes("403") ||
    s.includes("404")
  ) {
    return "Server signing TikTok tidak dapat membuat token WebSocket. Coba lagi; jika berulang, gunakan SIGN_API_KEY di environment.";
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

  const userId =
    user.userId ||
    user.id ||
    event?.userId ||
    event?.user_id ||
    "unknown";

  const uniqueId =
    user.uniqueId ||
    event?.uniqueId ||
    event?.nickname ||
    "Viewer";

  const nickname =
    user.nickname ||
    event?.nickname ||
    user.uniqueId ||
    event?.uniqueId ||
    "Viewer";

  const avatar =
    user.profilePictureUrl ||
    user.profilePicture?.url ||
    user.profilePicture?.urls?.[0] ||
    event?.profilePictureUrl ||
    event?.profilePicture ||
    null;

  return {
    userId: String(userId),
    uniqueId: String(uniqueId),
    nickname: String(nickname),
    avatar
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
     DIAMOND COUNT
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

  const rawRepeatCount =
    event.repeatCount ??
    event.repeat_count ??
    event.gift?.repeatCount ??
    event.gift?.repeat_count ??
    1;

  let repeatCount = Number(rawRepeatCount);

  if (
    !Number.isFinite(repeatCount) ||
    repeatCount < 1
  ) {
    repeatCount = 1;
  }

  repeatCount = Math.floor(repeatCount);

  /* -------------------------------------------------------
     GIFT TYPE
     ------------------------------------------------------- */

  const giftTypeRaw =
    event.giftType ??
    event.gift_type ??
    event.gift?.giftType ??
    event.gift?.gift_type ??
    event.giftDetails?.giftType ??
    event.giftDetails?.gift_type ??
    0;

  const giftType = Number(giftTypeRaw) || 0;

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

  /* -------------------------------------------------------
     VALIDASI DASAR
     ------------------------------------------------------- */

  if (!giftId) {
    console.log(
      "[GIFT] Diabaikan: giftId tidak ditemukan."
    );

    return null;
  }

  if (diamondCount <= 0) {
    console.log(
      `[GIFT] ${giftName} diabaikan: diamondCount tidak valid.`
    );

    return null;
  }

  /* -------------------------------------------------------
     GIFT STREAK
     
     giftType = 1 biasanya merupakan streak gift.
     Hanya proses saat repeatEnd supaya tidak dihitung
     berkali-kali.
     ------------------------------------------------------- */

  if (giftType === 1 && !repeatEnd) {
    console.log(
      `[GIFT] Streak sementara diabaikan: @${user.uniqueId} | ${giftName} | x${repeatCount}`
    );

    return null;
  }

  /* -------------------------------------------------------
     COIN VALUE
     ------------------------------------------------------- */

  const coinValue =
    diamondCount * repeatCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  /* =======================================================
     DUPLICATE PROTECTION
     ======================================================= */

  const msgId =
    event.msgId ||
    event.msg_id ||
    null;

  const transactionId =
    event.transactionId ||
    event.transaction_id ||
    null;

  const groupId =
    event.groupId ||
    event.group_id ||
    null;

  const createTime =
    event.createTime ||
    event.create_time ||
    event.timestamp ||
    null;

  /*
   * Prioritas ID:
   *
   * 1. transactionId
   * 2. msgId
   * 3. groupId + user + gift + repeatCount
   * 4. fallback event signature
   */

  let eventKey;

  if (transactionId) {
    eventKey = `transaction:${transactionId}`;
  } else if (msgId) {
    eventKey = `msg:${msgId}`;
  } else if (groupId) {
    eventKey =
      `group:${groupId}|${user.userId}|${giftId}|${repeatCount}|${repeatEnd}`;
  } else {
    eventKey =
      `fallback:${user.userId}|${user.uniqueId}|${giftId}|${repeatCount}|${createTime}|${repeatEnd}`;
  }

  /* -------------------------------------------------------
     CLEAN OLD EVENTS
     ------------------------------------------------------- */

  const now = Date.now();

  for (const [key, time] of processedGiftEvents.entries()) {
    if (now - time > GIFT_TTL) {
      processedGiftEvents.delete(key);
    }
  }

  /* -------------------------------------------------------
     DUPLICATE CHECK
     ------------------------------------------------------- */

  if (processedGiftEvents.has(eventKey)) {
    console.log(
      `[GIFT] DUPLICATE diabaikan: ${eventKey}`
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  /* -------------------------------------------------------
     LOG
     ------------------------------------------------------- */

  console.log(
    `[GIFT] @${user.uniqueId} | ${giftName} | ${diamondCount} x ${repeatCount} = ${coinValue}`
  );

  /* -------------------------------------------------------
     RETURN
     ------------------------------------------------------- */

  return {
    username: user.uniqueId,
    nickname: user.nickname,

    userId: user.userId,
    uniqueId: user.uniqueId,

    giftName,
    giftId,

    diamondCount,
    repeatCount,

    coinValue,

    giftType,
    repeatEnd,

    msgId,
    transactionId,
    groupId,

    avatar: user.avatar
  };
}

/* =========================================================
   STOP TIKTOK CONNECTION
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
   CONNECT TIKTOK LIVE
   BAGIAN KONEKSI DIPERTAHANKAN
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
    "[TikTok] MODE TANPA API KEY"
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /* -------------------------------------------------------
     CONNECTION OPTIONS
     TETAP SEPERTI VERSI SEBELUMNYA
     ------------------------------------------------------- */

  // Gunakan constructor/options yang kompatibel dengan tiktok-live-connector 2.4.4.
  // Hindari override HTTP/WebSocket yang tidak diperlukan agar koneksi standar
  // connector + signing fallback tetap digunakan.
  const signApiKey =
    String(process.env.SIGN_API_KEY || "").trim() || undefined;

  const connOptions = {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: true,

    // tiktok-live-connector 2.4.4 supports the free signing route
    // without a key. If SIGN_API_KEY exists, use it automatically.
    ...(signApiKey ? { signApiKey } : {}),

    webClientOptions: {
      timeout: {
        request: Number(process.env.TIKTOK_CLIENT_TIMEOUT) || 15000
      }
    },

    wsClientOptions: {
      handshakeTimeout:
        Number(process.env.WS_CONNECT_TIMEOUT_MS) || 20000
    }
  };

  const conn = new Connector(username, connOptions);

  liveConnection = conn;

  /* =======================================================
     GIFT EVENT
     ======================================================= */

  conn.on("gift", (event) => {
    console.log(
      `[TikTok Gift Event] @${userData(event).uniqueId}`
    );

    /* -----------------------------------------------------
       LELELANG HARUS AKTIF
       ----------------------------------------------------- */

    if (!auctionActive) {
      console.log(
        "[GIFT] diabaikan karena lelang tidak aktif"
      );

      return;
    }

    /* -----------------------------------------------------
       PARSE GIFT
       ----------------------------------------------------- */

    const gift =
      giftData(event);

    if (!gift) {
      console.log(
        "[GIFT] event diterima tetapi gift tidak valid/complete"
      );

      return;
    }

    /* =====================================================
       PARTICIPANT KEY
       ===================================================== */

    let key;

    if (
      gift.userId &&
      gift.userId !== "unknown"
    ) {
      key = `id:${gift.userId}`;
    } else if (
      gift.uniqueId
    ) {
      key = `unique:${gift.uniqueId.toLowerCase()}`;
    } else if (
      gift.username
    ) {
      key = `username:${gift.username.toLowerCase()}`;
    } else {
      key = `name:${gift.nickname.toLowerCase()}`;
    }

    /* -----------------------------------------------------
       PARTICIPANT SEBELUMNYA
       ----------------------------------------------------- */

    const previous =
      participants.get(key);

    /* -----------------------------------------------------
       COIN SEBELUMNYA
       ----------------------------------------------------- */

    const previousCoins =
      Number(previous?.coins) || 0;

    /* -----------------------------------------------------
       COIN GIFT
       ----------------------------------------------------- */

    const giftCoins =
      Number(gift.coinValue) || 0;

    /* -----------------------------------------------------
       TOTAL COIN
       ----------------------------------------------------- */

    const totalCoins =
      previousCoins + giftCoins;

    /* -----------------------------------------------------
       PARTICIPANT BARU / UPDATE
       ----------------------------------------------------- */

    const participant = {
      userId:
        gift.userId ||
        previous?.userId ||
        "unknown",

      uniqueId:
        gift.uniqueId ||
        previous?.uniqueId ||
        gift.username ||
        key,

      username:
        gift.username ||
        previous?.username ||
        gift.uniqueId ||
        key,

      nickname:
        gift.nickname ||
        previous?.nickname ||
        gift.username ||
        "Viewer",

      avatar:
        gift.avatar ||
        previous?.avatar ||
        null,

      coins:
        totalCoins,

      joinedAt:
        previous?.joinedAt ||
        Date.now()
    };

    /* -----------------------------------------------------
       SIMPAN PESERTA
       ----------------------------------------------------- */

    participants.set(
      key,
      participant
    );

    participantVersion += 1;

    /* =====================================================
       PAYLOAD GIFT
       ===================================================== */

    const payload = {
      ...gift,

      participant,

      version:
        participantVersion
    };

    /* -----------------------------------------------------
       LOG
       ----------------------------------------------------- */

    console.log(
      "------------------------------------------------"
    );

    console.log(
      `[AUCTION] PESERTA: ${participant.nickname}`
    );

    console.log(
      `[AUCTION] GIFT: ${gift.giftName}`
    );

    console.log(
      `[AUCTION] GIFT COIN: ${giftCoins}`
    );

    console.log(
      `[AUCTION] TOTAL COIN: ${participant.coins}`
    );

    console.log(
      `[AUCTION] JUMLAH PESERTA: ${participants.size}`
    );

    console.log(
      "------------------------------------------------"
    );

    /* =====================================================
       KIRIM KE FRONTEND
       ===================================================== */

    /* Gift individual */
    io.emit(
      "live:gift",
      payload
    );

    /* Daftar seluruh peserta */
    io.emit(
      "auction:participants",
      {
        version:
          participantVersion,

        participants:
          Array.from(
            participants.values()
          )
      }
    );

    /* State peserta yang baru berubah */
    io.emit(
      "auction:participant:update",
      {
        version:
          participantVersion,

        participant,

        gift
      }
    );
  });

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on("chat", (event) => {
    io.emit(
      "live:event",
      {
        type: "chat",

        username:
          event?.user?.uniqueId ||
          event?.uniqueId ||
          "Viewer"
      }
    );
  });

  /* =======================================================
     CONNECTED
     ======================================================= */

  conn.on("websocketConnected", () => {
    console.log(
      `[TikTok] WebSocket connected @${username}`
    );
  });

  conn.on("connected", (state) => {
    console.log(
      "[TikTok] connected:",
      state
    );
  });

  /* =======================================================
     ERROR
     ======================================================= */

  conn.on("error", (err) => {
    console.error(
      "[TikTok] error:",
      err
    );

    emitStatus(
      `Error TikTok: ${formatError(err)}`
    );
  });

  /* =======================================================
     DISCONNECTED
     ======================================================= */

  conn.on("disconnected", () => {
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
  });

  /* =======================================================
     CONNECT
     ======================================================= */

  try {
    // Resolve the room first. This makes failures much clearer and
    // avoids relying on connect() to do both room lookup + websocket setup.
    let resolvedRoomId = "";

    try {
      resolvedRoomId = String(
        await conn.fetchRoomId(username)
      );
    } catch (roomErr) {
      console.error(
        "[TikTok] gagal mencari Room ID:",
        roomErr
      );
      throw new Error(
        `Tidak dapat menemukan LIVE @${username}: ${formatError(roomErr)}`
      );
    }

    if (!resolvedRoomId) {
      throw new Error(
        `Room ID @${username} tidak ditemukan. Pastikan akun sedang LIVE.`
      );
    }

    console.log(
      `[TikTok] Room ID ditemukan: ${resolvedRoomId}`
    );

    const state =
      await conn.connect(resolvedRoomId);

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
   SOCKET CONNECTION
   ========================================================= */

io.on("connection", (socket) => {
  console.log(
    `[Socket] Client terhubung: ${socket.id}`
  );

  /* =======================================================
     CONNECTION STATUS
     ======================================================= */

  const connected =
    Boolean(
      liveConnection?.isConnected === true ||
      liveConnection?.state?.isConnected === true
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

  /* =======================================================
     AUCTION STATE
     ======================================================= */

  socket.emit(
    "auction:state",
    {
      state:
        auctionActive
          ? "running"
          : "idle",

      active:
        auctionActive,

      version:
        participantVersion
    }
  );

  /* =======================================================
     SEND CURRENT PARTICIPANTS
     ======================================================= */

  socket.emit(
    "auction:participants",
    {
      version:
        participantVersion,

      participants:
        Array.from(
          participants.values()
        )
    }
  );

  /* =======================================================
     LIVE CONNECT
     ======================================================= */

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

  /* =======================================================
     AUCTION STATE
     ======================================================= */

  socket.on(
    "auction:state",
    (data = {}) => {
      const requestedState =
        String(
          data?.state ||
          (
            data?.active
              ? "running"
              : "idle"
          )
        );

      auctionActive =
        requestedState === "running";

      console.log(
        `[Auction] state=${requestedState} active=${auctionActive}`
      );

      io.emit(
        "auction:state",
        {
          state:
            requestedState,

          active:
            auctionActive,

          version:
            participantVersion
        }
      );
    }
  );

  /* =======================================================
     AUCTION RESET
     ======================================================= */

  socket.on(
    "auction:reset",
    () => {
      participants.clear();

      participantVersion += 1;

      console.log(
        "[Auction] peserta dan coin di-reset"
      );

      /* ---------------------------------------------------
         Bersihkan duplicate protection juga
         supaya gift baru setelah reset bisa diproses.
         --------------------------------------------------- */

      processedGiftEvents.clear();

      io.emit(
        "auction:participants",
        {
          version:
            participantVersion,

          participants: []
        }
      );

      io.emit(
        "auction:participant:update",
        {
          version:
            participantVersion,

          participant: null,

          gift: null,

          reset: true
        }
      );

      auctionActive = false;

      io.emit(
        "auction:state",
        {
          state: "idle",

          active: false,

          version:
            participantVersion
        }
      );
    }
  );

  /* =======================================================
     LIVE DISCONNECT
     ======================================================= */

  socket.on(
    "live:disconnect",
    async () => {
      console.log(
        "[Socket] Disconnect TikTok."
      );

      auctionActive = false;

      await stopConnection();

      activeUsername = null;

      emitStatus(
        "Koneksi TikTok LIVE diputus."
      );
    }
  );

  /* =======================================================
     SOCKET DISCONNECT
     ======================================================= */

  socket.on(
    "disconnect",
    () => {
      console.log(
        `[Socket] Client terputus: ${socket.id}`
      );
    }
  );
});

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
        Boolean(liveConnection?.isConnected === true),

      connecting:
        Boolean(liveConnection?.isConnecting === true),

      username:
        activeUsername,

      auctionActive,

      participantCount:
        participants.size,

      participantVersion,

      apiKeyRequired:
        false
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
   SERVER
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
      `MODE: ${process.env.SIGN_API_KEY ? "SIGN_API_KEY AKTIF" : "SIGNING GRATIS / TANPA API KEY"}`
    );

    console.log(
      "================================================"
    );
  }
);

/* =========================================================
   PROCESS ERROR HANDLER
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
