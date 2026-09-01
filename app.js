/* =========================================================
   COIN AUCTION DASHBOARD V3
   FRONTEND APP.JS
   Compatible dengan:
   - index.html kamu
   - server.js + Socket.IO
   - tiktok-live-connector
   ========================================================= */

"use strict";

/* =========================================================
   STATE
   ========================================================= */

let users = [];

let duration = 300;
let remaining = 300;

let running = false;
let interval = null;

let liveConnected = false;
let connectedUsername = "";

let topLimit = 5;

let activities = [];

let auctionTitle = "LIVE COIN AUCTION";

let drawDuration = 20;
let drawRemaining = 20;
let inDraw = false;

let auctionFinished = false;

let socket = null;
let liveEventCount = 0;


/* =========================================================
   DOM HELPER
   ========================================================= */

const $ = (id) => document.getElementById(id);


/* =========================================================
   TIME
   ========================================================= */

function formatTime(sec) {
  sec = Math.max(0, Number(sec) || 0);

  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(
    sec % 60
  ).padStart(2, "0")}`;
}


/* =========================================================
   HTML ESCAPE
   ========================================================= */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}


/* =========================================================
   AVATAR INITIAL
   ========================================================= */

function getInitial(name) {
  const text = String(name || "Viewer").trim();

  if (!text) return "?";

  return text.charAt(0).toUpperCase();
}


/* =========================================================
   NORMALIZE USER ID
   ========================================================= */

function normalizeUserId(value) {
  if (value === undefined || value === null) return "";

  return String(value).trim().toLowerCase();
}


/* =========================================================
   PARTICIPANT KEY
   =========================================================

   Prioritas:
   1. userId
   2. username TikTok
   3. nickname

   Jadi peserta tidak lagi ditentukan hanya berdasarkan nama.
   ========================================================= */

function getUserKey(data) {
  const userId = normalizeUserId(
    data?.userId ||
    data?.user_id
  );

  if (userId) {
    return `id:${userId}`;
  }

  const username = normalizeUserId(
    data?.username ||
    data?.uniqueId
  );

  if (username) {
    return `username:${username}`;
  }

  const nickname = normalizeUserId(
    data?.nickname ||
    data?.name
  );

  if (nickname) {
    return `name:${nickname}`;
  }

  return `unknown:${Date.now()}:${Math.random()}`;
}


/* =========================================================
   SORT PARTICIPANTS
   ========================================================= */

function sortedUsers() {
  return [...users].sort((a, b) => {
    if (b.coins !== a.coins) {
      return b.coins - a.coins;
    }

    return String(a.name || "").localeCompare(
      String(b.name || ""),
      "id"
    );
  });
}


/* =========================================================
   DRAW CHECK
   ========================================================= */

function leadersAreTied() {
  const sorted = sortedUsers();

  return (
    sorted.length >= 2 &&
    sorted[0].coins > 0 &&
    sorted[0].coins === sorted[1].coins
  );
}


function hasClearLeader() {
  const sorted = sortedUsers();

  return (
    sorted.length >= 1 &&
    (
      sorted.length === 1 ||
      sorted[0].coins > sorted[1].coins
    )
  );
}


/* =========================================================
   AUCTION STATE TO SERVER
   ========================================================= */

function syncAuctionState() {
  if (!socket || !socket.connected) return;

  socket.emit("auction:state", {
    active: running && !auctionFinished
  });
}


/* =========================================================
   TOAST
   ========================================================= */

function toast(message) {
  const el = $("toast");

  if (!el) return;

  el.textContent = message;
  el.classList.add("show");

  clearTimeout(window.__auctionToastTimer);

  window.__auctionToastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2200);
}


/* =========================================================
   AVATAR HTML
   ========================================================= */

function avatarHTML(user, className = "user-avatar") {
  const name = user?.name || "Viewer";
  const avatar = user?.avatar || "";

  if (avatar) {
    return `
      <div class="${className}">
        <img
          src="${esc(avatar)}"
          alt="Foto profil ${esc(name)}"
          referrerpolicy="no-referrer"
          loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
        >
        <span class="avatar-fallback" style="display:none;">
          ${esc(getInitial(name))}
        </span>
      </div>
    `;
  }

  return `
    <div class="${className}">
      <span class="avatar-fallback">
        ${esc(getInitial(name))}
      </span>
    </div>
  `;
}


/* =========================================================
   RENDER RANKING
   ========================================================= */

function renderRanking() {
  const rankingList = $("rankingList");

  if (!rankingList) return;

  const sorted = sortedUsers();

  const medals = ["🥇", "🥈", "🥉"];

  if (!sorted.length) {
    rankingList.innerHTML = `
      <div class="rank-card rank-box empty-box">
        <div class="rank-info">
          <strong>Menunggu peserta</strong>
          <span>Gift TikTok LIVE akan muncul di sini.</span>
        </div>
      </div>
    `;

    return;
  }

  rankingList.innerHTML = sorted
    .slice(0, topLimit)
    .map((user, index) => {
      const rank = index + 1;

      return `
        <article
          class="rank-card rank-box
          ${index === 0 ? "top1" : ""}
          ${inDraw && index < 2 ? "draw-box" : ""}"
        >

          <div class="box-top">
            <span class="rank-no">
              ${medals[index] || "#" + rank}
            </span>

            <span class="box-rank">
              PESERTA ${rank}
            </span>
          </div>

          ${avatarHTML(user)}

          <div class="rank-info">
            <strong>${esc(user.name || "Viewer")}</strong>

            <span>
              ${
                inDraw && index < 2
                  ? "⚡ DRAW TIME"
                  : `@${esc(user.username || "")}`
              }
            </span>
          </div>

          <div class="coin">
            <span class="coin-icon">🪙</span>

            <strong>
              ${Number(user.coins || 0).toLocaleString("id-ID")}
            </strong>
          </div>

        </article>
      `;
    })
    .join("");
}


/* =========================================================
   RENDER ACTIVITIES
   ========================================================= */

function renderActivities() {
  const activityList = $("activityList");

  if (!activityList) return;

  if (!activities.length) {
    activityList.innerHTML = `
      <p class="empty">Belum ada gift masuk.</p>
    `;

    return;
  }

  activityList.innerHTML = activities
    .slice(0, 5)
    .map((activity) => {
      return `
        <div class="activity">

          ${avatarHTML(activity, "user-avatar activity-avatar")}

          <div>
            <strong>${esc(activity.name)}</strong>

            <span>
              ${esc(activity.gift)}
            </span>
          </div>

          <div class="event-coin">
            <span>🪙</span>

            +${Number(activity.coins || 0).toLocaleString("id-ID")}
          </div>

        </div>
      `;
    })
    .join("");
}


/* =========================================================
   MAIN RENDER
   ========================================================= */

function render() {
  const timer = $("timer");

  if (timer) {
    timer.textContent = formatTime(
      inDraw ? drawRemaining : remaining
    );
  }

  const titleDisplay = $("auctionTitleDisplay");

  if (titleDisplay) {
    titleDisplay.textContent = auctionTitle;
  }

  const progressBar = $("progressBar");

  if (progressBar) {
    let percent = 0;

    if (inDraw) {
      percent = drawDuration
        ? ((drawDuration - drawRemaining) / drawDuration) * 100
        : 0;
    } else {
      percent = duration
        ? ((duration - remaining) / duration) * 100
        : 0;
    }

    percent = Math.max(0, Math.min(100, percent));

    progressBar.style.width = `${percent}%`;
  }

  const timerNote = $("timerNote");

  if (timerNote) {
    if (inDraw) {
      timerNote.textContent =
        `⚡ DRAW TIME aktif — tetap berjalan sampai ${drawDuration} detik habis`;
    }
  }

  const sorted = sortedUsers();

  const participantCount = $("participantCount");

  if (participantCount) {
    participantCount.textContent =
      `${sorted.length} peserta`;
  }

  renderRanking();
  renderActivities();

  const heroViewer = $("heroViewer");

  if (heroViewer) {
    heroViewer.textContent = liveEventCount;
  }
}


/* =========================================================
   FINISH AUCTION
   ========================================================= */

function finishAuction(
  message = "Lelang selesai — pemenang ditentukan"
) {
  running = false;

  clearInterval(interval);
  interval = null;

  auctionFinished = true;
  inDraw = false;

  syncAuctionState();

  const timerNote = $("timerNote");

  if (timerNote) {
    timerNote.textContent = message;
  }

  render();

  toast("🏆 " + message);
}


/* =========================================================
   START DRAW TIME
   ========================================================= */

function startDrawTime() {
  inDraw = true;

  drawRemaining = drawDuration;

  const timerNote = $("timerNote");

  if (timerNote) {
    timerNote.textContent =
      `⚡ DRAW TIME aktif — ${drawDuration} detik`;
  }

  toast(`⚡ DRAW TIME ${drawDuration} DETIK!`);

  render();
}


/* =========================================================
   TIME END
   ========================================================= */

function handleTimeEnd() {
  if (!inDraw) {
    if (leadersAreTied()) {
      startDrawTime();
    } else {
      finishAuction();
    }

    return;
  }

  if (hasClearLeader()) {
    finishAuction(
      "DRAW TIME selesai — pemenang ditentukan"
    );
  } else {
    finishAuction(
      "DRAW TIME selesai — hasil masih seri"
    );
  }
}


/* =========================================================
   RUN / PAUSE AUCTION
   ========================================================= */

function setRunning(value) {
  if (auctionFinished && value) {
    auctionFinished = false;
  }

  running = Boolean(value);

  syncAuctionState();

  clearInterval(interval);
  interval = null;

  if (running) {
    interval = setInterval(() => {

      if (inDraw) {

        /*
         * DRAW TIME harus tetap berjalan
         * sampai benar-benar 20 detik habis.
         */

        if (drawRemaining > 0) {
          drawRemaining--;

          render();
        } else {
          handleTimeEnd();
        }

        return;
      }

      if (remaining > 0) {
        remaining--;

        render();
      } else {
        handleTimeEnd();
      }

    }, 1000);

  } else if (!auctionFinished) {

    const timerNote = $("timerNote");

    if (timerNote) {
      timerNote.textContent =
        inDraw
          ? "DRAW TIME dijeda"
          : "Lelang dijeda";
    }
  }
}


/* =========================================================
   START BUTTON
   ========================================================= */

$("startBtn").onclick = () => {

  if (
    auctionFinished ||
    (remaining <= 0 && !inDraw)
  ) {
    remaining = duration;
    drawRemaining = drawDuration;

    inDraw = false;
    auctionFinished = false;
  }

  setRunning(true);

  toast("Lelang dimulai");
};


/* =========================================================
   PAUSE BUTTON
   ========================================================= */

$("pauseBtn").onclick = () => {

  setRunning(false);

  toast("Lelang dijeda");
};


/* =========================================================
   RESET BUTTON
   ========================================================= */

$("resetBtn").onclick = () => {

  setRunning(false);

  remaining = duration;
  drawRemaining = drawDuration;

  inDraw = false;
  auctionFinished = false;

  users = [];
  activities = [];

  liveEventCount = 0;

  const timerNote = $("timerNote");

  if (timerNote) {
    timerNote.textContent =
      "Siap untuk memulai lelang";
  }

  render();

  toast("Lelang direset");
};


/* =========================================================
   FINISH BUTTON
   ========================================================= */

$("finishBtn").onclick = () => {

  finishAuction();

  toast("Lelang diselesaikan");
};


/* =========================================================
   SAVE SETTINGS
   ========================================================= */

$("saveSettings").onclick = () => {

  const min = Math.max(
    0,
    Math.min(
      120,
      Number($("minuteInput").value) || 0
    )
  );

  const sec = Math.max(
    0,
    Math.min(
      59,
      Number($("secondInput").value) || 0
    )
  );

  if (min === 0 && sec === 0) {
    toast("Waktu minimal 1 detik");
    return;
  }

  duration = min * 60 + sec;

  remaining = duration;

  topLimit =
    Number($("topInput").value) || 5;

  auctionTitle =
    $("titleInput").value.trim() ||
    "LIVE COIN AUCTION";

  setRunning(false);

  const timerNote = $("timerNote");

  if (timerNote) {
    timerNote.textContent =
      `Pengaturan disimpan • Draw Time ${drawDuration} detik`;
  }

  render();

  toast("Pengaturan disimpan");
};


/* =========================================================
   CONNECTION LOG
   ========================================================= */

function updateConnectionLog(
  message,
  type = ""
) {
  const el = $("connectionLog");

  if (!el) return;

  el.textContent = "Status: " + message;

  el.className =
    "connection-log " + type;
}


/* =========================================================
   LIVE UI
   ========================================================= */

function setLiveUi(
  connected,
  username = ""
) {
  liveConnected = Boolean(connected);

  connectedUsername =
    String(username || "").replace(/^@/, "");

  const liveName = $("liveName");

  if (liveName) {
    liveName.textContent =
      liveConnected
        ? "@" + connectedUsername
        : "@Belum Terhubung";
  }

  const connectBtn = $("connectBtn");

  if (connectBtn) {
    connectBtn.textContent =
      liveConnected
        ? "TikTok LIVE Terhubung ✓"
        : "Hubungkan TikTok LIVE";
  }

  const statusBadge = $("statusBadge");

  if (statusBadge) {
    statusBadge.textContent =
      liveConnected
        ? "ONLINE"
        : "OFFLINE";

    statusBadge.className =
      "status-badge " +
      (liveConnected ? "online" : "offline");
  }

  const disconnectBtn = $("disconnectBtn");

  if (disconnectBtn) {
    disconnectBtn.style.display =
      liveConnected
        ? "block"
        : "none";
  }
}


/* =========================================================
   FIND PARTICIPANT
   ========================================================= */

function findParticipant(data) {
  const key = getUserKey(data);

  return {
    key,
    user: users.find(
      (item) => item.key === key
    )
  };
}


/* =========================================================
   ADD / UPDATE PARTICIPANT
   ========================================================= */

function processGift(data) {

  /*
   * Identitas dari server:
   *
   * userId
   * username
   * nickname
   * avatar
   */

  const userId =
    data?.userId ||
    data?.user_id ||
    "";

  const username =
    data?.username ||
    data?.uniqueId ||
    "";

  const nickname =
    data?.nickname ||
    username ||
    "Viewer";

  const avatar =
    data?.avatar ||
    data?.profilePictureUrl ||
    data?.profilePicture ||
    "";

  const giftName =
    data?.giftName ||
    "TikTok Gift";

  const coinValue =
    Number(data?.coinValue) || 0;

  if (coinValue <= 0) {
    return false;
  }

  const userData = {
    userId: String(userId || ""),
    username: String(username || ""),
    name: String(nickname || username || "Viewer"),
    avatar: String(avatar || "")
  };

  const key = getUserKey(userData);

  let user = users.find(
    (item) => item.key === key
  );

  /*
   * Kalau user belum ada:
   * buat peserta baru.
   */

  if (!user) {

    user = {
      key,
      userId: userData.userId,
      username: userData.username,
      name: userData.name,
      avatar: userData.avatar,
      coins: 0
    };

    users.push(user);

  } else {

    /*
     * Update informasi terbaru.
     */

    if (userData.userId) {
      user.userId = userData.userId;
    }

    if (userData.username) {
      user.username = userData.username;
    }

    if (userData.name) {
      user.name = userData.name;
    }

    if (userData.avatar) {
      user.avatar = userData.avatar;
    }
  }

  /*
   * Tambahkan coin.
   */

  user.coins += coinValue;


  /*
   * Tambahkan ke activity.
   */

  activities.unshift({
    name: user.name,
    username: user.username,
    userId: user.userId,
    gift: giftName,
    coins: coinValue,
    avatar: user.avatar
  });


  /*
   * Batasi activity supaya browser
   * tidak menyimpan terlalu banyak.
   */

  if (activities.length > 50) {
    activities.length = 50;
  }

  render();

  return true;
}


/* =========================================================
   PUBLIC ADD GIFT
   ========================================================= */

window.addGift = (
  name,
  gift,
  coins,
  avatar = "",
  extra = {}
) => {

  /*
   * Gift hanya diproses ketika
   * lelang sedang berjalan.
   */

  if (!running || auctionFinished) {
    return false;
  }

  const data = {
    userId:
      extra.userId ||
      extra.user_id ||
      "",

    username:
      extra.username ||
      extra.uniqueId ||
      name ||
      "",

    nickname:
      extra.nickname ||
      name ||
      "Viewer",

    avatar:
      avatar ||
      extra.avatar ||
      "",

    giftName:
      gift ||
      "TikTok Gift",

    coinValue:
      Number(coins) || 0
  };

  return processGift(data);
};


/* =========================================================
   SOCKET.IO SETUP
   ========================================================= */

function setupSocket() {

  if (socket) {
    return socket;
  }

  if (typeof io === "undefined") {

    updateConnectionLog(
      "Socket TikTok belum termuat. Refresh halaman dari server Node.js.",
      "error"
    );

    return null;
  }


  socket = io({
    transports: [
      "websocket",
      "polling"
    ]
  });


  /* -------------------------------------------------------
     SOCKET CONNECT
     ------------------------------------------------------- */

  socket.on("connect", () => {

    updateConnectionLog(
      "server terhubung ✓",
      "ok"
    );

    syncAuctionState();
  });


  /* -------------------------------------------------------
     SOCKET DISCONNECT
     ------------------------------------------------------- */

  socket.on("disconnect", (reason) => {

    updateConnectionLog(
      "server terputus: " + reason,
      "error"
    );

    /*
     * Jangan menghapus peserta.
     * Data ranking tetap ada di browser.
     */

    setLiveUi(false);
  });


  /* -------------------------------------------------------
     CONNECTION ERROR
     ------------------------------------------------------- */

  socket.on("connect_error", (error) => {

    updateConnectionLog(
      "server gagal: " +
      (error?.message || "tidak dapat terhubung"),
      "error"
    );
  });


  /* -------------------------------------------------------
     LIVE STATUS
     ------------------------------------------------------- */

  socket.on("live:status", (data) => {

    const message =
      data?.message ||
      "status LIVE diperbarui";

    updateConnectionLog(
      message,
      data?.ok ? "ok" : "error"
    );


    if (data?.ok) {

      /*
       * Ambil username dari server.
       */

      let username =
        data?.username ||
        data?.uniqueId ||
        connectedUsername ||
        "";

      /*
       * Fallback jika server hanya
       * mengirim message seperti:
       *
       * Terhubung ke @username
       */

      if (!username) {

        const match =
          message.match(/@([^\s•]+)/);

        if (match) {
          username = match[1];
        }
      }

      setLiveUi(
        true,
        username || "TikTokLive"
      );

    } else if (
      /diputus|belum terhubung|gagal|error/i.test(
        message
      )
    ) {

      setLiveUi(false);
    }
  });


  /* -------------------------------------------------------
     TIKTOK GIFT
     ------------------------------------------------------- */

  socket.on("live:gift", (data) => {

    /*
     * Jangan hitung gift ketika
     * lelang belum dimulai.
     */

    if (!running || auctionFinished) {
      return;
    }


    /*
     * Ambil semua identitas peserta
     * dari server.
     */

    const userId =
      data?.userId ||
      data?.user_id ||
      "";

    const username =
      data?.username ||
      data?.uniqueId ||
      "";

    const nickname =
      data?.nickname ||
      username ||
      "Viewer";

    const giftName =
      data?.giftName ||
      "TikTok Gift";

    const coin =
      Number(data?.coinValue) || 0;

    const avatar =
      data?.avatar ||
      data?.profilePictureUrl ||
      data?.profilePicture ||
      "";


    if (coin <= 0) {

      updateConnectionLog(
        `Gift ${giftName} diterima tetapi nilai coin tidak valid.`,
        "error"
      );

      return;
    }


    /*
     * Proses peserta.
     */

    const processed = processGift({

      userId,
      username,
      nickname,
      avatar,
      giftName,
      coinValue: coin
    });


    if (!processed) {
      return;
    }


    /*
     * Hitung jumlah EVENT LIVE.
     */

    liveEventCount++;

    const heroViewer = $("heroViewer");

    if (heroViewer) {
      heroViewer.textContent =
        liveEventCount;
    }


    updateConnectionLog(
      `Gift masuk: ${nickname} • ${giftName} • +${coin.toLocaleString("id-ID")} coin`,
      "ok"
    );
  });


  /* -------------------------------------------------------
     GIFT DEBUG
     ------------------------------------------------------- */

  socket.on("live:gift-debug", (data) => {

    updateConnectionLog(
      data?.message ||
      "Gift diterima tetapi data coin belum terbaca.",
      "error"
    );

    console.warn(
      "TikTok gift debug:",
      data?.debug || data
    );
  });


  /* -------------------------------------------------------
     LIVE ERROR
     ------------------------------------------------------- */

  socket.on("live:error", (data) => {

    const message =
      data?.message ||
      "koneksi gagal";

    updateConnectionLog(
      message,
      "error"
    );

    toast(message);

    setLiveUi(false);
  });


  return socket;
}


/* =========================================================
   CONNECT BUTTON
   ========================================================= */

$("connectBtn").onclick = () => {

  const input = $("tiktokUsername");

  const username =
    (input?.value || "")
      .trim()
      .replace(/^@/, "");

  if (!username) {

    toast(
      "Masukkan username TikTok yang sedang LIVE"
    );

    return;
  }


  const s = setupSocket();

  if (!s) {
    return;
  }


  updateConnectionLog(
    "menghubungkan ke @" +
    username +
    " ..."
  );


  /*
   * Cocok dengan server.js:
   *
   * socket.on("live:connect", ({ username }) => ...)
   */

  s.emit(
    "live:connect",
    {
      username
    }
  );
};


/* =========================================================
   DISCONNECT BUTTON
   ========================================================= */

$("disconnectBtn").onclick = () => {

  if (socket) {
    socket.emit("live:disconnect");
  }

  setLiveUi(false);

  updateConnectionLog(
    "koneksi diputus"
  );
};


/* =========================================================
   SOUND BUTTON
   ========================================================= */

let soundEnabled = true;

if ($("soundBtn")) {

  $("soundBtn").onclick = () => {

    soundEnabled = !soundEnabled;

    $("soundBtn").textContent =
      soundEnabled
        ? "🔊"
        : "🔇";

    toast(
      soundEnabled
        ? "Suara diaktifkan"
        : "Suara dimatikan"
    );
  };
}


/* =========================================================
   TOP LIMIT CHANGE
   ========================================================= */

if ($("topInput")) {

  $("topInput").addEventListener(
    "change",
    () => {

      topLimit =
        Number($("topInput").value) || 5;

      render();
    }
  );
}


/* =========================================================
   TITLE LIVE PREVIEW
   ========================================================= */

if ($("titleInput")) {

  $("titleInput").addEventListener(
    "input",
    () => {

      const value =
        $("titleInput").value.trim();

      $("auctionTitleDisplay").textContent =
        value || "LIVE COIN AUCTION";
    }
  );
}


/* =========================================================
   INITIAL UI
   ========================================================= */

setLiveUi(false);

if ($("disconnectBtn")) {
  $("disconnectBtn").style.display = "none";
}


/* =========================================================
   INITIAL RENDER
   ========================================================= */

render();


/* =========================================================
   CONNECT SOCKET
   ========================================================= */

setupSocket();


/* =========================================================
   DEBUG HELPER
   =========================================================

   Bisa dipakai dari browser console:

   addTestGift("Andi", "Rose", 100)
   addTestGift("Budi", "Galaxy", 500)
   addTestGift("Citra", "Rose", 50)

   Hanya untuk testing frontend.
   ========================================================= */

window.addTestGift = (
  name,
  gift = "Test Gift",
  coins = 10,
  avatar = "",
  userId = ""
) => {

  if (!running) {
    console.warn(
      "Mulai lelang terlebih dahulu."
    );

    return;
  }

  processGift({

    userId:
      userId ||
      "test-" +
      String(name)
        .toLowerCase()
        .replace(/\s+/g, "-"),

    username:
      String(name)
        .toLowerCase()
        .replace(/\s+/g, "_"),

    nickname:
      String(name),

    avatar,

    giftName:
      gift,

    coinValue:
      Number(coins) || 0
  });

  liveEventCount++;

  const heroViewer = $("heroViewer");

  if (heroViewer) {
    heroViewer.textContent =
      liveEventCount;
  }
};


/* =========================================================
   END
   ========================================================= */
