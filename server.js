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
   TIKTOK
   ========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;
let activeUsername = null;

let reconnectTimer = null;
let manualDisconnect = false;

/*
 * Status lelang hanya digunakan untuk informasi.
 * EVENT GIFT TIDAK LAGI DIBLOKIR DI SERVER KETIKA FALSE.
 */
let auctionActive = false;

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
    s.includes("404")
  ) {
    return "TikTok/signing provider menolak koneksi tanpa API key.";
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
  const user =
    event?.user ||
    event?.userInfo ||
    event?.userDetails ||
    {};

  const uniqueId =
    user.uniqueId ||
    user.unique_id ||
    event?.uniqueId ||
    event?.unique_id ||
    event?.nickname ||
    event?.user?.nickname ||
    "Viewer";

  const nickname =
    user.nickname ||
    user.displayName ||
    event?.nickname ||
    event?.displayName ||
    uniqueId ||
    "Viewer";

  const userId =
    user.userId ||
    user.user_id ||
    user.id ||
    event?.userId ||
    event?.user_id ||
    event?.uid ||
    "unknown";

  const avatar =
    user.profilePictureUrl ||
    user.profilePicture?.url ||
    user.profilePicture?.urls?.[0] ||
    user.avatarLarger ||
    user.avatarMedium ||
    user.avatarThumb ||
    event?.profilePictureUrl ||
    event?.profilePicture ||
    event?.avatar ||
    null;

  return {
    userId: String(userId),
    uniqueId: String(uniqueId),
    nickname: String(nickname),
    avatar
  };
}

/* =========================================================
   GIFT ID
   ========================================================= */

function getGiftId(event) {
  const values = [
    event?.giftId,
    event?.gift_id,

    event?.gift?.giftId,
    event?.gift?.gift_id,
    event?.gift?.id,

    event?.giftDetails?.giftId,
    event?.giftDetails?.gift_id,
    event?.giftDetails?.id,

    event?.giftInfo?.giftId,
    event?.giftInfo?.gift_id,
    event?.giftInfo?.id,

    event?.extendedGiftInfo?.giftId,
    event?.extendedGiftInfo?.gift_id,
    event?.extendedGiftInfo?.id
  ];

  for (const value of values) {
    if (
      value !== null &&
      value !== undefined &&
      String(value) !== ""
    ) {
      return String(value);
    }
  }

  return "";
}

/* =========================================================
   GIFT NAME
   ========================================================= */

function getGiftName(event, giftId) {
  return (
    event?.giftName ||
    event?.gift_name ||

    event?.gift?.giftName ||
    event?.gift?.gift_name ||
    event?.gift?.name ||
    event?.gift?.title ||

    event?.giftDetails?.giftName ||
    event?.giftDetails?.gift_name ||
    event?.giftDetails?.name ||
    event?.giftDetails?.title ||

    event?.giftInfo?.giftName ||
    event?.giftInfo?.gift_name ||
    event?.giftInfo?.name ||
    event?.giftInfo?.title ||

    event?.extendedGiftInfo?.giftName ||
    event?.extendedGiftInfo?.gift_name ||
    event?.extendedGiftInfo?.name ||

    (giftId ? `Gift #${giftId}` : "Gift")
  );
}

/* =========================================================
   DIAMOND COUNT
   ========================================================= */

function getDiamondCount(event) {
  return numberPositive(
    event?.diamondCount,
    event?.diamond_count,
    event?.diamondCost,
    event?.diamond_cost,

    event?.gift?.diamondCount,
    event?.gift?.diamond_count,
    event?.gift?.diamondCost,
    event?.gift?.diamond_cost,
    event?.gift?.diamond,

    event?.giftDetails?.diamondCount,
    event?.giftDetails?.diamond_count,
    event?.giftDetails?.diamondCost,
    event?.giftDetails?.diamond_cost,
    event?.giftDetails?.diamond,

    event?.giftInfo?.diamondCount,
    event?.giftInfo?.diamond_count,
    event?.giftInfo?.diamondCost,
    event?.giftInfo?.diamond_cost,
    event?.giftInfo?.diamond,

    event?.extendedGiftInfo?.diamondCount,
    event?.extendedGiftInfo?.diamond_count,
    event?.extendedGiftInfo?.diamondCost,
    event?.extendedGiftInfo?.diamond_cost,
    event?.extendedGiftInfo?.diamond
  );
}

/* =========================================================
   REPEAT COUNT
   ========================================================= */

function getRepeatCount(event) {
  const value = numberPositive(
    event?.repeatCount,
    event?.repeat_count,

    event?.gift?.repeatCount,
    event?.gift?.repeat_count,

    event?.giftDetails?.repeatCount,
    event?.giftDetails?.repeat_count,

    event?.giftInfo?.repeatCount,
    event?.giftInfo?.repeat_count,

    event?.extendedGiftInfo?.repeatCount,
    event?.extendedGiftInfo?.repeat_count
  );

  if (!value) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

/* =========================================================
   GIFT TYPE
   ========================================================= */

function getGiftType(event) {
  const value =
    event?.giftType ??
    event?.gift_type ??

    event?.gift?.giftType ??
    event?.gift?.gift_type ??

    event?.giftDetails?.giftType ??
    event?.giftDetails?.gift_type ??

    event?.giftInfo?.giftType ??
    event?.giftInfo?.gift_type ??

    0;

  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}

/* =========================================================
   REPEAT END
   ========================================================= */

function getRepeatEnd(event) {
  const value =
    event?.repeatEnd ??
    event?.repeat_end ??

    event?.gift?.repeatEnd ??
    event?.gift?.repeat_end ??

    event?.giftDetails?.repeatEnd ??
    event?.giftDetails?.repeat_end ??

    event?.giftInfo?.repeatEnd ??
    event?.giftInfo?.repeat_end;

  /*
   * Bila properti tidak ada:
   * anggap event sebagai event normal.
   */
  if (
    value === undefined ||
    value === null
  ) {
    return true;
  }

  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}

/* =========================================================
   EVENT ID
   ========================================================= */

function getEventId(event, user, giftId) {
  const directId =
    event?.msgId ||
    event?.msg_id ||
    event?.messageId ||
    event?.message_id ||

    event?.transactionId ||
    event?.transaction_id ||

    event?.eventId ||
    event?.event_id;

  if (directId) {
    return String(directId);
  }

  const groupId =
    event?.groupId ||
    event?.group_id ||
    "";

  const createTime =
    event?.createTime ||
    event?.create_time ||
    event?.timestamp ||
    event?.time ||
    "";

  const repeatCount =
    getRepeatCount(event);

  const repeatEnd =
    getRepeatEnd(event);

  return [
    groupId,
    user.userId,
    giftId,
    repeatCount,
    createTime,
    repeatEnd
  ].join("|");
}

/* =========================================================
   GIFT PARSER
   ========================================================= */

function giftData(event) {
  if (!event) {
    return null;
  }

  const user = userData(event);

  const giftId = getGiftId(event);

  const giftName =
    getGiftName(event, giftId);

  const diamondCount =
    getDiamondCount(event);

  const repeatCount =
    getRepeatCount(event);

  const giftType =
    getGiftType(event);

  const repeatEnd =
    getRepeatEnd(event);

  /*
   * Tipe 1 biasanya merupakan gift streak.
   *
   * Untuk gift streak, hanya event terakhir
   * yang diproses agar tidak terjadi:
   *
   * 1 coin
   * 1 coin
   * 1 coin
   *
   * menjadi 6 atau 9 coin karena event dikirim
   * berkali-kali.
   */
  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    console.log(
      `[GIFT] Streak event menunggu repeatEnd | @${user.uniqueId} | ${giftName} | repeat=${repeatCount}`
    );

    return null;
  }

  /*
   * Jika TikTok tidak memberikan giftId,
   * kita masih coba proses selama diamond
   * tersedia.
   */
  if (diamondCount <= 0) {
    console.warn(
      "[GIFT] Event diterima tetapi diamond tidak ditemukan."
    );

    console.warn(
      "[GIFT] RAW:",
      JSON.stringify(event, null, 2)
    );

    return null;
  }

  const eventKey =
    getEventId(
      event,
      user,
      giftId || giftName
    );

  const now = Date.now();

  /*
   * Bersihkan cache event lama.
   */
  for (const [
    key,
    time
  ] of processedGiftEvents.entries()) {
    if (
      now - time >
      GIFT_TTL
    ) {
      processedGiftEvents.delete(key);
    }
  }

  /*
   * Cegah event yang sama diproses
   * lebih dari satu kali.
   */
  if (
    processedGiftEvents.has(eventKey)
  ) {
    console.log(
      `[GIFT DUPLICATE] @${user.uniqueId} | ${giftName} | ${eventKey}`
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  const coinValue =
    diamondCount *
    repeatCount;

  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {
    return null;
  }

  console.log(
    "================================================"
  );

  console.log(
    `[GIFT] @${user.uniqueId}`
  );

  console.log(
    `[GIFT] Nama     : ${giftName}`
  );

  console.log(
    `[GIFT] Gift ID  : ${giftId || "-"}`
  );

  console.log(
    `[GIFT] Diamond  : ${diamondCount}`
  );

  console.log(
    `[GIFT] Repeat   : ${repeatCount}`
  );

  console.log(
    `[GIFT] Total    : ${coinValue}`
  );

  console.log(
    `[GIFT] Type     : ${giftType}`
  );

  console.log(
    `[GIFT] End      : ${repeatEnd}`
  );

  console.log(
    "================================================"
  );

  return {
    username: user.uniqueId,
    nickname: user.nickname,

    userId: user.userId,

    giftName,
    giftId,

    diamondCount,
    repeatCount,

    coinValue,

    giftType,
    repeatEnd,

    msgId:
      event?.msgId ||
      event?.msg_id ||
      null,

    transactionId:
      event?.transactionId ||
      event?.transaction_id ||
      null,

    groupId:
      event?.groupId ||
      event?.group_id ||
      null,

    avatar: user.avatar,

    /*
     * Status lelang dikirim sebagai informasi.
     * Frontend boleh menentukan apakah gift
     * dimasukkan ke peserta atau tidak.
     */
    auctionActive
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

  const conn =
    liveConnection;

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
    "[TikTok] MODE TANPA API KEY"
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  const conn =
    new Connector(
      username,
      {
        processInitialData: false,

        fetchRoomInfoOnConnect: true,

        /*
         * WAJIB aktif agar informasi gift
         * lebih lengkap.
         */
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

  liveConnection =
    conn;

  /* =======================================================
     GIFT EVENT
     ======================================================= */

  conn.on(
    "gift",
    (event) => {
      /*
       * PENTING:
       *
       * Jangan lagi:
       *
       * if (!auctionActive) return;
       *
       * Server harus tetap menerima event gift.
       */

      console.log(
        `[TikTok] EVENT GIFT diterima @${activeUsername}`
      );

      const gift =
        giftData(event);

      if (!gift) {
        return;
      }

      /*
       * Kirim ke semua client.
       */
      io.emit(
        "live:gift",
        gift
      );

      /*
       * Event tambahan untuk debugging.
       * Tidak perlu ditampilkan di UI.
       */
      io.emit(
        "live:gift_received",
        {
          username:
            gift.username,

          giftName:
            gift.giftName,

          coinValue:
            gift.coinValue,

          auctionActive
        }
      );
    }
  );

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on(
    "chat",
    (event) => {
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
        setTimeout(
          () => {
            if (
              !manualDisconnect &&
              activeUsername
            ) {
              connectToLive(
                activeUsername
              ).catch(
                (err) => {
                  emitStatus(
                    `Reconnect gagal: ${formatError(err)}`
                  );
                }
              );
            }
          },
          5000
        );
    }
  );

  /* =======================================================
     CONNECT
     ======================================================= */

  try {
    const state =
      await conn.connect();

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

        message: connected
          ? `Terhubung ke @${activeUsername}`
          : "Belum terhubung ke TikTok LIVE"
      }
    );

    /* =====================================================
       CONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:connect",
      async (data = {}) => {
        try {
          if (
            !data.username
          ) {
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
       MANUAL DISCONNECT
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
    res.status(200).json({
      ok: true,

      service:
        "tiktok-live-coin-auction",

      connected:
        Boolean(
          liveConnection
        ),

      username:
        activeUsername,

      auctionActive,

      apiKeyRequired:
        false
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
   SERVER START
   ========================================================= */

const PORT =
  process.env.PORT ||
  3000;

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
      "MODE: TANPA API KEY"
    );

    console.log(
      "GIFT EVENT: AKTIF"
    );

    console.log(
      "================================================"
    );
  }
);

/* =========================================================
   ERROR HANDLER
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
