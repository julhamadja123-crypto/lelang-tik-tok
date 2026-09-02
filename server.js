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

   PENTING:
   - Extended Gift Info DIMATIKAN
   - Tidak melakukan fetch room gifts
   - Mendukung EULER_API_KEY jika tersedia
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

/*
   Optional Euler API Key.

   Jika Railway memiliki variable:
   EULER_API_KEY

   maka akan digunakan.

   Jika tidak ada, connector akan mencoba
   menggunakan konfigurasi signing default.
*/

const EULER_API_KEY =
  process.env.EULER_API_KEY || "";

/* =========================================================
   TIKTOK CONNECTOR
   ========================================================= */

let TikTokLiveConnection = null;

async function loadTikTokConnector() {
  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  try {
    const mod = await import("tiktok-live-connector");

    TikTokLiveConnection =
      mod.TikTokLiveConnection ||
      mod.default?.TikTokLiveConnection ||
      mod.default;

    if (
      typeof TikTokLiveConnection !==
      "function"
    ) {
      throw new Error(
        "TikTokLiveConnection tidak ditemukan."
      );
    }

    console.log(
      "[TIKTOK] Connector berhasil dimuat."
    );

    return TikTokLiveConnection;
  } catch (error) {
    console.error(
      "[TIKTOK] Gagal memuat connector:",
      error
    );

    throw error;
  }
}

/* =========================================================
   GLOBAL STATE
   ========================================================= */

let tiktokConnection = null;

let currentUsername =
  DEFAULT_USERNAME;

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

let auctionDuration =
  DEFAULT_DURATION;

let auctionRemaining =
  DEFAULT_DURATION;

let auctionTimer = null;

/* =========================================================
   PARTICIPANTS
   ========================================================= */

const participants = new Map();

/*
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

  let value =
    String(username).trim();

  value = value
    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\//i,
      ""
    )
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .trim();

  return value;
}

/* =========================================================
   ERROR FORMAT
   ========================================================= */

function formatError(err) {
  const s = String(
    err?.message ||
    err ||
    ""
  );

  const lower =
    s.toLowerCase();

  if (
    lower.includes(
      "signaturemissingtokens"
    ) ||
    lower.includes(
      "failed to sign"
    ) ||
    lower.includes(
      "signature"
    ) ||
    lower.includes(
      "sign request"
    )
  ) {
    return (
      "TikTok menolak proses signing. " +
      "Coba beberapa saat lagi. " +
      "Jika tetap gagal, periksa EULER_API_KEY di Railway."
    );
  }

  if (
    lower.includes(
      "euler"
    )
  ) {
    return (
      "Layanan signing TikTok/Euler sedang menolak request."
    );
  }

  if (
    lower.includes("403")
  ) {
    return (
      "Request TikTok ditolak (403). " +
      "Coba lagi beberapa saat."
    );
  }

  if (
    lower.includes("404")
  ) {
    return (
      "LIVE atau username TikTok tidak ditemukan. " +
      "Pastikan @" +
      currentUsername +
      " sedang LIVE."
    );
  }

  if (
    lower.includes(
      "offline"
    )
  ) {
    return (
      "@" +
      currentUsername +
      " tidak sedang LIVE."
    );
  }

  if (
    lower.includes(
      "timeout"
    )
  ) {
    return (
      "Koneksi TikTok timeout. Coba hubungkan kembali."
    );
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

function emitStatus(
  message,
  type = "info"
) {
  io.emit(
    "live:status",
    {
      connected:
        tiktokConnected,

      username:
        currentUsername,

      state:
        auctionState,

      message,

      type,

      timestamp:
        Date.now()
    }
  );
}

/* =========================================================
   AUCTION STATE BROADCAST
   ========================================================= */

function emitAuctionState() {
  io.emit(
    "auction:state",
    {
      state:
        auctionState,

      remaining:
        auctionRemaining,

      duration:
        auctionDuration,

      participants:
        Array.from(
          participants.values()
        )
    }
  );
}

/* =========================================================
   PARTICIPANT BROADCAST
   ========================================================= */

function emitParticipants() {
  io.emit(
    "auction:participants",
    Array.from(
      participants.values()
    )
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
    user?.user_id ||
    user?.id ||
    event?.userId ||
    event?.user_id ||
    event?.uid ||
    event?.senderId ||
    event?.sender_id ||
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
    userId:
      String(
        userId ||
        uniqueId ||
        nickname
      ),

    uniqueId:
      String(
        uniqueId || ""
      ),

    nickname:
      String(
        nickname ||
        uniqueId ||
        "TikTok User"
      )
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

  /*
     ======================================================
     GIFT ID
     ======================================================
  */

  const giftId =
    event?.giftId ??
    event?.gift_id ??
    event?.gift?.giftId ??
    event?.gift?.gift_id ??
    event?.gift?.id ??
    event?.giftDetails?.giftId ??
    event?.giftDetails?.gift_id ??
    null;

  /*
     ======================================================
     GIFT NAME
     ======================================================
  */

  const giftName =
    event?.giftName ||
    event?.gift_name ||
    event?.gift?.giftName ||
    event?.gift?.name ||
    event?.giftDetails?.giftName ||
    event?.giftDetails?.name ||
    "Gift";

  /*
     ======================================================
     DIAMOND COUNT

     Prioritas versi 2.x:
       event.giftDetails.diamondCount

     Kemudian fallback ke struktur lain.
     ======================================================
  */

  const diamondCount =
    firstNumber(
      event?.diamondCount,

      event?.diamond_count,

      event?.giftDetails?.diamondCount,

      event?.giftDetails?.diamond_count,

      event?.gift?.diamondCount,

      event?.gift?.diamond_count,

      event?.giftDetails?.diamond_value,

      event?.diamondValue
    );

  /*
     ======================================================
     REPEAT COUNT
     ======================================================
  */

  const repeatCount =
    Math.max(
      1,
      firstNumber(
        event?.repeatCount,

        event?.repeat_count,

        event?.giftDetails?.repeatCount,

        event?.giftDetails?.repeat_count,

        event?.gift?.repeatCount,

        event?.gift?.repeat_count
      )
    );

  /*
     ======================================================
     GIFT TYPE
     ======================================================
  */

  const giftType =
    firstNumber(
      event?.giftType,

      event?.gift_type,

      event?.giftDetails?.giftType,

      event?.giftDetails?.gift_type,

      event?.gift?.giftType,

      event?.gift?.gift_type
    );

  /*
     ======================================================
     REPEAT END
     ======================================================
  */

  let repeatEnd = true;

  if (
    event?.repeatEnd !==
    undefined
  ) {
    repeatEnd =
      Boolean(
        event.repeatEnd
      );
  } else if (
    event?.repeat_end !==
    undefined
  ) {
    repeatEnd =
      Boolean(
        event.repeat_end
      );
  } else if (
    event?.giftDetails?.repeatEnd !==
    undefined
  ) {
    repeatEnd =
      Boolean(
        event.giftDetails.repeatEnd
      );
  } else if (
    event?.giftDetails?.repeat_end !==
    undefined
  ) {
    repeatEnd =
      Boolean(
        event.giftDetails.repeat_end
      );
  }

  /*
     ======================================================
     STREAK GIFT

     giftType 1 = streakable.

     Event sementara jangan diproses.
     Hanya proses repeatEnd=true.
     ======================================================
  */

  if (
    Number(giftType) === 1 &&
    repeatEnd === false
  ) {
    return null;
  }

  /*
     ======================================================
     MESSAGE / TRANSACTION ID
     ======================================================
  */

  const msgId =
    event?.msgId ||
    event?.messageId ||
    event?.message_id ||
    event?.transactionId ||
    event?.transaction_id ||
    event?.groupId ||
    event?.group_id ||
    "";

  /*
     ======================================================
     DUPLICATE KEY
     ======================================================
  */

  const fallbackKey = [
    user.userId,

    giftId ||
      "unknown",

    repeatCount,

    diamondCount,

    giftName
  ].join(":");

  const duplicateKey =
    String(
      msgId ||
      fallbackKey
    );

  /*
     ======================================================
     COIN VALUE

     Diamond x repeatCount

     Contoh:
       Rose = 1 diamond
       repeatCount = 3

       total = 3 coin
     ======================================================
  */

  const coinValue =
    diamondCount *
    repeatCount;

  return {
    userId:
      user.userId,

    uniqueId:
      user.uniqueId,

    nickname:
      user.nickname,

    giftId:
      giftId,

    giftName:
      String(
        giftName
      ),

    diamondCount:
      diamondCount,

    repeatCount:
      repeatCount,

    giftType:
      giftType,

    repeatEnd:
      repeatEnd,

    coinValue:
      coinValue,

    duplicateKey:
      duplicateKey,

    timestamp:
      Date.now()
  };
}

/* =========================================================
   DUPLICATE CHECK
   ========================================================= */

function isDuplicateGift(key) {
  if (!key) {
    return false;
  }

  const now =
    Date.now();

  /*
     Bersihkan cache lama
  */

  for (
    const [
      storedKey,
      timestamp
    ]
    of processedGifts.entries()
  ) {
    if (
      now -
        timestamp >
      DUPLICATE_TTL
    ) {
      processedGifts.delete(
        storedKey
      );
    }
  }

  /*
     Sudah pernah diproses
  */

  if (
    processedGifts.has(key)
  ) {
    return true;
  }

  /*
     Simpan
  */

  processedGifts.set(
    key,
    now
  );

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

  if (
    gift.coinValue <= 0
  ) {
    console.log(
      "[GIFT] Gift diterima tetapi diamondCount = 0."
    );

    return;
  }

  /*
     Hanya menerima gift
     ketika auction RUNNING.
  */

  if (
    auctionState !==
    "running"
  ) {
    return;
  }

  /*
     Duplicate protection
  */

  if (
    isDuplicateGift(
      gift.duplicateKey
    )
  ) {
    console.log(
      `[GIFT] Duplicate diabaikan: ${gift.nickname}`
    );

    return;
  }

  /*
     Cari peserta
  */

  let participant =
    participants.get(
      gift.userId
    );

  /*
     Peserta baru
  */

  if (!participant) {
    participant = {
      userId:
        gift.userId,

      uniqueId:
        gift.uniqueId,

      nickname:
        gift.nickname,

      coins:
        0,

      gifts:
        0
    };

    participants.set(
      gift.userId,
      participant
    );
  }

  /*
     Update coin
  */

  participant.coins +=
    gift.coinValue;

  /*
     Update jumlah gift
  */

  participant.gifts +=
    gift.repeatCount;

  /*
     Broadcast
  */

  emitParticipants();

  /*
     Log
  */

  console.log(
    `[GIFT] ${gift.nickname} | ` +
    `${gift.giftName} | ` +
    `${gift.repeatCount}x | ` +
    `${gift.diamondCount} diamond | ` +
    `${gift.coinValue} coin`
  );
}

/* =========================================================
   TIKTOK CONNECT
   ========================================================= */

async function connectTikTok(
  username
) {
  username =
    cleanUsername(
      username
    );

  if (!username) {
    throw new Error(
      "Username TikTok belum diisi."
    );
  }

  /*
     Putuskan koneksi lama
  */

  await disconnectTikTok(
    false
  );

  /*
     Simpan username
  */

  currentUsername =
    username;

  manualDisconnect =
    false;

  /*
     Load connector
  */

  const Connector =
    await loadTikTokConnector();

  /*
     ======================================================
     OPTIONS TIKTOK LIVE CONNECTOR 2.4.4
     ======================================================

     PENTING:

     enableExtendedGiftInfo = false

     supaya connector TIDAK melakukan:

        fetchAvailableGifts()

     saat connect.

     Ini menghindari error:

        Failed to fetch room gifts
        SignatureMissingTokensError
        Empty Payload

     ======================================================
  */

  const options = {
    processInitialData:
      false,

    fetchRoomInfoOnConnect:
      true,

    enableExtendedGiftInfo:
      false,

    webClientOptions: {
      timeout: {
        request: 15000
      }
    },

    wsClientOptions: {
      handshakeTimeout:
        15000
    }
  };

  /*
     ======================================================
     EULER API KEY
     ======================================================
  */

  if (
    EULER_API_KEY
  ) {
    options.signApiKey =
      EULER_API_KEY;

    console.log(
      "[TIKTOK] EULER_API_KEY ditemukan."
    );
  } else {
    console.log(
      "[TIKTOK] EULER_API_KEY tidak diset."
    );

    console.log(
      "[TIKTOK] Menggunakan signing default connector."
    );
  }

  /*
     Buat connection
  */

  const conn =
    new Connector(
      username,
      options
    );

  tiktokConnection =
    conn;

  /*
     ======================================================
     CONNECTED
     ======================================================
  */

  conn.on(
    "connected",
    (state) => {
      tiktokConnected =
        true;

      emitStatus(
        `Terhubung ke TikTok LIVE @${currentUsername}`,
        "success"
      );

      emitAuctionState();

      console.log(
        `[TIKTOK] Connected: @${currentUsername}`
      );

      if (state) {
        console.log(
          "[TIKTOK] Room ID:",
          state.roomId ||
          conn.roomId ||
          "-"
        );
      }
    }
  );

  /*
     ======================================================
     GIFT
     ======================================================
  */

  conn.on(
    "gift",
    (event) => {
      try {
        /*
           Jika auction tidak running,
           gift tidak diproses.
        */

        if (
          auctionState !==
          "running"
        ) {
          return;
        }

        const gift =
          giftData(
            event
          );

        /*
           null = streak sementara
        */

        if (!gift) {
          return;
        }

        applyGift(
          gift
        );
      } catch (error) {
        console.error(
          "[TIKTOK] Gift processing error:",
          error
        );
      }
    }
  );

  /*
     ======================================================
     CHAT
     ======================================================
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
     ======================================================
     ERROR
     ======================================================
  */

  conn.on(
    "error",
    (error) => {
      console.error(
        "[TIKTOK] Error:",
        error
      );

      tiktokConnected =
        false;

      emitStatus(
        formatError(
          error
        ),
        "error"
      );
    }
  );

  /*
     ======================================================
     DISCONNECTED
     ======================================================
  */

  conn.on(
    "disconnected",
    () => {
      console.log(
        "[TIKTOK] Disconnected"
      );

      tiktokConnected =
        false;

      emitStatus(
        "Koneksi TikTok LIVE terputus.",
        "warning"
      );

      /*
         Auto reconnect
      */

      if (
        !manualDisconnect
      ) {
        scheduleReconnect();
      }
    }
  );

  /*
     ======================================================
     CONNECT
     ======================================================
  */

  try {
    emitStatus(
      `Menghubungkan ke @${currentUsername}...`,
      "info"
    );

    console.log(
      `[TIKTOK] Connecting @${currentUsername}...`
    );

    const result =
      await conn.connect();

    /*
       Jika berhasil
    */

    tiktokConnected =
      true;

    console.log(
      `[TIKTOK] Connect berhasil @${currentUsername}`
    );

    return (
      result ||
      true
    );
  } catch (error) {
    tiktokConnected =
      false;

    console.error(
      "[TIKTOK] Connect error:",
      error
    );

    emitStatus(
      formatError(
        error
      ),
      "error"
    );

    /*
       Auto reconnect
    */

    if (
      !manualDisconnect
    ) {
      scheduleReconnect();
    }

    return false;
  }
}

/* =========================================================
   RECONNECT
   ========================================================= */

function scheduleReconnect() {
  if (
    manualDisconnect
  ) {
    return;
  }

  if (
    reconnectTimer
  ) {
    return;
  }

  reconnectTimer =
    setTimeout(
      async () => {
        reconnectTimer =
          null;

        if (
          manualDisconnect
        ) {
          return;
        }

        if (
          !currentUsername
        ) {
          return;
        }

        console.log(
          `[TIKTOK] Reconnecting @${currentUsername}...`
        );

        try {
          await connectTikTok(
            currentUsername
          );
        } catch (error) {
          console.error(
            "[TIKTOK] Reconnect error:",
            error
          );
        }
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
  if (
    setManual
  ) {
    manualDisconnect =
      true;
  }

  /*
     Stop reconnect timer
  */

  if (
    reconnectTimer
  ) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer =
      null;
  }

  /*
     Disconnect connector
  */

  if (
    tiktokConnection
  ) {
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

  /*
     Clear connection
  */

  tiktokConnection =
    null;

  tiktokConnected =
    false;

  /*
     Status
  */

  emitStatus(
    "TikTok LIVE tidak terhubung.",
    "info"
  );
}

/* =========================================================
   AUCTION TIMER
   ========================================================= */

function stopAuctionTimer() {
  if (
    auctionTimer
  ) {
    clearInterval(
      auctionTimer
    );

    auctionTimer =
      null;
  }
}

function startAuctionTimer() {
  stopAuctionTimer();

  auctionTimer =
    setInterval(
      () => {
        /*
           Jika bukan running,
           jangan kurangi timer.
        */

        if (
          auctionState !==
          "running"
        ) {
          return;
        }

        /*
           Waktu habis
        */

        if (
          auctionRemaining <=
          0
        ) {
          auctionRemaining =
            0;

          auctionState =
            "finished";

          stopAuctionTimer();

          emitAuctionState();

          console.log(
            "[AUCTION] Finished"
          );

          return;
        }

        /*
           Kurangi 1 detik
        */

        auctionRemaining--;

        emitAuctionState();

        /*
           Jika tepat 0
        */

        if (
          auctionRemaining <=
          0
        ) {
          auctionRemaining =
            0;

          auctionState =
            "finished";

          stopAuctionTimer();

          emitAuctionState();

          console.log(
            "[AUCTION] Finished"
          );
        }
      },
      1000
    );
}

/* =========================================================
   AUCTION START
   ========================================================= */

function startAuction(
  duration
) {
  const parsedDuration =
    Number(duration);

  if (
    Number.isFinite(
      parsedDuration
    ) &&
    parsedDuration > 0
  ) {
    auctionDuration =
      Math.floor(
        parsedDuration
      );
  }

  auctionRemaining =
    auctionDuration;

  auctionState =
    "running";

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
    auctionState !==
    "running"
  ) {
    return;
  }

  auctionState =
    "paused";

  stopAuctionTimer();

  emitAuctionState();

  console.log(
    "[AUCTION] Paused"
  );
}

/* =========================================================
   AUCTION RESET
   ========================================================= */

function resetAuction(
  duration
) {
  stopAuctionTimer();

  const parsedDuration =
    Number(duration);

  if (
    Number.isFinite(
      parsedDuration
    ) &&
    parsedDuration > 0
  ) {
    auctionDuration =
      Math.floor(
        parsedDuration
      );
  }

  auctionRemaining =
    auctionDuration;

  auctionState =
    "idle";

  /*
     Reset peserta
  */

  participants.clear();

  /*
     Reset duplicate cache
  */

  processedGifts.clear();

  /*
     Broadcast
  */

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

  auctionState =
    "finished";

  auctionRemaining =
    0;

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
       ====================================================
       INITIAL LIVE STATUS
       ====================================================
    */

    socket.emit(
      "live:status",
      {
        connected:
          tiktokConnected,

        username:
          currentUsername,

        state:
          auctionState,

        message:
          tiktokConnected
            ? `Terhubung ke @${currentUsername}`
            : "TikTok LIVE belum terhubung.",

        type:
          tiktokConnected
            ? "success"
            : "info",

        timestamp:
          Date.now()
      }
    );

    /*
       ====================================================
       INITIAL AUCTION STATE
       ====================================================
    */

    socket.emit(
      "auction:state",
      {
        state:
          auctionState,

        remaining:
          auctionRemaining,

        duration:
          auctionDuration,

        participants:
          Array.from(
            participants.values()
          )
      }
    );

    /*
       ====================================================
       INITIAL PARTICIPANTS
       ====================================================
    */

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
        try {
          const username =
            cleanUsername(
              data.username ||
              currentUsername ||
              DEFAULT_USERNAME
            );

          if (
            !username
          ) {
            socket.emit(
              "live:status",
              {
                connected:
                  false,

                username:
                  "",

                state:
                  auctionState,

                message:
                  "Masukkan username TikTok terlebih dahulu.",

                type:
                  "error",

                timestamp:
                  Date.now()
              }
            );

            return;
          }

          await connectTikTok(
            username
          );
        } catch (error) {
          console.error(
            "[SOCKET] live:connect error:",
            error
          );

          socket.emit(
            "live:status",
            {
              connected:
                false,

              username:
                currentUsername,

              state:
                auctionState,

              message:
                formatError(
                  error
                ),

              type:
                "error",

              timestamp:
                Date.now()
            }
          );
        }
      }
    );

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {
        try {
          await disconnectTikTok(
            true
          );
        } catch (error) {
          console.error(
            "[SOCKET] live:disconnect error:",
            error
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
        const requestedState =
          data.state;

        switch (
          requestedState
        ) {
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
      ok:
        true,

      server:
        "tiktok-live-coin-auction",

      connector:
        "tiktok-live-connector 2.4.4",

      tiktok: {
        connected:
          tiktokConnected,

        username:
          currentUsername
      },

      auction: {
        state:
          auctionState,

        remaining:
          auctionRemaining,

        duration:
          auctionDuration
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
      connected:
        tiktokConnected,

      username:
        currentUsername,

      auction: {
        state:
          auctionState,

        remaining:
          auctionRemaining,

        duration:
          auctionDuration
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
      __dirname +
        "/index.html"
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
      "Connector : tiktok-live-connector 2.4.4"
    );

    console.log(
      "Extended  : DISABLED"
    );

    console.log(
      `Euler Key : ${
        EULER_API_KEY
          ? "AVAILABLE"
          : "NOT SET"
      }`
    );

    console.log(
      "================================================="
    );
  }
);
