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

/* =========================================================
   AUCTION STATE
   idle     = belum mulai
   running  = menerima gift
   paused   = berhenti sementara
   finished = selesai, data peserta tetap
   ========================================================= */

let auctionState = "idle";
let auctionVersion = 0;

/* =========================================================
   PARTICIPANTS
   ========================================================= */

const participants = new Map();

/* =========================================================
   DUPLICATE GIFT PROTECTION
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
   USERNAME CLEANER
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
   NUMBER
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
      event?.uniqueId ||
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
    (giftId ? `Gift #${giftId}` : "Gift");

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
   * TikTok streak gift:
   * hanya proses event terakhir.
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

  /* =======================================================
     DUPLICATE KEY
     ======================================================= */

  const eventKey = String(
    event.msgId ||
    event.messageId ||
    event.transactionId ||
    event.transaction_id ||
    event.id ||
    (
      `${event.groupId || ""}|` +
      `${user.userId}|` +
      `${giftId}|` +
      `${repeatCount}|` +
      `${event.createTime || event.timestamp || ""}|` +
      `${repeatEnd}`
    )
  );

  const now = Date.now();

  /* Bersihkan cache lama */
  for (const [
    key,
    time
  ] of processedGiftEvents) {
    if (
      now - time >
      GIFT_TTL
    ) {
      processedGiftEvents.delete(key);
    }
  }

  /* Gift sudah pernah diproses */
  if (
    processedGiftEvents.has(eventKey)
  ) {
    console.log(
      `[GIFT] DUPLIKAT diabaikan: ${eventKey}`
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  console.log(
    `[GIFT] @${user.uniqueId} | ` +
    `${giftName} | ` +
    `${diamondCount} x ${repeatCount} = ${coinValue}`
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
      event.msgId ||
      event.messageId ||
      null,

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
   PARTICIPANT SNAPSHOT
   ========================================================= */

function getParticipants() {
  return Array.from(
    participants.values()
  ).sort(
    (a, b) =>
      Number(b.coins || 0) -
        Number(a.coins || 0) ||
      Number(a.joinedAt || 0) -
        Number(b.joinedAt || 0)
  );
}

/* =========================================================
   BROADCAST PARTICIPANTS
   ========================================================= */

function broadcastParticipants() {
  io.emit(
    "auction:participants",
    {
      participants:
        getParticipants(),

      count:
        participants.size,

      version:
        auctionVersion
    }
  );
}

/* =========================================================
   APPLY GIFT
   ========================================================= */

function applyGift(gift) {

  /*
   * PENGAMAN UTAMA
   *
   * HANYA state running yang boleh
   * menambahkan koin.
   */
  if (
    auctionState !== "running"
  ) {
    console.log(
      `[GIFT] Diabaikan karena auction state = ${auctionState}`
    );

    return;
  }

  const key =
    String(
      gift.userId ||
      gift.username ||
      "unknown"
    );

  let participant =
    participants.get(key);

  if (!participant) {

    participant = {
      userId:
        gift.userId ||
        key,

      username:
        gift.username ||
        "viewer",

      nickname:
        gift.nickname ||
        gift.username ||
        "Viewer",

      avatar:
        gift.avatar ||
        null,

      coins: 0,

      gifts: 0,

      joinedAt:
        Date.now()
    };
  }

  /*
   * 1 gift = nilai diamond.
   * 3 coin = +3.
   */
  participant.coins =
    Number(participant.coins || 0) +
    Number(gift.coinValue || 0);

  participant.gifts =
    Number(participant.gifts || 0) +
    1;

  participant.username =
    gift.username ||
    participant.username;

  participant.nickname =
    gift.nickname ||
    participant.nickname;

  if (gift.avatar) {
    participant.avatar =
      gift.avatar;
  }

  participants.set(
    key,
    participant
  );

  console.log(
    `[AUCTION] +${gift.coinValue} coin -> ` +
    `@${participant.username} | ` +
    `Total: ${participant.coins}`
  );

  /*
   * Update daftar peserta.
   */
  broadcastParticipants();

  /*
   * live:gift hanya sebagai informasi internal
   * ke frontend.
   *
   * Frontend tidak boleh menambahkan coin lagi
   * dari event ini. Snapshot participants adalah
   * sumber data utama.
   */
  io.emit(
    "live:gift",
    {
      ...gift,
      participant
    }
  );
}

/* =========================================================
   AUCTION STATE BROADCAST
   ========================================================= */

function broadcastAuctionState() {
  io.emit(
    "auction:state",
    {
      state:
        auctionState,

      active:
        auctionState === "running",

      version:
        auctionVersion,

      participants:
        getParticipants(),

      count:
        participants.size
    }
  );
}

/* =========================================================
   SET AUCTION STATE
   ========================================================= */

function setAuctionState(nextState) {

  const allowed = [
    "idle",
    "running",
    "paused",
    "finished"
  ];

  if (
    !allowed.includes(nextState)
  ) {
    return false;
  }

  auctionState =
    nextState;

  auctionVersion++;

  console.log(
    `[Auction] STATE = ${auctionState}`
  );

  /*
   * PENTING:
   *
   * finished TIDAK menghapus peserta.
   *
   * paused TIDAK menghapus peserta.
   *
   * idle juga tidak otomatis menghapus.
   *
   * Penghapusan hanya dilakukan oleh
   * auction:reset.
   */

  broadcastAuctionState();

  return true;
}

/* =========================================================
   RESET AUCTION
   ========================================================= */

function resetAuction() {

  /*
   * RESET = HAPUS SEMUA
   */
  participants.clear();

  auctionState =
    "idle";

  auctionVersion++;

  console.log(
    "[Auction] RESET -> peserta dikosongkan."
  );

  io.emit(
    "auction:participants",
    {
      participants: [],
      count: 0,
      version: auctionVersion
    }
  );

  broadcastAuctionState();
}

/* =========================================================
   STOP TIKTOK CONNECTION
   ========================================================= */

async function stopConnection() {

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer = null;

  manualDisconnect =
    true;

  const conn =
    liveConnection;

  liveConnection =
    null;

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
        processInitialData:
          false,

        fetchRoomInfoOnConnect:
          true,

        enableExtendedGiftInfo:
          true,

        webClientOptions: {
          timeout: {
            request: 15000
          }
        },

        wsClientOptions: {
          handshakeTimeout:
            15000
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
       * HANYA RUNNING YANG BOLEH
       * MENERIMA GIFT.
       *
       * Idle     -> stop
       * Paused   -> stop
       * Finished -> stop
       * Running  -> lanjut
       */

      if (
        auctionState !==
        "running"
      ) {
        console.log(
          `[GIFT] Ditolak. Auction = ${auctionState}`
        );

        return;
      }

      const gift =
        giftData(event);

      if (!gift) {
        return;
      }

      applyGift(gift);
    }
  );

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on(
    "chat",
    (event) => {

      /*
       * Tidak ditampilkan sebagai
       * notifikasi gift.
       */

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
      liveConnection =
        null;
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

    /* =====================================================
       KIRIM STATUS SAAT CLIENT MASUK
       ===================================================== */

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
       KIRIM AUCTION STATE
       ===================================================== */

    socket.emit(
      "auction:state",
      {
        state:
          auctionState,

        active:
          auctionState === "running",

        version:
          auctionVersion,

        participants:
          getParticipants(),

        count:
          participants.size
      }
    );

    /* =====================================================
       KIRIM PARTICIPANTS
       ===================================================== */

    socket.emit(
      "auction:participants",
      {
        participants:
          getParticipants(),

        count:
          participants.size,

        version:
          auctionVersion
      }
    );

    /* =====================================================
       CONNECT TIKTOK
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

        /*
         * Versi baru:
         * { state: "running" }
         */

        if (
          typeof data.state ===
          "string"
        ) {

          setAuctionState(
            data.state
          );

          return;
        }

        /*
         * Kompatibilitas versi lama:
         * { active: true/false }
         */

        if (
          typeof data.active ===
          "boolean"
        ) {

          setAuctionState(
            data.active
              ? "running"
              : "paused"
          );
        }
      }
    );

    /* =====================================================
       RESET
       ===================================================== */

    socket.on(
      "auction:reset",
      () => {

        resetAuction();
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

        /*
         * Hentikan penerimaan gift.
         */
        auctionState =
          "idle";

        auctionVersion++;

        await stopConnection();

        activeUsername =
          null;

        emitStatus(
          "Koneksi TikTok LIVE diputus."
        );

        broadcastAuctionState();
      }
    );

    /* =====================================================
       CLIENT DISCONNECT
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
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (req, res) => {

    res.status(200).json(
      {
        ok: true,

        service:
          "tiktok-live-coin-auction",

        connected:
          Boolean(liveConnection),

        username:
          activeUsername,

        auctionState:
          auctionState,

        auctionActive:
          auctionState === "running",

        participantCount:
          participants.size,

        apiKeyRequired:
          false
      }
    );
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
      "MODE: TANPA API KEY"
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
