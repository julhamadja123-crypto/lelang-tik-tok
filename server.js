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

const DEFAULT_TIKTOK_USERNAME =
  process.env.TIKTOK_USERNAME || "hamstillearn";


const SIGN_API_KEY =
  String(process.env.SIGN_API_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "");


/* =========================================================
   STARTUP CHECK
   ========================================================= */

console.log("================================================");
console.log("[SERVER] TikTok Live Coin Auction");
console.log("================================================");

console.log(
  `[CONFIG] Username default: @${DEFAULT_TIKTOK_USERNAME}`
);

console.log(
  `[CONFIG] SIGN_API_KEY: ${
    SIGN_API_KEY ? "TERSEDIA" : "BELUM DIATUR"
  }`
);

if (!SIGN_API_KEY) {

  console.warn(
    "[WARNING] SIGN_API_KEY belum tersedia."
  );

  console.warn(
    "[WARNING] Atur SIGN_API_KEY di Railway Variables."
  );

}

console.log("================================================");


/* =========================================================
   TIKTOK CONNECTOR
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
   GIFT DEDUP
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;


/* =========================================================
   LOAD CONNECTOR
   ========================================================= */

async function loadTikTokConnector() {

  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  const mod =
    await import("tiktok-live-connector");

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (
    typeof TikTokLiveConnection !== "function"
  ) {

    throw new Error(
      "TikTokLiveConnection tidak ditemukan. Pastikan tiktok-live-connector 2.4.4 terinstall."
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

    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\/@/i,
      ""
    )

    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\//i,
      ""
    )

    .replace(
      /^@/,
      ""
    )

    .replace(
      /\/live.*$/i,
      ""
    )

    .replace(
      /[/?#].*$/g,
      ""
    )

    .replace(
      /\s+/g,
      ""
    );
}


/* =========================================================
   STATUS
   ========================================================= */

function emitStatus(message, ok = false) {

  console.log(
    `[STATUS] ${message}`
  );

  io.emit(
    "live:status",
    {
      message,
      ok
    }
  );
}


/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {

  const raw =
    err?.message ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const msg =
    raw.toLowerCase();


  /* API KEY */

  if (
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid api") ||
    msg.includes("api key")
  ) {

    return (
      "Euler Stream menolak SIGN_API_KEY. " +
      "Pastikan API key berasal dari Euler Stream Dashboard dan masih aktif."
    );
  }


  /* RATE LIMIT */

  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many")
  ) {

    return (
      "Euler Stream rate limit. " +
      "Tunggu beberapa saat lalu coba lagi."
    );
  }


  /* OFFLINE */

  if (
    msg.includes("offline") ||
    msg.includes("not live") ||
    msg.includes("useroffline")
  ) {

    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }


  /* TIMEOUT */

  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("connecttimeout")
  ) {

    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik."
    );
  }


  /* ROOM */

  if (
    msg.includes("room") &&
    (
      msg.includes("not found") ||
      msg.includes("invalid")
    )
  ) {

    return (
      "LIVE atau room TikTok tidak ditemukan. " +
      "Pastikan @username benar dan sedang LIVE."
    );
  }


  /* SIGN */

  if (
    msg.includes("sign") ||
    msg.includes("signature") ||
    msg.includes("euler")
  ) {

    return (
      "Euler Stream menolak proses signing. " +
      "Periksa SIGN_API_KEY."
    );
  }


  return raw;
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

    const n =
      Number(value);

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

  const user =
    event?.user || {};

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


  const user =
    userData(event);


  /* =======================================================
     GIFT ID
     ======================================================= */

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


  if (!giftId) {
    return null;
  }


  /* =======================================================
     GIFT NAME
     ======================================================= */

  const giftName =

    event.giftName ||
    event.gift_name ||

    event.gift?.giftName ||
    event.gift?.name ||

    event.giftDetails?.giftName ||
    event.giftDetails?.name ||

    `Gift #${giftId}`;


  /* =======================================================
     DIAMOND VALUE
     ======================================================= */

  const diamondCount =
    numberPositive(

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


  if (diamondCount <= 0) {
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
          event.gift?.repeat_count

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
   * TikTok gift type 1 = streak.
   *
   * Tunggu sampai streak selesai supaya
   * tidak menghitung event sementara.
   */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {

    return null;
  }


  /* =======================================================
     TOTAL COIN
     ======================================================= */

  const coinValue =
    diamondCount *
    repeatCount;


  if (
    !Number.isFinite(coinValue) ||
    coinValue <= 0
  ) {

    return null;
  }


  /* =======================================================
     EVENT IDENTIFIER
     ======================================================= */

  const msgId =
    event.msgId ??
    event.msg_id ??
    null;

  const transactionId =
    event.transactionId ??
    event.transaction_id ??
    null;


  let eventKey = null;


  if (transactionId) {

    eventKey =
      `transaction:${String(transactionId)}`;

  } else if (msgId) {

    eventKey =
      `msg:${String(msgId)}`;

  }


  /* =======================================================
     CLEAN OLD EVENTS
     ======================================================= */

  const now =
    Date.now();


  for (
    const [key, timestamp]
    of processedGiftEvents
  ) {

    if (
      now - timestamp >
      GIFT_TTL
    ) {

      processedGiftEvents.delete(
        key
      );

    }
  }


  /* =======================================================
     DEDUP
     ======================================================= */

  if (eventKey) {

    if (
      processedGiftEvents.has(
        eventKey
      )
    ) {

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


  /* =======================================================
     LOG
     ======================================================= */

  console.log(
    `[GIFT] @${user.uniqueId} | ` +
    `${giftName} | ` +
    `${diamondCount} x ${repeatCount} = ${coinValue}`
  );


  /* =======================================================
     RETURN
     ======================================================= */

  return {

    username:
      user.uniqueId,

    nickname:
      user.nickname,

    giftName,

    giftId,

    diamondCount,

    repeatCount,

    coinValue,

    giftType,

    repeatEnd,

    msgId,

    transactionId,

    avatar:
      user.avatar,

    silent:
      true,

    displayNotification:
      false,

    showNotification:
      false

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

    reconnectTimer =
      null;
  }


  manualDisconnect =
    true;


  const conn =
    liveConnection;


  liveConnection =
    null;


  if (!conn) {
    return;
  }


  try {

    await conn.disconnect();

  } catch (err) {

    console.warn(
      "[TikTok] disconnect:",
      err?.message || err
    );
  }
}


/* =========================================================
   CONNECT TIKTOK LIVE
   ========================================================= */

async function connectToLive(
  rawUsername
) {

  if (!SIGN_API_KEY) {

    throw new Error(
      "SIGN_API_KEY belum diatur di Railway."
    );
  }


  const Connector =
    await loadTikTokConnector();


  const username =
    cleanUsername(
      rawUsername ||
      DEFAULT_TIKTOK_USERNAME
    );


  if (!username) {

    throw new Error(
      "Username TikTok kosong."
    );
  }


  /* -------------------------------------------------------
     STOP CONNECTION LAMA
     ------------------------------------------------------- */

  await stopConnection();


  manualDisconnect =
    false;


  activeUsername =
    username;


  console.log("================================================");
  console.log(
    `[TikTok] Mencoba koneksi @${username}`
  );
  console.log(
    "[TikTok] SIGN_API_KEY tersedia"
  );
  console.log("================================================");


  emitStatus(
    `Mencari LIVE @${username}...`
  );


  /* =======================================================
     CONNECTION OPTIONS
     ======================================================= */

  const connectionOptions = {

    /*
     * API KEY EULER STREAM
     *
     * tiktok-live-connector 2.4.4
     * mendukung ini secara langsung.
     */

    signApiKey:
      SIGN_API_KEY,


    /*
     * Jangan mengambil event lama.
     */

    processInitialData:
      false,


    /*
     * Informasi gift lengkap.
     */

    enableExtendedGiftInfo:
      true,


    /*
     * Ambil room info.
     */

    fetchRoomInfoOnConnect:
      true,


    /*
     * HTTP timeout.
     */

    webClientOptions: {

      timeout: {
        request: 15000
      }

    },


    /*
     * WebSocket timeout.
     */

    wsClientOptions: {

      handshakeTimeout:
        15000

    }

  };


  /* =======================================================
     CREATE CONNECTION
     ======================================================= */

  const conn =
    new Connector(
      username,
      connectionOptions
    );


  liveConnection =
    conn;


  /* =======================================================
     GIFT
     ======================================================= */

  conn.on(
    "gift",
    (event) => {

      /*
       * Gift hanya diproses ketika
       * lelang sedang aktif.
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
       * HANYA SATU EVENT.
       *
       * Tidak ada event notification.
       */

      io.emit(
        "live:gift",
        gift
      );

    }
  );


  /* =======================================================
     CHAT
     ======================================================= */

  conn.on(
    "chat",
    () => {
      // Sengaja tidak diteruskan ke frontend.
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
        "[TikTok] ERROR:",
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


      if (reconnectTimer) {

        clearTimeout(
          reconnectTimer
        );
      }


      reconnectTimer =
        setTimeout(
          async () => {

            if (
              manualDisconnect ||
              !activeUsername
            ) {

              return;
            }


            try {

              await connectToLive(
                activeUsername
              );

            } catch (err) {

              console.error(
                "[TikTok] Reconnect gagal:",
                err
              );

              emitStatus(
                `Reconnect gagal: ${formatError(err)}`
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


    console.log("================================================");
    console.log(
      `[TikTok] BERHASIL TERHUBUNG @${username}`
    );
    console.log(
      `[TikTok] ROOM ID: ${roomId}`
    );
    console.log("================================================");


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
      "[TikTok] Gagal connect:"
    );

    console.error(
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
       STATUS AWAL
       ===================================================== */

    const connected =
      Boolean(
        liveConnection?.isConnected ||
        liveConnection?.state?.isConnected
      );


    socket.emit(
      "live:status",
      {

        ok:
          connected,

        message:

          connected

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

          const username =
            cleanUsername(

              data.username ||
              DEFAULT_TIKTOK_USERNAME

            );


          console.log(
            `[Socket] Request connect @${username}`
          );


          await connectToLive(
            username
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
       DISCONNECT TIKTOK
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


        processedGiftEvents.clear();


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

      ok:
        true,

      service:
        "tiktok-live-coin-auction",

      connected,

      username:
        activeUsername,

      defaultUsername:
        DEFAULT_TIKTOK_USERNAME,

      auctionActive,

      apiKeyRequired:
        true,

      apiKeyConfigured:
        Boolean(
          SIGN_API_KEY
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
   SERVER START
   ========================================================= */

const PORT =
  process.env.PORT || 3000;


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("================================================");

    console.log(
      `Server berjalan di port ${PORT}`
    );

    console.log(
      "TikTok Live Coin Auction siap."
    );

    console.log(
      `Username default: @${DEFAULT_TIKTOK_USERNAME}`
    );

    console.log(
      `SIGN_API_KEY: ${
        SIGN_API_KEY
          ? "TERSEDIA"
          : "BELUM DIATUR"
      }`
    );

    console.log("================================================");

  }
);


/* =========================================================
   PROCESS ERROR HANDLING
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
