const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const server =
  http.createServer(app);

const io =
  new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

app.use(express.json());

app.use(
  express.static(__dirname)
);

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

const participants =
  new Map();

/*
  Cache event gift untuk mencegah
  event yang sama dihitung dua kali.
*/

const processedGiftEvents =
  new Map();

const GIFT_TTL =
  60 * 1000;

/* =========================================================
   LOAD TIKTOK CONNECTOR
   ========================================================= */

async function loadTikTokConnector() {

  if (TikTokLiveConnection) {
    return TikTokLiveConnection;
  }

  const mod =
    await import(
      "tiktok-live-connector"
    );

  TikTokLiveConnection =
    mod.TikTokLiveConnection ||
    mod.default?.TikTokLiveConnection ||
    mod.default;

  if (
    typeof TikTokLiveConnection !==
    "function"
  ) {

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
      "");
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
      message,
      ok
    }
  );
}

/* =========================================================
   ERROR
   ========================================================= */

function formatError(err) {

  const msg =
    err?.message ||
    String(err) ||
    "Gagal terhubung ke TikTok LIVE.";

  const s =
    msg.toLowerCase();

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

  for (
    const v of values
  ) {

    if (
      v === null ||
      v === undefined ||
      v === ""
    ) {
      continue;
    }

    const n =
      Number(v);

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

  const userId =
    String(
      user.userId ||
      user.user_id ||
      user.id ||
      event?.userId ||
      event?.user_id ||
      event?.uid ||
      "unknown"
    );

  const uniqueId =
    String(
      user.uniqueId ||
      user.unique_id ||
      event?.uniqueId ||
      event?.unique_id ||
      event?.nickname ||
      user.nickname ||
      "Viewer"
    );

  const nickname =
    String(
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

  const user =
    userData(event);

  const giftId =
    String(
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
    (
      giftId
        ? `Gift #${giftId}`
        : "Gift"
    );

  const diamondCount =
    firstNumber(

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

  const repeatCount =
    Math.max(
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

  /*
    Gift streak:
    hanya hitung event terakhir.
  */

  if (
    giftType === 1 &&
    !repeatEnd
  ) {
    return null;
  }

  if (
    diamondCount <= 0
  ) {

    console.warn(
      "[GIFT] Diamond value tidak ditemukan:",
      JSON.stringify(event)
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

  const eventKey =
    String(
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

  const now =
    Date.now();

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

  if (
    processedGiftEvents.has(
      eventKey
    )
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
     COIN
     ======================================================= */

  const coinValue =
    diamondCount *
    repeatCount;

  if (
    !Number.isFinite(
      coinValue
    ) ||
    coinValue <= 0
  ) {

    return null;
  }

  return {

    username:
      user.uniqueId,

    nickname:
      user.nickname,

    userId:
      user.userId,

    avatar:
      user.avatar,

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

  return Array.from(
    participants.values()
  ).sort(
    (a, b) =>
      b.coins - a.coins ||
      a.joinedAt - b.joinedAt
  );
}

/* =========================================================
   AUCTION STATE BROADCAST
   ========================================================= */

function emitAuctionState() {

  io.emit(
    "auction:state",
    {
      state: auctionState,

      active:
        auctionState ===
        "running",

      version:
        auctionVersion
    }
  );
}

/* =========================================================
   PARTICIPANTS BROADCAST
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

  console.log(
    "[AUCTION] Semua peserta dan coin dihapus."
  );
}

/* =========================================================
   APPLY GIFT
   ========================================================= */

function applyGift(gift) {

  const key =
    gift.userId ||
    gift.username;

  let p =
    participants.get(key);

  if (!p) {

    p = {

      userId: key,

      username:
        gift.username,

      nickname:
        gift.nickname,

      avatar:
        gift.avatar ||
        null,

      coins: 0,

      gifts: 0,

      joinedAt:
        Date.now()
    };

    participants.set(
      key,
      p
    );
  }

  p.username =
    gift.username ||
    p.username;

  p.nickname =
    gift.nickname ||
    p.nickname;

  p.avatar =
    gift.avatar ||
    p.avatar;

  /*
    Tambahkan coin sesuai gift.
  */

  p.coins +=
    gift.coinValue;

  p.gifts +=
    gift.repeatCount;

  const snapshot =
    {
      ...p
    };

  broadcastParticipants();

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
   STOP CONNECTION
   ========================================================= */

async function stopConnection() {

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer =
    null;

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

  manualDisconnect =
    false;

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
    event => {

      console.log(
        `[TikTok] Gift event @${activeUsername} | auction=${auctionState}`
      );

      /*
        PENTING:
        Gift hanya diterima
        ketika auctionState = running.
      */

      if (
        auctionState !==
        "running"
      ) {

        console.log(
          "[GIFT] Diabaikan: lelang tidak sedang berjalan."
        );

        return;
      }

      const gift =
        giftData(event);

      if (gift) {

        console.log(
          `[GIFT] @${gift.username} | ${gift.giftName} | ${gift.diamondCount} x ${gift.repeatCount} = ${gift.coinValue}`
        );

        applyGift(gift);
      }
    }
  );

  /* =======================================================
     CHAT
     ======================================================= */

  conn.on(
    "chat",
    event => {

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
    state => {

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
    err => {

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
                err =>
                  emitStatus(
                    `Reconnect gagal: ${formatError(err)}`
                  )
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

io.on(
  "connection",
  socket => {

    console.log(
      "[Socket] Client terhubung:",
      socket.id
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

    /*
      Kirim state terbaru.
    */

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

    /*
      Kirim peserta terbaru.
    */

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
      async data => {

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
       ===================================================== */

    socket.on(
      "auction:state",
      data => {

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

        /*
          Naikkan version ketika
          state penting berubah.
        */

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
          ===================================================
          PENTING
          ===================================================

          IDLE = reset/kosongkan.

          FINISHED = JANGAN kosongkan.

          Jadi peserta tetap tampil
          setelah tombol SELESAI.
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
       RESET
       ===================================================== */

    socket.on(
      "auction:reset",
      () => {

        console.log(
          "[Auction] RESET diterima dari client"
        );

        /*
          Versi dinaikkan terlebih dahulu.
        */

        auctionVersion++;

        /*
          Status kembali idle.
        */

        auctionState =
          "idle";

        /*
          HAPUS peserta + coin.
        */

        resetParticipants();

        /*
          Broadcast state.
        */

        emitAuctionState();

        console.log(
          "[Auction] RESET selesai."
        );
      }
    );

    /* =====================================================
       DISCONNECT TIKTOK
       ===================================================== */

    socket.on(
      "live:disconnect",
      async () => {

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
      "Gift hanya diterima saat auctionState = running."
    );

    console.log(
      "FINISHED mempertahankan peserta."
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
   ERROR HANDLING
   ========================================================= */

process.on(
  "unhandledRejection",
  reason =>
    console.error(
      "[PROCESS] Unhandled Promise Rejection:",
      reason
    )
);

process.on(
  "uncaughtException",
  error =>
    console.error(
      "[PROCESS] Uncaught Exception:",
      error
    )
);
