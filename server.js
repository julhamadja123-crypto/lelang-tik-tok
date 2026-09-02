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

app.use(express.json());
app.use(express.static(__dirname));

/* =========================================================
   TIKTOK CONNECTION
   ========================================================= */

let TikTokLiveConnection = null;
let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
let manualDisconnect = false;

/* =========================================================
   AUCTION STATE
   ========================================================= */

let auctionState = "idle";
let auctionVersion = 0;

/*
   idle
   running
   paused
   finished
*/

/* =========================================================
   PARTICIPANTS
   ========================================================= */

const participants = new Map();

/* =========================================================
   PROCESSED GIFT CACHE
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
    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\/@/i,
      ""
    )
    .replace(
      /^https?:\/\/(www\.)?tiktok\.com\//i,
      ""
    )
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

function firstNumber(...values) {
  for (const v of values) {
    if (
      v === null ||
      v === undefined ||
      v === ""
    ) {
      continue;
    }

    const n = Number(v);

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
    event?.user ||
    event?.userInfo ||
    event?.userDetails ||
    {};

  const userId = String(
    user.userId ||
    user.user_id ||
    user.id ||
    event?.userId ||
    event?.user_id ||
    event?.uid ||
    "unknown"
  );

  const uniqueId = String(
    user.uniqueId ||
    user.unique_id ||
    event?.uniqueId ||
    event?.unique_id ||
    event?.nickname ||
    user.nickname ||
    "Viewer"
  );

  const nickname = String(
    user.nickname ||
    user.displayName ||
    event?.nickname ||
    event?.displayName ||
    uniqueId ||
    "Viewer"
  );

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
    userId,
    uniqueId,
    nickname,
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

  const giftId = String(
    event.giftId ??
    event.gift_id ??
    event.gift?.giftId ??
    event.gift?.gift_id ??
    event.gift?.id ??
    event.giftDetails?.giftId ??
    event.giftDetails?.gift_id ??
    event.giftDetails?.id ??
    event.extendedGiftInfo?.giftId ??
    event.extendedGiftInfo?.gift_id ??
    event.extendedGiftInfo?.id ??
    ""
  );

  const giftName =
    event.giftName ||
    event.gift_name ||
    event.gift?.giftName ||
    event.gift?.gift_name ||
    event.gift?.name ||
    event.giftDetails?.giftName ||
    event.giftDetails?.gift_name ||
    event.giftDetails?.name ||
    (giftId ? `Gift #${giftId}` : "Gift");

  const diamondCount = firstNumber(
    event.diamondCount,
    event.diamond_count,
    event.diamondCost,
    event.diamond_cost,

    event.gift?.diamondCount,
    event.gift?.diamond_count,
    event.gift?.diamondCost,
    event.gift?.diamond_cost,
    event.gift?.diamond,

    event.giftDetails?.diamondCount,
    event.giftDetails?.diamond_count,
    event.giftDetails?.diamondCost,
    event.giftDetails?.diamond_cost,
    event.giftDetails?.diamond,

    event.extendedGiftInfo?.diamondCount,
    event.extendedGiftInfo?.diamond_count,
    event.extendedGiftInfo?.diamondCost,
    event.extendedGiftInfo?.diamond_cost
  );

  const repeatCount = Math.max(
    1,
    Math.floor(
      firstNumber(
        event.repeatCount,
        event.repeat_count,

        event.gift?.repeatCount,
        event.gift?.repeat_count,

        event.giftDetails?.repeatCount,
        event.giftDetails?.repeat_count,

        event.extendedGiftInfo?.repeatCount,
        event.extendedGiftInfo?.repeat_count,

        1
      )
    )
  );

  const giftType =
    Number(
      event.giftType ??
      event.gift_type ??
      event.gift?.giftType ??
      event.gift?.gift_type ??
      event.giftDetails?.giftType ??
      event.giftDetails?.gift_type ??
      0
    ) || 0;

  const repeatValue =
    event.repeatEnd ??
    event.repeat_end ??
    event.gift?.repeatEnd ??
    event.gift?.repeat_end ??
    event.giftDetails?.repeatEnd ??
    event.giftDetails?.repeat_end;

  const repeatEnd =
    repeatValue === undefined ||
    repeatValue === null
      ? true
      : (
          repeatValue === true ||
          repeatValue === 1 ||
          repeatValue === "1" ||
          repeatValue === "true"
        );

  /* =======================================================
     STREAK PROTECTION
     ======================================================= */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    return null;
  }

  if (diamondCount <= 0) {
    console.warn(
      "[GIFT] Nilai coin/diamond tidak ditemukan."
    );

    return null;
  }

  /* =======================================================
     DUPLICATE PROTECTION
     ======================================================= */

  const directId =
    event.msgId ||
    event.msg_id ||
    event.messageId ||
    event.message_id ||
    event.transactionId ||
    event.transaction_id ||
    event.eventId ||
    event.event_id;

  const eventKey = String(
    directId ||
    [
      event.groupId ||
      event.group_id ||
      "",

      user.userId,

      giftId ||
      giftName,

      repeatCount,

      event.createTime ||
      event.create_time ||
      event.timestamp ||
      "",

      repeatEnd
    ].join("|")
  );

  const now = Date.now();

  for (
    const [key, time]
    of processedGiftEvents
  ) {
    if (
      now - time >
      GIFT_TTL
    ) {
      processedGiftEvents.delete(key);
    }
  }

  if (
    processedGiftEvents.has(eventKey)
  ) {
    console.log(
      "[GIFT] Duplicate diabaikan:",
      eventKey
    );

    return null;
  }

  processedGiftEvents.set(
    eventKey,
    now
  );

  /* =======================================================
     COIN CALCULATION
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

  return {
    username: user.uniqueId,
    nickname: user.nickname,
    userId: user.userId,
    avatar: user.avatar,

    giftName,
    giftId,

    diamondCount,
    repeatCount,

    coinValue,

    giftType,
    repeatEnd,

    msgId:
      event.msgId ||
      event.msg_id ||
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
   PARTICIPANT SNAPSHOT
   ========================================================= */

function participantSnapshot() {
  return Array
    .from(participants.values())
    .sort(
      (a, b) =>
        b.coins - a.coins ||
        a.joinedAt - b.joinedAt
    );
}

/* =========================================================
   EMIT AUCTION STATE
   ========================================================= */

function emitAuctionState() {
  io.emit(
    "auction:state",
    {
      state: auctionState,

      active:
        auctionState === "running",

      version:
        auctionVersion
    }
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
        participantSnapshot(),

      count:
        participants.size,

      version:
        auctionVersion
    }
  );
}

/* =========================================================
   RESET PARTICIPANTS
   ========================================================= */

function resetParticipants() {
  participants.clear();

  broadcastParticipants();
}

/* =========================================================
   APPLY GIFT
   ========================================================= */

function applyGift(gift) {
  const key =
    gift.userId ||
    gift.username;

  let participant =
    participants.get(key);

  if (!participant) {
    participant = {
      userId: key,

      username:
        gift.username,

      nickname:
        gift.nickname,

      avatar:
        gift.avatar || null,

      coins: 0,

      gifts: 0,

      joinedAt:
        Date.now()
    };

    participants.set(
      key,
      participant
    );
  }

  participant.username =
    gift.username ||
    participant.username;

  participant.nickname =
    gift.nickname ||
    participant.nickname;

  participant.avatar =
    gift.avatar ||
    participant.avatar;

  /*
    1 coin = +1
    3 coin = +3
  */

  participant.coins +=
    gift.coinValue;

  participant.gifts +=
    gift.repeatCount;

  const snapshot =
    { ...participant };

  broadcastParticipants();

  /*
    live:gift hanya dikirim
    jika server sudah menerima
    gift tersebut.
  */

  io.emit(
    "live:gift",
    {
      ...gift,

      participant:
        snapshot,

      auctionState,

      version:
        auctionVersion
    }
  );
}

/* =========================================================
   STOP TIKTOK CONNECTION
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
        err?.message ||
        err
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

  manualDisconnect = false;

  activeUsername =
    username;

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
            request:
              15000
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
     GIFT
     ======================================================= */

  conn.on(
    "gift",
    (event) => {
      console.log(
        `[TikTok] Gift @${activeUsername} | auction=${auctionState}`
      );

      /*
        SERVER AUTHORITATIVE

        Gift hanya diterima saat
        lelang benar-benar RUNNING.
      */

      if (
        auctionState !==
        "running"
      ) {
        console.log(
          "[GIFT] Diabaikan karena lelang tidak RUNNING."
        );

        return;
      }

      const gift =
        giftData(event);

      if (!gift) {
        return;
      }

      console.log(
        `[GIFT] @${gift.username} | ${gift.giftName} | ${gift.diamondCount} x ${gift.repeatCount} = ${gift.coinValue}`
      );

      applyGift(gift);
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
          type:
            "chat",

          username:
            event?.user
              ?.uniqueId ||
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
    (data) => {
      console.log(
        "[TikTok] Connected:",
        data
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
        "[TikTok] Error:",
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
    const result =
      await conn.connect();

    if (
      liveConnection !==
      conn
    ) {
      try {
        await conn.disconnect();
      } catch (_) {}

      throw new Error(
        "Koneksi TikTok digantikan oleh koneksi lain."
      );
    }

    const roomId =
      result?.roomId ||
      conn.roomId ||
      "aktif";

    emitStatus(
      `Terhubung ke LIVE @${username} • Room ${roomId}`,
      true
    );

    console.log(
      `[TikTok] BERHASIL TERHUBUNG @${username}`
    );

    return result;

  } catch (err) {
    if (
      liveConnection ===
      conn
    ) {
      liveConnection =
        null;
    }

    const friendly =
      formatError(err);

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
      "[Socket] Client terhubung:",
      socket.id
    );

    /* =====================================================
       STATUS AWAL
       ===================================================== */

    const connected =
      Boolean(
        liveConnection
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
       AUCTION STATE AWAL
       ===================================================== */

    socket.emit(
      "auction:state",
      {
        state:
          auctionState,

        active:
          auctionState ===
          "running",

        version:
          auctionVersion
      }
    );

    /* =====================================================
       PARTICIPANTS AWAL
       ===================================================== */

    socket.emit(
      "auction:participants",
      {
        participants:
          participantSnapshot(),

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

       IMPORTANT:

       FINISHED TIDAK MENGHAPUS PARTICIPANTS.

       HANYA IDLE YANG BOLEH
       MENGHAPUS PARTICIPANTS.
       ===================================================== */

    socket.on(
      "auction:state",
      (data = {}) => {

        let next =
          data.state;

        if (!next) {
          next =
            data.active
              ? "running"
              : "idle";
        }

        if (
          ![
            "running",
            "paused",
            "idle",
            "finished"
          ].includes(next)
        ) {
          return;
        }

        const changed =
          next !==
          auctionState;

        auctionState =
          next;

        if (
          changed &&
          (
            next === "running" ||
            next === "idle" ||
            next === "finished"
          )
        ) {
          auctionVersion++;
        }

        /*
          =================================================
          PENTING
          =================================================

          FINISHED TIDAK RESET.

          IDLE BOLEH RESET.
        */

        if (
          next === "idle"
        ) {
          resetParticipants();
        }

        emitAuctionState();

        console.log(
          `[Auction] ${auctionState.toUpperCase()}`
        );
      }
    );

    /* =====================================================
       AUCTION RESET
       ===================================================== */

    socket.on(
      "auction:reset",
      () => {

        console.log(
          "[Auction] RESET"
        );

        auctionState =
          "idle";

        auctionVersion++;

        resetParticipants();

        emitAuctionState();
      }
    );

    /* =====================================================
       MANUAL TIKTOK DISCONNECT
       ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {

        console.log(
          "[TikTok] Disconnect manual"
        );

        auctionState =
          "idle";

        auctionVersion++;

        resetParticipants();

        emitAuctionState();

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
          "[Socket] Client terputus:",
          socket.id
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

    res.json({
      ok: true,

      connected:
        Boolean(
          liveConnection
        ),

      username:
        activeUsername,

      auctionState,

      auctionActive:
        auctionState ===
        "running",

      participants:
        participants.size,

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
      "Gift hanya diterima saat RUNNING."
    );

    console.log(
      "PAUSE menolak gift."
    );

    console.log(
      "FINISHED tidak menghapus peserta."
    );

    console.log(
      "RESET menghapus peserta."
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
