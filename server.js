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

function getGiftData(event) {
  // Versi SDK baru dapat menyimpan info gift di beberapa field.
  const details = event.giftDetails || event.extendedGiftInfo || {};
  const giftName = details.giftName || event.giftName || `Gift #${event.giftId || ""}`;
  const diamondCount = Number(
    details.diamondCount ??
    details.diamond_count ??
    event.diamondCount ??
    0
  );

  // Streak gift mengirim beberapa event. Hitung hanya event final untuk menghindari double count.
  const repeatCount = Number(event.repeatCount || 1);
  const giftType = Number(details.giftType ?? event.giftType ?? 0);
  const repeatEnd = Boolean(event.repeatEnd);

  if (giftType === 1 && !repeatEnd) return null;

  return {
    username: event.user?.uniqueId || event.user?.nickname || "Viewer",
    nickname: event.user?.nickname || event.user?.uniqueId || "Viewer",
    giftName,
    coinValue: Math.max(1, diamondCount * repeatCount),
    diamondCount,
    repeatCount
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
    enableExtendedGiftInfo: false,
    requestPollingIntervalMs: 1000
  });

  liveConnection = conn;

  conn.on(WebcastEvent.GIFT, (event) => {
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

  socket.on("live:disconnect", async () => {
    await stopConnection();
    activeUsername = null;
    emitStatus("Koneksi TikTok LIVE diputus.");
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("TikTok LIVE Coin Auction:");
  console.log(`http://localhost:${process.env.PORT || 3000}`);
});
