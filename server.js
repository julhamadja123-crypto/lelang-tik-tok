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


/*
 * TIDAK ADA:
 *
 * SIGN_API_KEY
 * EULER_API_KEY
 * signApiKey
 *
 * Versi connector 1.2.3 menggunakan
 * WebcastPushConnection.
 */


/* =========================================================
   STARTUP
   ========================================================= */

console.log("================================================");
console.log("[SERVER] TikTok Live Coin Auction");
console.log("[SERVER] Connector: tiktok-live-connector 1.2.3");
console.log("[SERVER] MODE: TANPA API KEY");
console.log("================================================");

console.log(
  `[CONFIG] Username default: @${DEFAULT_TIKTOK_USERNAME}`
);

console.log(
  "[CONFIG] SIGN_API_KEY: TIDAK DIGUNAKAN"
);

console.log("================================================");


/* =========================================================
   TIKTOK CONNECTOR
   ========================================================= */

let WebcastPushConnection = null;
let liveConnection = null;

let activeUsername = null;

let reconnectTimer = null;

let manualDisconnect = false;


/* =========================================================
   AUCTION
   ========================================================= */

let auctionActive = false;


/* =========================================================
   GIFT DEDUP
   ========================================================= */

/*
 * Hanya digunakan jika TikTok menyediakan
 * transactionId / msgId.
 *
 * JANGAN melakukan dedup berdasarkan
 * username + giftId + waktu karena bisa
 * membuat 3 gift menjadi 1.
 */

const processedGiftEvents = new Map();

const GIFT_TTL = 60 * 1000;


/* =========================================================
   LOAD CONNECTOR
   ========================================================= */

function loadTikTokConnector() {

  if (WebcastPushConnection) {
    return WebcastPushConnection;
  }

  const mod =
    require("tiktok-live-connector");

  WebcastPushConnection =
    mod.WebcastPushConnection ||
    mod.default?.WebcastPushConnection ||
    mod.default;

  if (
    typeof WebcastPushConnection !== "function"
  ) {

    throw new Error(
      "WebcastPushConnection tidak ditemukan. Pastikan tiktok-live-connector 1.2.3 terinstall."
    );
  }

  return WebcastPushConnection;
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


  if (
    msg.includes("offline") ||
    msg.includes("not live") ||
    msg.includes("useroffline")
  ) {

    return (
      "Akun TikTok tidak sedang LIVE atau username tidak benar."
    );
  }


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


  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout")
  ) {

    return (
      "Koneksi ke TikTok timeout. Coba lagi beberapa detik."
    );
  }


  if (
    msg.includes("403") ||
    msg.includes("forbidden")
  ) {

    return (
      "TikTok menolak koneksi dari server. " +
      "Coba reconnect beberapa saat lagi."
    );
  }


  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many")
  ) {

    return (
      "TikTok sedang membatasi koneksi. " +
      "Tunggu beberapa saat lalu coba lagi."
    );
  }


  /*
   * Jika masih ada pesan Euler/sign,
   * tampilkan pesan apa adanya supaya
   * mudah diketahui.
   */

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
      event?.unique_id ||
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
   GET GIFT DIAMOND COUNT
   ========================================================= */

function getGiftDiamondCount(event) {

  /*
   * v1.x biasanya menyediakan diamondCount
   * langsung pada event.
   */

  let value =
    numberPositive(

      event?.diamondCount,
      event?.diamond_count,

      event?.giftDetails?.diamondCount,
      event?.giftDetails?.diamond_count,

      event?.giftDetails?.diamondCost,
      event?.giftDetails?.diamond_cost,

      event?.gift?.diamondCount,
      event?.gift?.diamond_count,

      event?.extendedGiftInfo?.diamondCount,
      event?.extendedGiftInfo?.diamond_count,

      event?.extendedGiftInfo?.diamondCost,
      event?.extendedGiftInfo?.diamond_cost

    );


  /*
   * Beberapa event lama bisa hanya memiliki
   * giftDetails.
   */

  if (
    value <= 0 &&
    event?.extendedGiftInfo
  ) {

    value =
      numberPositive(

        event.extendedGiftInfo.diamondCount,

        event.extendedGiftInfo.diamond_count,

        event.extendedGiftInfo.diamondCost,

        event.extendedGiftInfo.diamond_cost

      );
  }


  return value;
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

      event.giftDetails?.giftId ??
      event.giftDetails?.gift_id ??

      event.gift?.giftId ??
      event.gift?.gift_id ??

      ""

    );


  if (!giftId) {

    console.warn(
      "[GIFT] Gift ID tidak ditemukan."
    );

    return null;
  }


  /* =======================================================
     GIFT NAME
     ======================================================= */

  const giftName =

    event.giftName ||

    event.gift_name ||

    event.giftDetails?.giftName ||

    event.giftDetails?.name ||

    event.gift?.giftName ||

    event.gift?.name ||

    `Gift #${giftId}`;


  /* =======================================================
     DIAMOND
     ======================================================= */

  const diamondCount =
    getGiftDiamondCount(event);


  if (
    diamondCount <= 0
  ) {

    console.warn(
      `[GIFT] Diamond tidak ditemukan untuk ${giftName}`
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

          event.giftDetails?.repeatCount,

          event.giftDetails?.repeat_count

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

    event.giftDetails?.repeatEnd ??

    event.giftDetails?.repeat_end;


  const repeatEnd =

    repeatValue === true ||
    repeatValue === 1 ||
    repeatValue === "1" ||
    repeatValue === "true";


  /*
   * TikTok giftType 1 = streak.
   *
   * Jangan proses event sementara.
   *
   * Tunggu repeatEnd=true.
   */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {

    console.log(
      `[GIFT] Streak sementara diabaikan: @${user.uniqueId} ${giftName} x${repeatCount}`
    );

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
     EVENT ID
     ======================================================= */

  const msgId =

    event.msgId ??

    event.msg_id ??

    event.messageId ??

    event.message_id ??

    null;


  const transactionId =

    event.transactionId ??

    event.transaction_id ??

    event.giftDetails?.transactionId ??

    event.giftDetails?.transaction_id ??

    null;


  /*
   * Hanya gunakan ID asli TikTok.
   */

  let eventKey = null;


  if (transactionId) {

    eventKey =
      `transaction:${String(transactionId)}`;

  } else if (msgId) {

    eventKey =
      `msg:${String(msgId)}`;
  }


  /* =======================================================
     CLEAN OLD DEDUP
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
    `${diamondCount} coin x ${repeatCount} = ` +
    `${coinValue} coin`
  );


  /* =======================================================
     RETURN
     ======================================================= */

  return {

    username:
      user.uniqueId,

    nickname:
      user.nickname,

    userId:
      user.userId,

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

    /*
     * Frontend tidak perlu
     * menampilkan notifikasi.
     */

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

  const Connector =
    loadTikTokConnector();


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
    "[TikTok] API KEY: TIDAK DIGUNAKAN"
  );

  console.log("================================================");


  emitStatus(
    `Mencari LIVE @${username}...`
  );


  /* =======================================================
     CONNECTION OPTIONS V1.2.3
     ======================================================= */

  const connectionOptions = {

    /*
     * Jangan mengambil data lama.
     */

    processInitialData:
      false,


    /*
     * Ambil informasi gift.
     */

    enableExtendedGiftInfo:
      true,


    /*
     * Pastikan room diperiksa ketika connect.
     */

    fetchRoomInfoOnConnect:
      true,


    /*
     * Gunakan WebSocket jika tersedia.
     */

    enableWebsocketUpgrade:
      true,


    /*
     * Polling fallback.
     */

    requestPollingIntervalMs:
      1000,


    /*
     * Timeout HTTP.
     */

    requestOptions: {

      timeout:
        15000

    },


    /*
     * Timeout WebSocket.
     */

    websocketOptions: {

      timeout:
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
       * Jangan proses gift kalau
       * lelang sedang tidak aktif.
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
       * Hanya SATU event live:gift.
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

      /*
       * Sengaja tidak diteruskan
       * ke frontend.
       */

    }
  );


  /* =======================================================
     MEMBER
     ======================================================= */

  conn.on(
    "member",
    () => {

      /*
       * Tidak diteruskan.
       */

    }
  );


  /* =======================================================
     LIKE
     ======================================================= */

  conn.on(
    "like",
    () => {

      /*
       * Tidak diteruskan.
       */

    }
  );


  /* =======================================================
     SOCIAL
     ======================================================= */

  conn.on(
    "social",
    () => {

      /*
       * Tidak diteruskan.
       */

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
     WEBSOCKET CONNECTED
     ======================================================= */

  conn.on(
    "websocketConnected",
    () => {

      console.log(
        "[TikTok] WebSocket berhasil terhubung."
      );

    }
  );


  /* =======================================================
     STREAM END
     ======================================================= */

  conn.on(
    "streamEnd",
    () => {

      console.warn(
        `[TikTok] LIVE @${activeUsername} selesai.`
      );


      emitStatus(
        `LIVE @${activeUsername} telah selesai.`
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


    /*
     * v1.2.3 menggunakan getState().
     */

    let currentState =
      state;


    if (
      !currentState &&
      typeof conn.getState === "function"
    ) {

      currentState =
        conn.getState();

    }


    const roomId =

      currentState?.roomId ||

      currentState?.roomInfo?.room_id ||

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

    console.log(
      "[TikTok] MODE: TANPA API KEY"
    );

    console.log("================================================");


    return currentState;

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

    let connected =
      false;


    if (liveConnection) {

      try {

        if (
          typeof liveConnection.getState ===
          "function"
        ) {

          const state =
            liveConnection.getState();


          connected =
            Boolean(
              state?.isConnected
            );

        } else {

          connected =
            Boolean(
              liveConnection.isConnected
            );

        }

      } catch (_) {

        connected =
          false;

      }

    }


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

    let connected =
      false;


    if (liveConnection) {

      try {

        if (
          typeof liveConnection.getState ===
          "function"
        ) {

          const state =
            liveConnection.getState();


          connected =
            Boolean(
              state?.isConnected
            );

        } else {

          connected =
            Boolean(
              liveConnection.isConnected
            );

        }

      } catch (_) {

        connected =
          false;

      }

    }


    res.status(200).json({

      ok:
        true,

      service:
        "tiktok-live-coin-auction",

      connector:
        "tiktok-live-connector@1.2.3",

      connected,

      username:
        activeUsername,

      defaultUsername:
        DEFAULT_TIKTOK_USERNAME,

      auctionActive,

      apiKeyRequired:
        false,

      apiKeyConfigured:
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
      "SIGN_API_KEY: TIDAK DIGUNAKAN"
    );

    console.log(
      "Euler API: TIDAK DIGUNAKAN"
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
