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

/* =========================================================
   SIGNING MODE
   ========================================================= */

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
   DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;

/* =========================================================
   CONNECTOR LOADER
   ========================================================= */

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  let mod;

  try {
    mod = await import("tiktok-live-connector");
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
    typeof TikTokLiveConnection !== "function"
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

  if (
    lower.includes("empty payload")
  ) {
    return (
      "TikTok signing server mengembalikan Empty Payload. " +
      "Server akan mencoba ulang otomatis."
    );
  }

  if (
    lower.includes("offline") ||
    lower.includes("not live") ||
    lower.includes("useroffline")
  ) {
    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }

  if (
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik kemudian."
    );
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {
    return (
      "TikTok/signing server sedang membatasi request. Tunggu beberapa saat."
    );
  }

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

  const userDetails =
    event?.userDetails ||
    user?.userDetails ||
    {};

  let avatar =
    user.profilePictureUrl ||
    user.profilePicture?.url ||
    user.profilePicture?.urls?.[0] ||
    userDetails.profilePictureUrl ||
    userDetails.profilePictureUrls?.[0] ||
    event?.profilePictureUrl ||
    event?.profilePicture ||
    null;

  if (
    !avatar &&
    Array.isArray(
      user.profilePictureUrls
    )
  ) {
    avatar =
      user.profilePictureUrls[0] ||
      null;
  }

  if (
    !avatar &&
    Array.isArray(
      event?.userDetails?.profilePictureUrls
    )
  ) {
    avatar =
      event.userDetails.profilePictureUrls[0] ||
      null;
  }

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

    avatar
  };
}

/* =========================================================
   AMBIL COIN LANGSUNG DARI DATA TIKTOK
   =========================================================
   
   PENTING:
   
   TIDAK ADA:
   - nama gift sebagai harga
   - Gift ID sebagai harga
   - catalog buatan sendiri
   - harga manual
   - fallback
   
   Hanya nilai coin/diamond yang ada di event TikTok.
   
   ========================================================= */

function getTikTokCoinValue(event) {
  /*
   * Prioritas nilai coin langsung.
   */

  const directCoin =
    numberPositive(
      event?.coinValue,
      event?.coin_value,
      event?.coinCount,
      event?.coin_count,

      event?.gift?.coinValue,
      event?.gift?.coin_value,
      event?.gift?.coinCount,
      event?.gift?.coin_count,

      event?.giftDetails?.coinValue,
      event?.giftDetails?.coin_value,
      event?.giftDetails?.coinCount,
      event?.giftDetails?.coin_count
    );

  if (directCoin > 0) {
    return directCoin;
  }

  /*
   * Nilai diamondCount dari event TikTok.
   *
   * Pada connector, diamondCount merupakan
   * nilai coin/diamond gift per unit.
   */

  const diamondCount =
    numberPositive(
      event?.diamondCount,
      event?.diamond_count,

      event?.gift?.diamondCount,
      event?.gift?.diamond_count,

      event?.giftDetails?.diamondCount,
      event?.giftDetails?.diamond_count,

      event?.extendedGiftInfo?.diamondCount,
      event?.extendedGiftInfo?.diamond_count
    );

  if (diamondCount > 0) {
    return diamondCount;
  }

  /*
   * TIDAK ADA FALLBACK.
   *
   * Kalau TikTok tidak mengirim nilai,
   * jangan menebak.
   */

  return 0;
}

/* =========================================================
   PARSE GIFT
   ========================================================= */

function parseGift(event) {
  if (!event) {
    return null;
  }

  const user =
    getUserData(event);

  /*
   * Nama dan ID hanya untuk informasi.
   * TIDAK PERNAH dipakai untuk menentukan coin.
   */

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
    "Gift";

  /* =======================================================
     NILAI COIN TIKTOK
     ======================================================= */

  const tikTokCoin =
    getTikTokCoinValue(event);

  /*
   * Kalau TikTok tidak memberikan nilai coin,
   * STOP.
   *
   * Jangan menggunakan nama.
   * Jangan menggunakan ID.
   * Jangan mengarang harga.
   */

  if (
    tikTokCoin <= 0
  ) {
    console.warn(
      "[Gift] COIN TIKTOK TIDAK DITEMUKAN."
    );

    console.warn(
      "[Gift] Gift diabaikan agar tidak salah hitung."
    );

    console.log(
      "[Gift] Nama hanya informasi:",
      giftName
    );

    console.log(
      "[Gift] ID hanya informasi:",
      giftId
    );

    console.log(
      "[Gift] Event:",
      JSON.stringify(event)
    );

    return null;
  }

  /* =======================================================
     REPEAT COUNT
     ======================================================= */

  const repeatCount =
    Math.max(
      1,
      Math.floor(
        numberPositive(
          event.repeatCount,
          event.repeat_count,

          event.gift?.repeatCount,
          event.gift?.repeat_count,

          event.giftDetails?.repeatCount,
          event.giftDetails?.repeat_count,

          1
        )
      )
    );

  /* =======================================================
     GIFT TYPE
     ======================================================= */

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

  /* =======================================================
     REPEAT END
     ======================================================= */

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
   *
   * Selama belum selesai, jangan kirim.
   *
   * Saat repeatEnd=true,
   * kirim jumlah akhirnya.
   */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    console.log(
      `[Gift] Streak sementara @${user.uniqueId}: ${repeatCount}x`
    );

    return null;
  }

  /* =======================================================
     TOTAL COIN
     =======================================================
     
     INI SATU-SATUNYA PERHITUNGAN.
     
     Nilai dari TikTok × jumlah yang dikirim.
     
     Tidak memakai nama.
     Tidak memakai ID.
     
     ======================================================= */

  const totalCoin =
    tikTokCoin *
    repeatCount;

  /* =======================================================
     DUPLICATE KEY
     ======================================================= */

  const eventKey =
    String(
      event.msgId ||
      event.transactionId ||
      event.transaction_id ||
      event.messageId ||
      `${event.groupId || ""}|${user.userId}|${repeatCount}|${event.createTime || event.timestamp || ""}|${repeatEnd}`
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
   * Cegah event yang sama masuk dua kali.
   */

  if (
    processedGiftEvents.has(
      eventKey
    )
  ) {
    console.log(
      `[Gift] Duplicate diabaikan: ${eventKey}`
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  /* =======================================================
     LOG
     ======================================================= */

  console.log(
    "================================================"
  );

  console.log(
    `[GIFT] @${user.uniqueId}`
  );

  console.log(
    `Coin TikTok : ${tikTokCoin}`
  );

  console.log(
    `Jumlah      : ${repeatCount}x`
  );

  console.log(
    `TOTAL LELANG: ${totalCoin} coin`
  );

  /*
   * Nama dan ID hanya ditampilkan untuk debugging.
   * BUKAN sumber harga.
   */

  console.log(
    `Nama gift   : ${giftName}`
  );

  console.log(
    `Gift ID     : ${giftId || "-"}`
  );

  console.log(
    "================================================"
  );

  /* =======================================================
     DATA KE WEB LELANG
     ======================================================= */

  return {
    username:
      user.uniqueId,

    nickname:
      user.nickname,

    userId:
      user.userId,

    avatar:
      user.avatar,

    /*
     * Informasi saja.
     */

    giftName,

    giftId,

    /*
     * Nilai coin asli dari TikTok.
     */

    giftUnitCoins:
      tikTokCoin,

    diamondCount:
      tikTokCoin,

    /*
     * Jumlah gift.
     */

    repeatCount,

    /*
     * TOTAL YANG MASUK WEB LELANG.
     */

    coinValue:
      totalCoin,

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
      null
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

    reconnectTimer = null;
  }

  manualDisconnect = true;

  const connection =
    liveConnection;

  liveConnection = null;

  if (!connection) {
    return;
  }

  try {
    await connection.disconnect();
  } catch (err) {
    console.warn(
      "[TikTok] disconnect:",
      err?.message || err
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
        reconnectTimer = null;

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
            err?.message || err
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
    `[TikTok] Signing mode: ${signingMode}`
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  const options = {
    processInitialData: false,

    fetchRoomInfoOnConnect: false,

    /*
     * Tidak menggunakan catalog gift
     * buatan aplikasi.
     */

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

  if (
    signingMode ===
    "api-key"
  ) {
    options.signApiKey =
      SIGN_API_KEY;
  }

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

      /*
       * coinValue sudah dihitung
       * hanya dari data TikTok.
       */

      io.emit(
        "live:gift",
        gift
      );

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
            user.userId,

          avatar:
            user.avatar
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
            user.userId,

          avatar:
            user.avatar
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

          avatar:
            user.avatar,

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
            user.userId,

          avatar:
            user.avatar
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

        auctionActive = false;

        await stopConnection();

        activeUsername = null;

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

      apiKeyConfigured:
        Boolean(SIGN_API_KEY),

      apiKeyUsed:
        signingMode === "api-key",

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
      "MODE COIN: HANYA DATA COIN TIKTOK"
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

  manualDisconnect = true;

  try {
    if (liveConnection) {
      await liveConnection.disconnect();
    }
  } catch (err) {
    console.warn(
      "[PROCESS] Disconnect error:",
      err?.message || err
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
