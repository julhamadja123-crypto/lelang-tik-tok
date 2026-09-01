const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

let liveConnection = null;
let activeUsername = null;
let reconnectTimer = null;
// Gift hanya boleh diteruskan saat lelang benar-benar aktif.
let auctionActive = false;

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, "")
    .replace(/\/live.*$/i, "")
    .replace(/^@/, "")
    .replace(/\s+/g, "");
}

async function stopConnection() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (liveConnection) {
    try { await liveConnection.disconnect(); } catch (_) {}
  }
  liveConnection = null;
}

function emitStatus(message, ok = false) {
  io.emit("live:status", { message, ok });
}

// Menyimpan ID event yang sudah diproses agar reconnect/polling tidak membuat coin dobel.
const processedGiftEvents = new Map();
const PROCESSED_GIFT_TTL = 60 * 1000;

function toPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function cleanupProcessedGiftEvents(now = Date.now()) {
  for (const [key, time] of processedGiftEvents) {
    if (now - time > PROCESSED_GIFT_TTL) processedGiftEvents.delete(key);
  }
}

function getGiftData(event) {
  // Format utama connector v2 memakai field level atas.
  // Beberapa versi masih menyimpan data di giftDetails / gift / extendedGiftInfo.
  const details = event.giftDetails || event.giftInfo || event.gift || {};
  const rawGift = event.gift || {};
  const extended = event.extendedGiftInfo || event.giftDetails?.extendedGiftInfo || {};

  const giftId = String(
    event.giftId ?? details.giftId ?? details.gift_id ?? rawGift.giftId ?? rawGift.gift_id ?? extended.id ?? ''
  );

  const giftName =
    event.giftName ||
    details.giftName || details.name ||
    extended.giftName || extended.name ||
    `Gift #${giftId || '?'}`;

  // Harga gift harus berasal dari data TikTok. Tidak ada nilai default agar tidak "asal".
  const diamondCount = toPositiveNumber(
    event.diamondCount,
    event.diamond_count,
    details.diamondCount,
    details.diamond_count,
    extended.diamondCount,
    extended.diamond_count,
    extended.diamondCost,
    extended.diamond_cost,
    event.gift?.diamondCount,
    event.gift?.diamond_count,
    event.gift?.diamondCost,
    event.gift?.diamond_cost,
    event.giftDetails?.gift?.diamondCount
  );

  const repeatCount = Math.max(1, Math.floor(toPositiveNumber(
    event.repeatCount,
    event.repeat_count,
    rawGift.repeatCount,
    rawGift.repeat_count,
    1
  )));

  const giftType = Number(
    event.giftType ?? details.giftType ?? details.gift_type ?? rawGift.giftType ?? rawGift.gift_type ?? 0
  );

  const repeatEndRaw = event.repeatEnd ?? event.repeat_end ?? rawGift.repeatEnd ?? rawGift.repeat_end;
  const repeatEnd = repeatEndRaw === true || repeatEndRaw === 1 || repeatEndRaw === '1' || repeatEndRaw === 'true';

  // Aturan resmi connector: giftType 1 dikirim selama streak berlangsung,
  // lalu event terakhir repeatEnd=true membawa jumlah akhir. Hitung hanya event akhir.
  if (giftType === 1 && !repeatEnd) return null;

  if (!giftId || diamondCount <= 0) {
    const debug = {
      giftId, giftName, diamondCount, repeatCount,
      msgId: event.msgId, groupId: event.groupId,
      keys: Object.keys(event || {})
    };
    console.warn('Gift diterima tetapi nilai coin belum terbaca', debug);
    io.emit('live:gift-debug', {
      message: `Gift ${giftName} diterima, tetapi harga coin belum terbaca dari TikTok. Pastikan server memakai koneksi gift info terbaru.`,
      debug
    });
    return null;
  }

  // Untuk streak, repeatCount pada event akhir adalah TOTAL jumlah gift.
  // Jadi nilai akhir = harga 1 gift × repeatCount.
  const coinValue = diamondCount * repeatCount;
  if (!Number.isFinite(coinValue) || coinValue <= 0) return null;

  const userId = event.user?.userId || event.user?.id || event.userId || event.user_id || 'unknown';
  const uniqueId = event.user?.uniqueId || event.uniqueId || event.user?.nickname || event.nickname || 'Viewer';

  // msgId paling aman untuk event unik. Jika tidak tersedia, gunakan groupId + data final.
  const eventKey = String(
    event.msgId ||
    `${event.groupId || ''}|${userId}|${giftId}|${repeatCount}|${event.createTime || event.timestamp || ''}|${repeatEnd}`
  );

  cleanupProcessedGiftEvents();
  if (processedGiftEvents.has(eventKey)) {
    console.log('Gift duplikat diabaikan:', eventKey);
    return null;
  }
  processedGiftEvents.set(eventKey, Date.now());

  console.log(`Gift valid: ${uniqueId} | ${giftName} | ${diamondCount} x ${repeatCount} = ${coinValue}`);

  return {
    username: uniqueId,
    nickname: event.user?.nickname || event.nickname || uniqueId,
    giftName,
    giftId,
    coinValue,
    diamondCount,
    repeatCount,
    msgId: event.msgId || null,
    groupId: event.groupId || null,
    avatar: event.user?.profilePictureUrl || event.user?.profilePicture?.url || event.user?.profilePicture?.urls?.[0] || event.profilePictureUrl || event.profilePicture || null
  };
}

async function connectToLive(rawUsername) {
  const username = cleanUsername(rawUsername);
  if (!username) throw new Error("Username TikTok kosong.");

  await stopConnection();
  activeUsername = username;

  emitStatus(`Mencari LIVE @${username}...`);

  // Penting: extended gift info dimatikan saat koneksi.
  // Pada beberapa koneksi TikTok, fetch gift list dapat menghasilkan 403 dan membuat connect gagal.
  const conn = new TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: true,
    requestPollingIntervalMs: 1000
  });

  liveConnection = conn;

  conn.on(WebcastEvent.GIFT, (event) => {
    console.log("Gift event diterima", { active: auctionActive, giftId: event?.giftId, giftName: event?.giftName });
    if (!auctionActive) return;
    const gift = getGiftData(event);
    if (!gift) return;
    io.emit("live:gift", gift);
  });

  conn.on(WebcastEvent.CHAT, () => {
    io.emit("live:event", { type: "chat" });
  });

  conn.on("disconnected", () => {
    emitStatus(`Koneksi @${activeUsername} terputus. Mencoba ulang...`);
    if (activeUsername) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectToLive(activeUsername).catch(err => {
          emitStatus(`Reconnect gagal: ${err.message}`);
        });
      }, 5000);
    }
  });

  conn.on("error", (err) => {
    emitStatus(`Error TikTok: ${err?.message || "unknown error"}`);
  });

  try {
    const state = await conn.connect();
    emitStatus(
      `Terhubung ke LIVE @${username} • Room ${state.roomId || "aktif"}`,
      true
    );
    return state;
  } catch (err) {
    if (liveConnection === conn) liveConnection = null;
    const message = err?.message || String(err) || "Gagal terhubung ke TikTok LIVE";
    emitStatus(`Gagal terhubung @${username}: ${message}`);
    throw err;
  }

}

io.on("connection", (socket) => {
  socket.emit("live:status", {
    ok: Boolean(liveConnection?.isConnected),
    message: liveConnection?.isConnected
      ? `Terhubung ke @${activeUsername}`
      : "Belum terhubung ke TikTok LIVE"
  });

  socket.on("live:connect", async ({ username }) => {
    try {
      await connectToLive(username);
    } catch (err) {
      socket.emit("live:error", {
        message: err?.message || "Gagal menghubungkan TikTok LIVE."
      });
    }
  });

  socket.on("auction:state", ({ active }) => {
    auctionActive = Boolean(active);
    console.log(`Auction state: ${auctionActive ? "ACTIVE" : "INACTIVE"}`);
  });

  socket.on("live:disconnect", async () => {
    auctionActive = false;
    await stopConnection();
    activeUsername = null;
    emitStatus("Koneksi TikTok LIVE diputus.");
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("TikTok LIVE Coin Auction:");
  console.log(`http://localhost:${process.env.PORT || 3000}`);
});
