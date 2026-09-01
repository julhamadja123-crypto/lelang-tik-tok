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

let TikTokLiveConnection = null;
let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
let manualDisconnect = false;
let auctionActive = false;

const processedGiftEvents = new Map();
const GIFT_TTL = 60 * 1000;

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
      "TikTokLiveConnection tidak ditemukan. Pastikan tiktok-live-connector 2.4.4 terinstall."
    );
  }

  return TikTokLiveConnection;
}

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

function emitStatus(message, ok = false) {
  console.log(`[STATUS] ${message}`);

  io.emit("live:status", {
    message,
    ok
  });
}

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
    return (
      "TikTok/signing provider menolak koneksi tanpa API key. " +
      "Coba lagi nanti atau gunakan username LIVE lain."
    );
  }

  return msg;
}

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

  for (
    const [key, time] of processedGiftEvents
  ) {
    if (now - time > GIFT_TTL) {
      processedGiftEvents.delete(key);
    }
  }

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
    `[GIFT] @${user.uniqueId} | ` +
    `${giftName} | ` +
    `${diamondCount} x ${repeatCount} = ${coinValue}`
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
    "[TikTok] Package: tiktok-live-connector 2.4.4"
  );

  console.log(
    "================================================"
  );

  emitStatus(
    `Mencari LIVE @${username}...`
  );

  /*
   * Tidak ada signApiKey di sini.
   */
  const conn = new Connector(
    username,
    {
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
    }
  );

  liveConnection = conn;

  conn.on(
    "gift",
    (event) => {
      if (!auctionActive) {
        return;
      }

      const gift =
        giftData(event);

      if (!gift) {
        return;
      }

      io.emit(
        "live:gift",
        gift
      );
    }
  );

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

  conn.on(
    "connected",
    (state) => {
      console.log(
        "[TikTok] connected:",
        state
      );
    }
  );

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

    const friendly
