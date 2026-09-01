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
   TIKTOK LIVE CONNECTOR
   ========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
let manualDisconnect = false;
let auctionActive = false;

/*
 * API KEY DIAMBIL DARI ENVIRONMENT VARIABLE
 *
 * Render:
 * SIGN_API_KEY = API KEY EULER STREAM KAMU
 */
const SIGN_API_KEY = String(process.env.SIGN_API_KEY || "").trim();

const processedGiftEvents = new Map();
const GIFT_TTL = 60 * 1000;

/* =========================================================
   LOAD CONNECTOR
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
   USERNAME
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
    s.includes("sign") ||
    s.includes("signature") ||
    s.includes("euler") ||
    s.includes("business plan") ||
    s.includes("401") ||
    s.includes("403") ||
    s.includes("404")
  ) {
    return "TikTok/signing provider menolak koneksi. Pastikan SIGN_API_KEY di Environment Variables sudah benar.";
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
    (giftId
      ? `Gift #${giftId}`
      : "Gift");

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

  const giftType = Number(
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
   * Gift streak:
   * giftType 1 biasanya harus menunggu repeat selesai.
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
    diamondCount * repeatCount;

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

  const now = Date.now();

  /*
   * Hapus event lama.
   */
  for (const [key, time] of processedGiftEvents) {
    if (
      now - time >
      GIFT_TTL
    ) {
      processedGiftEvents.delete(key);
    }
  }

  /*
   * Hindari gift duplikat.
   */
  if (
    processedGiftEvents.has(eventKey)
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
    username: user.uniqueId,
    nickname: user.nickname,

    giftName,
    giftId,

    diamondCount,
    repeatCount,
    coinValue,

    giftType,
    repeatEnd,

    msgId:
      event.msgId || null,

    transactionId:
      event.transactionId ||
      event.transaction_id ||
      null,

    groupId:
      event.groupId ||
      event.group_id ||
      null,

    avatar: user.avatar
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
   CONNECT TIKTOK LIVE
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

  /*
   * Cek API KEY sebelum koneksi.
   */
  if (!SIGN_API_KEY) {
    throw new Error(
      "SIGN_API_KEY belum diatur. Tambahkan SIGN_API_KEY di Environment Variables hosting kamu."
    );
  }

  /*
   * Putuskan koneksi sebelumnya.
   */
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
    "[TikTok] MODE: SIGN_API_KEY AKTIF"
  );

  console.log(
    `[TikTok] API KEY: ${SIGN_API_KEY.substring(
      0,
      Math.min(6, SIGN_API_KEY.length)
    )}******`
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /*
   * INI BAGIAN PENTING.
   *
   * API key diberikan ke TikTokLiveConnection
   * melalui signApiKey.
   */
  const conn =
    new Connector(username, {
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
    });

  liveConnection = conn;

  /* =====================================================
     GIFT
     ===================================================== */

  conn.on("gift", (event) => {
    if (!auctionActive) {
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
  });

  /* =====================================================
     CHAT
     ===================================================== */

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

  /* =====================================================
     CONNECTED
     ===================================================== */

  conn.on(
    "connected",
    (state) => {
      console.log(
        "[TikTok] connected:",
        state
      );
    }
  );

  /* =====================================================
     ERROR
     ===================================================== */

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

  /* =====================================================
     DISCONNECTED
     ===================================================== */

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

  /* =====================================================
     CONNECT
     ===================================================== */

  try {
    const state =
      await conn.connect();

    /*
     * Pastikan koneksi yang berhasil
     * masih merupakan koneksi aktif.
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

    const connected =
      Boolean(
        liveConnection?.isConnected ||
        liveConnection?.state?.isConnected
      );

    socket.emit(
      "live:status",
      {
        ok: connected,

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

    /* =====================================================
       AUCTION STATE
       ===================================================== */

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

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

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
    res.status(200).json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      connected:
        Boolean(liveConnection),

      username:
        activeUsername,

      auctionActive,

      /*
       * Jangan pernah mengirim API key
       * ke browser.
       */
      apiKeyConfigured:
        Boolean(SIGN_API_KEY)
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
      `SIGN_API_KEY: ${
        SIGN_API_KEY
          ? "TERPASANG"
          : "BELUM TERPASANG"
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
