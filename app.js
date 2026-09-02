/* =========================================================
   COIN AUCTION DASHBOARD V5
   FRONTEND APP.JS - FINAL

   FITUR:
   - Coin gift 1:1
   - Tidak ada perkalian x2
   - Foto profil TikTok diprioritaskan
   - Kartu peserta compact
   - @viewer tidak ditampilkan
   - Timer utama warna putih
   - Waktu tambahan bisa di-custom
   - Waktu tambahan berubah MERAH saat aktif
   - Draw Time tetap KUNING
   - Compatible dengan index.html
   - Compatible dengan server.js + Socket.IO
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
   WAKTU TAMBAHAN
   ========================================================= */

let extraTime = 30;
let extraRemaining = 0;
let extraActive = false;


/* =========================================================
   DOM
   ========================================================= */

const $ = (id) => document.getElementById(id);


/* =========================================================
   CSS TAMBAHAN
   ========================================================= */

(function injectStyle() {

  if ($("auctionCompactStyle")) return;

  const style = document.createElement("style");

  style.id = "auctionCompactStyle";

  style.textContent = `
    /* ==========================================
       TIMER UTAMA
       ========================================== */

    #timer {
      color: #fff !important;
      transition: color .2s ease;
    }

    /* ==========================================
       TIMER TAMBAHAN
       ========================================== */

    #timer.extra-active,
    .extra-active,
    .timer-extra-active {
      color: #ff3030 !important;
    }

    /* ==========================================
       DRAW TIME
       ========================================== */

    .draw-time-active,
    #timer.draw-time-active {
      color: #ffd43b !important;
    }

    /* ==========================================
       PESERTA
       ========================================== */

    #rankingList {
      display: flex !important;
      flex-direction: column !important;
      gap: 7px !important;
    }

    #rankingList .rank-card,
    #rankingList .rank-box {
      position: relative !important;
      min-height: 0 !important;
      height: auto !important;
      padding: 8px 10px !important;
      margin: 0 !important;
      border-radius: 12px !important;

      display: grid !important;

      grid-template-columns:
        30px
        36px
        minmax(0, 1fr)
        auto !important;

      align-items: center !important;
      column-gap: 7px !important;
    }

    #rankingList .box-top {
      display: contents !important;
    }

    #rankingList .rank-no {
      grid-column: 1 !important;

      width: 28px !important;
      height: 28px !important;

      display: flex !important;
      align-items: center !important;
      justify-content: center !important;

      font-size: 15px !important;
    }

    #rankingList .box-rank {
      display: none !important;
    }

    #rankingList .user-avatar {
      grid-column: 2 !important;

      width: 36px !important;
      height: 36px !important;

      min-width: 36px !important;
      min-height: 36px !important;

      border-radius: 50% !important;
      overflow: hidden !important;

      display: flex !important;
      align-items: center !important;
      justify-content: center !important;

      background: #25252b !important;
      border: 1px solid rgba(255,255,255,.16) !important;
    }

    #rankingList .user-avatar img {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
      display: block;
    }

    #rankingList .avatar-fallback {
      width: 100% !important;
      height: 100% !important;

      display: flex;
      align-items: center;
      justify-content: center;

      font-size: 15px !important;
      font-weight: 700 !important;
    }

    #rankingList .rank-info {
      grid-column: 3 !important;
      min-width: 0 !important;

      display: flex !important;
      flex-direction: column !important;
      gap: 1px !important;
    }

    #rankingList .rank-info strong {
      display: block !important;

      font-size: 13px !important;
      line-height: 17px !important;

      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }

    #rankingList .rank-info span {
      display: none !important;
    }

    #rankingList .coin {
      grid-column: 4 !important;

      display: flex !important;
      align-items: center !important;
      justify-content: flex-end !important;

      gap: 3px !important;
      white-space: nowrap !important;
    }

    #rankingList .coin-icon {
      font-size: 13px !important;
    }

    #rankingList .coin strong {
      font-size: 14px !important;
      line-height: 17px !important;
    }

    #rankingList .empty-box {
      display: block !important;
      padding: 11px !important;
    }

    /* ==========================================
       EXTRA TIME DISPLAY
       ========================================== */

    .extra-time-display {
      transition: color .2s ease;
    }

    .extra-time-display.active {
      color: #ff3030 !important;
      font-weight: 800 !important;
    }

    /* ==========================================
       MOBILE
       ========================================== */

    @media (max-width:480px) {

      #rankingList {
        gap: 5px !important;
      }

      #rankingList .rank-card,
      #rankingList .rank-box {
        padding: 6px 8px !important;

        grid-template-columns:
          27px
          33px
          minmax(0,1fr)
          auto !important;

        column-gap: 6px !important;
      }

      #rankingList .rank-no {
        width: 26px !important;
        height: 26px !important;
        font-size: 14px !important;
      }

      #rankingList .user-avatar {
        width: 33px !important;
        height: 33px !important;
        min-width: 33px !important;
        min-height: 33px !important;
      }

      #rankingList .rank-info strong {
        font-size: 12px !important;
      }

      #rankingList .coin strong {
        font-size: 13px !important;
      }
    }
  `;

  document.head.appendChild(style);

})();


/* =========================================================
   FORMAT TIME
   ========================================================= */

function formatTime(sec) {

  sec = Math.max(0, Number(sec) || 0);

  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0")
  );
}


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function esc(value) {

  return String(value ?? "")
    .replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[m]));

}


/* =========================================================
   INITIAL
   ========================================================= */

function getInitial(name) {

  const text =
    String(name || "Viewer").trim();

  return text
    ? text.charAt(0).toUpperCase()
    : "?";
}


/* =========================================================
   NORMALIZE USER ID
   ========================================================= */

function normalizeUserId(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase();
}


/* =========================================================
   USER KEY
   ========================================================= */

function getUserKey(data) {

  const id =
    normalizeUserId(
      data?.userId ||
      data?.user_id ||
      data?.uid
    );

  if (id) {
    return "id:" + id;
  }

  const username =
    normalizeUserId(
      data?.username ||
      data?.uniqueId ||
      data?.unique_id ||
      data?.uniqueId
    );

  if (username) {
    return "username:" + username;
  }

  const nickname =
    normalizeUserId(
      data?.nickname ||
      data?.name ||
      data?.displayName
    );

  if (nickname) {
    return "name:" + nickname;
  }

  return (
    "unknown:" +
    Date.now() +
    ":" +
    Math.random()
  );
}


/* =========================================================
   AVATAR
   ========================================================= */

function getAvatar(data) {

  return (
    data?.avatar ||
    data?.profilePictureUrl ||
    data?.profilePicture ||
    data?.avatarLarger ||
    data?.avatarMedium ||
    data?.avatarThumb ||
    data?.profilePicUrl ||
    data?.profile_picture_url ||
    ""
  );
}


/* =========================================================
   AVATAR HTML
   ========================================================= */

function avatarHTML(
  user,
  className = "user-avatar"
) {

  const name =
    user?.name ||
    user?.nickname ||
    "Viewer";

  const avatar =
    getAvatar(user);

  if (avatar) {

    return `
      <div class="${className}">
        <img
          src="${esc(avatar)}"
          alt=""
          referrerpolicy="no-referrer"
          loading="lazy"
          onload="
            this.style.display='block';
            this.nextElementSibling.style.display='none';
          "
          onerror="
            this.style.display='none';
            this.nextElementSibling.style.display='flex';
          "
        >

        <span
          class="avatar-fallback"
          style="display:none;"
        >
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
   SORT USER
   ========================================================= */

function sortedUsers() {

  return [...users].sort(
    (a, b) => {

      const coinA =
        Number(a.coins || 0);

      const coinB =
        Number(b.coins || 0);

      if (coinB !== coinA) {
        return coinB - coinA;
      }

      return String(
        a.name || ""
      ).localeCompare(
        String(b.name || ""),
        "id"
      );

    }
  );
}


/* =========================================================
   DRAW CHECK
   ========================================================= */

function leadersAreTied() {

  const sorted =
    sortedUsers();

  return (
    sorted.length >= 2 &&
    Number(sorted[0].coins || 0) > 0 &&
    Number(sorted[0].coins || 0) ===
      Number(sorted[1].coins || 0)
  );
}


function hasClearLeader() {

  const sorted =
    sortedUsers();

  return (
    sorted.length >= 1 &&
    Number(sorted[0].coins || 0) > 0 &&
    (
      sorted.length === 1 ||
      Number(sorted[0].coins || 0) >
        Number(sorted[1].coins || 0)
    )
  );
}


/* =========================================================
   TOAST
   ========================================================= */

function toast(message) {

  const el = $("toast");

  if (!el) return;

  el.textContent = message;

  el.classList.add("show");

  clearTimeout(
    window.__auctionToastTimer
  );

  window.__auctionToastTimer =
    setTimeout(
      () => {
        el.classList.remove("show");
      },
      2200
    );
}


/* =========================================================
   UPDATE TIMER COLOR
   ========================================================= */

function updateTimerColor() {

  const timer =
    $("timer");

  if (!timer) return;

  timer.classList.remove(
    "extra-active",
    "draw-time-active"
  );

  if (inDraw) {

    timer.classList.add(
      "draw-time-active"
    );

    timer.style.color =
      "#ffd43b";

    return;
  }

  if (extraActive) {

    timer.classList.add(
      "extra-active"
    );

    timer.style.color =
      "#ff3030";

    return;
  }

  timer.style.color =
    "#ffffff";
}


/* =========================================================
   FIND INPUT
   ========================================================= */

function findInput(
  ids,
  fallback = null
) {

  for (const id of ids) {

    const el = $(id);

    if (el) return el;
  }

  return fallback;
}


/* =========================================================
   READ CUSTOM EXTRA TIME
   ========================================================= */

function readExtraTime() {

  const input =
    findInput([
      "extraTime",
      "extraTimeInput",
      "additionalTime",
      "tambahanTime",
      "auctionExtraTime"
    ]);

  if (!input) {
    return;
  }

  const value =
    Number(input.value);

  if (
    Number.isFinite(value) &&
    value >= 0
  ) {

    extraTime =
      Math.floor(value);

  }
}


/* =========================================================
   SAVE CUSTOM TIME TO INPUT
   ========================================================= */

function writeExtraTime() {

  const input =
    findInput([
      "extraTime",
      "extraTimeInput",
      "additionalTime",
      "tambahanTime",
      "auctionExtraTime"
    ]);

  if (input) {
    input.value =
      extraTime;
  }
}


/* =========================================================
   START EXTRA TIME
   ========================================================= */

function startExtraTime() {

  readExtraTime();

  if (extraTime <= 0) {

    finishAuction(
      "Waktu habis — tidak ada waktu tambahan"
    );

    return;
  }

  extraActive = true;

  extraRemaining =
    extraTime;

  const note =
    $("timerNote");

  if (note) {

    note.textContent =
      `➕ WAKTU TAMBAHAN AKTIF — ${formatTime(extraTime)}`;

  }

  toast(
    `🔴 Waktu tambahan ${extraTime} detik aktif!`
  );

  updateTimerColor();
  render();
}


/* =========================================================
   START DRAW
   ========================================================= */

function startDrawTime() {

  inDraw = true;

  drawRemaining =
    drawDuration;

  extraActive = false;
  extraRemaining = 0;

  const note =
    $("timerNote");

  if (note) {

    note.textContent =
      `⚡ DRAW TIME aktif — ${drawDuration} detik`;

  }

  toast(
    `⚡ DRAW TIME ${drawDuration} DETIK!`
  );

  render();
}


/* =========================================================
   FINISH
   ========================================================= */

function finishAuction(
  message =
    "Lelang selesai — pemenang ditentukan"
) {

  running = false;

  clearInterval(interval);

  interval = null;

  auctionFinished = true;

  inDraw = false;
  extraActive = false;
  extraRemaining = 0;

  syncAuctionState();

  const note =
    $("timerNote");

  if (note) {
    note.textContent = message;
  }

  render();

  toast("🏆 " + message);
}


/* =========================================================
   TIME END
   ========================================================= */

function handleTimeEnd() {

  /* ------------------------------
     DRAW TIME
     ------------------------------ */

  if (inDraw) {

    if (hasClearLeader()) {

      finishAuction(
        "DRAW TIME selesai — pemenang ditentukan"
      );

    } else {

      finishAuction(
        "DRAW TIME selesai — hasil masih seri"
      );

    }

    return;
  }


  /* ------------------------------
     EXTRA TIME
     ------------------------------ */

  if (extraActive) {

    extraActive = false;
    extraRemaining = 0;

    if (leadersAreTied()) {

      startDrawTime();

    } else {

      finishAuction(
        "Waktu tambahan selesai — pemenang ditentukan"
      );

    }

    return;
  }


  /* ------------------------------
     WAKTU UTAMA
     ------------------------------ */

  if (leadersAreTied()) {

    startDrawTime();

    return;
  }


  /* ------------------------------
     JIKA ADA WAKTU TAMBAHAN
     ------------------------------ */

  readExtraTime();

  if (extraTime > 0) {

    startExtraTime();

    return;
  }


  finishAuction();
}


/* =========================================================
   SYNC SERVER
   ========================================================= */

function syncAuctionState() {

  if (
    !socket ||
    !socket.connected
  ) {
    return;
  }

  socket.emit(
    "auction:state",
    {
      active:
        running &&
        !auctionFinished,

      running,

      remaining,

      duration,

      extraTime,

      extraRemaining,

      extraActive,

      inDraw,

      drawRemaining,

      drawDuration
    }
  );
}


/* =========================================================
   RENDER RANKING
   ========================================================= */

function renderRanking() {

  const rankingList =
    $("rankingList");

  if (!rankingList) return;

  const sorted =
    sortedUsers();

  const medals = [
    "🥇",
    "🥈",
    "🥉"
  ];

  if (!sorted.length) {

    rankingList.innerHTML = `
      <div class="rank-card rank-box empty-box">
        <div class="rank-info">
          <strong>Menunggu peserta</strong>
        </div>
      </div>
    `;

    return;
  }

  rankingList.innerHTML =
    sorted
      .slice(0, topLimit)
      .map(
        (user, index) => {

          const rank =
            index + 1;

          const isDraw =
            inDraw &&
            index < 2;

          return `
            <article
              class="
                rank-card
                rank-box
                ${index === 0 ? "top1" : ""}
                ${isDraw ? "draw-box" : ""}
              "
            >

              <div class="box-top">

                <span class="rank-no">
                  ${
                    medals[index] ||
                    "#" + rank
                  }
                </span>

                <span class="box-rank">
                  PESERTA ${rank}
                </span>

              </div>

              ${avatarHTML(user)}

              <div class="rank-info">

                <strong>
                  ${esc(
                    user.name ||
                    user.nickname ||
                    "Viewer"
                  )}
                </strong>

              </div>

              <div class="coin">

                <span class="coin-icon">
                  🪙
                </span>

                <strong>
                  ${
                    Number(
                      user.coins || 0
                    ).toLocaleString("id-ID")
                  }
                </strong>

              </div>

            </article>
          `;

        }
      )
      .join("");
}


/* =========================================================
   RENDER ACTIVITIES
   ========================================================= */

function renderActivities() {

  const activityList =
    $("activityList");

  if (!activityList) return;

  if (!activities.length) {

    activityList.innerHTML = `
      <p class="empty">
        Belum ada gift masuk.
      </p>
    `;

    return;
  }

  activityList.innerHTML =
    activities
      .slice(0, 5)
      .map(
        (activity) => {

          return `
            <div class="activity">

              ${avatarHTML(
                activity,
                "user-avatar activity-avatar"
              )}

              <div>

                <strong>
                  ${esc(
                    activity.name ||
                    "Viewer"
                  )}
                </strong>

                <span>
                  ${esc(
                    activity.gift ||
                    "Gift"
                  )}
                </span>

              </div>

              <div class="event-coin">

                <span>🪙</span>

                +${
                  Number(
                    activity.coins || 0
                  ).toLocaleString("id-ID")
                }

              </div>

            </div>
          `;

        }
      )
      .join("");
}


/* =========================================================
   RENDER
   ========================================================= */

function render() {

  const timer =
    $("timer");

  if (timer) {

    let value;

    if (inDraw) {

      value =
        drawRemaining;

    } else if (extraActive) {

      value =
        extraRemaining;

    } else {

      value =
        remaining;

    }

    timer.textContent =
      formatTime(value);

  }


  const title =
    $("auctionTitleDisplay");

  if (title) {
    title.textContent =
      auctionTitle;
  }


  const participantCount =
    $("participantCount");

  if (participantCount) {

    participantCount.textContent =
      `${users.length} peserta`;

  }


  const progressBar =
    $("progressBar");

  if (progressBar) {

    let percent = 0;

    if (inDraw) {

      percent =
        drawDuration > 0
          ? (
              (
                drawDuration -
                drawRemaining
              ) /
              drawDuration
            ) * 100
          : 0;

    } else if (extraActive) {

      percent =
        extraTime > 0
          ? (
              (
                extraTime -
                extraRemaining
              ) /
              extraTime
            ) * 100
          : 0;

    } else {

      percent =
        duration > 0
          ? (
              (
                duration -
                remaining
              ) /
              duration
            ) * 100
          : 0;

    }

    percent =
      Math.max(
        0,
        Math.min(
          100,
          percent
        )
      );

    progressBar.style.width =
      `${percent}%`;
  }


  const note =
    $("timerNote");

  if (
    note &&
    !inDraw &&
    !extraActive &&
    !auctionFinished
  ) {

    note.textContent =
      "⏱️ Lelang sedang berjalan";

  }


  const heroViewer =
    $("heroViewer");

  if (heroViewer) {

    heroViewer.textContent =
      liveEventCount;

  }


  renderRanking();

  renderActivities();

  updateTimerColor();
}


/* =========================================================
   TICK TIMER
   ========================================================= */

function tick() {

  if (!running) {
    return;
  }


  /* DRAW */

  if (inDraw) {

    if (drawRemaining > 0) {

      drawRemaining--;

      render();

      return;
    }

    handleTimeEnd();

    return;
  }


  /* EXTRA */

  if (extraActive) {

    if (extraRemaining > 0) {

      extraRemaining--;

      render();

      return;
    }

    handleTimeEnd();

    return;
  }


  /* NORMAL */

  if (remaining > 0) {

    remaining--;

    render();

    return;
  }


  handleTimeEnd();
}


/* =========================================================
   RUN / PAUSE
   ========================================================= */

function setRunning(value) {

  if (
    auctionFinished &&
    value
  ) {

    auctionFinished = false;

  }


  running =
    Boolean(value);


  clearInterval(interval);

  interval = null;


  if (running) {

    interval =
      setInterval(
        tick,
        1000
      );

  }


  syncAuctionState();

  render();
}


/* =========================================================
   START
   ========================================================= */

function startAuction() {

  if (auctionFinished) {

    auctionFinished = false;

  }

  if (
    remaining <= 0 &&
    !extraActive &&
    !inDraw
  ) {

    remaining =
      duration;

  }

  setRunning(true);

  toast("▶️ Lelang dimulai");
}


/* =========================================================
   PAUSE
   ========================================================= */

function pauseAuction() {

  setRunning(false);

  toast("⏸ Lelang dijeda");
}


/* =========================================================
   RESET
   ========================================================= */

function resetAuction() {

  clearInterval(interval);

  interval = null;

  running = false;

  auctionFinished = false;

  inDraw = false;

  extraActive = false;

  extraRemaining = 0;

  remaining =
    duration;

  drawRemaining =
    drawDuration;

  users = [];

  activities = [];

  liveEventCount = 0;

  syncAuctionState();

  render();

  toast("↻ Lelang di-reset");
}


/* =========================================================
   FINISH BUTTON
   ========================================================= */

function finishButton() {

  finishAuction(
    "Lelang selesai"
  );
}


/* =========================================================
   READ SETTINGS
   ========================================================= */

function readSettings() {

  const durationInput =
    findInput([
      "duration",
      "auctionDuration",
      "timeDuration"
    ]);

  if (durationInput) {

    const value =
      Number(durationInput.value);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {

      duration =
        Math.floor(value);

      if (!running) {
        remaining =
          duration;
      }

    }
  }


  const drawInput =
    findInput([
      "drawDuration",
      "drawTime",
      "drawTimeInput"
    ]);

  if (drawInput) {

    const value =
      Number(drawInput.value);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {

      drawDuration =
        Math.floor(value);

      if (!inDraw) {
        drawRemaining =
          drawDuration;
      }

    }
  }


  readExtraTime();


  const titleInput =
    findInput([
      "auctionTitle",
      "titleInput",
      "auctionName"
    ]);

  if (
    titleInput &&
    titleInput.value.trim()
  ) {

    auctionTitle =
      titleInput.value.trim();

  }


  const topInput =
    findInput([
      "topLimit",
      "participantLimit"
    ]);

  if (topInput) {

    const value =
      Number(topInput.value);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {

      topLimit =
        Math.floor(value);

    }

  }

  writeExtraTime();

  render();
}


/* =========================================================
   BUTTON BIND
   ========================================================= */

function bindButton(
  ids,
  handler
) {

  ids.forEach(
    (id) => {

      const el =
        $(id);

      if (!el) return;

      el.addEventListener(
        "click",
        handler
      );

    }
  );

}


/* =========================================================
   INPUT BIND
   ========================================================= */

function bindInputs() {

  const ids = [
    "duration",
    "auctionDuration",
    "timeDuration",
    "drawDuration",
    "drawTime",
    "drawTimeInput",
    "extraTime",
    "extraTimeInput",
    "additionalTime",
    "tambahanTime",
    "auctionExtraTime",
    "auctionTitle",
    "titleInput",
    "auctionName",
    "topLimit",
    "participantLimit"
  ];

  ids.forEach(
    (id) => {

      const el =
        $(id);

      if (!el) return;

      el.addEventListener(
        "change",
        () => {

          readSettings();

          toast("⚙️ Pengaturan disimpan");

        }
      );

    }
  );

}


/* =========================================================
   BUTTONS
   ========================================================= */

function bindButtons() {

  bindButton(
    [
      "startBtn",
      "startAuction",
      "btnStart",
      "mulaiBtn"
    ],
    startAuction
  );


  bindButton(
    [
      "pauseBtn",
      "pauseAuction",
      "btnPause",
      "jedaBtn"
    ],
    pauseAuction
  );


  bindButton(
    [
      "resetBtn",
      "resetAuction",
      "btnReset",
      "resetBtnAuction"
    ],
    resetAuction
  );


  bindButton(
    [
      "finishBtn",
      "finishAuction",
      "btnFinish",
      "selesaiBtn"
    ],
    finishButton
  );

}


/* =========================================================
   SOCKET
   ========================================================= */

function connectSocket() {

  if (
    typeof io !== "function"
  ) {

    console.warn(
      "Socket.IO tidak ditemukan."
    );

    return;

  }


  socket =
    io();


  socket.on(
    "connect",
    () => {

      liveConnected = true;

      const status =
        $("connectionStatus");

      if (status) {

        status.textContent =
          "Terhubung";

      }

      syncAuctionState();

      render();

    }
  );


  socket.on(
    "disconnect",
    () => {

      liveConnected = false;

      const status =
        $("connectionStatus");

      if (status) {

        status.textContent =
          "Terputus";

      }

      render();

    }
  );


  /* ==========================================
     STATUS LIVE
     ========================================== */

  socket.on(
    "live:status",
    (data = {}) => {

      liveConnected =
        Boolean(
          data.connected ??
          data.active ??
          true
        );

      connectedUsername =
        data.username ||
        data.uniqueId ||
        data.user ||
        "";

      render();

    }
  );


  /* ==========================================
     PARTICIPANT LIST
     ========================================== */

  socket.on(
    "participants",
    (list) => {

      if (!Array.isArray(list)) {
        return;
      }

      users =
        list.map(
          normalizeUser
        );

      render();

    }
  );


  socket.on(
    "auction:participants",
    (list) => {

      if (!Array.isArray(list)) {
        return;
      }

      users =
        list.map(
          normalizeUser
        );

      render();

    }
  );


  /* ==========================================
     USER UPDATE
     ========================================== */

  socket.on(
    "user:update",
    (data) => {

      updateUser(
        data
      );

    }
  );


  socket.on(
    "participant:update",
    (data) => {

      updateUser(
        data
      );

    }
  );


  /* ==========================================
     GIFT
     ========================================== */

  socket.on(
    "gift",
    handleGift
  );


  socket.on(
    "tiktok:gift",
    handleGift
  );


  socket.on(
    "gift:event",
    handleGift
  );


  socket.on(
    "live:gift",
    handleGift
  );


  /* ==========================================
     SERVER STATE
     ========================================== */

  socket.on(
    "auction:state",
    (data = {}) => {

      if (
        typeof data.duration ===
        "number"
      ) {

        duration =
          data.duration;

      }

      if (
        typeof data.remaining ===
        "number"
      ) {

        remaining =
          data.remaining;

      }

      if (
        typeof data.running ===
        "boolean"
      ) {

        running =
          data.running;

      }

      if (
        typeof data.extraTime ===
        "number"
      ) {

        extraTime =
          data.extraTime;

      }

      if (
        typeof data.extraRemaining ===
        "number"
      ) {

        extraRemaining =
          data.extraRemaining;

      }

      if (
        typeof data.extraActive ===
        "boolean"
      ) {

        extraActive =
          data.extraActive;

      }

      if (
        typeof data.drawDuration ===
        "number"
      ) {

        drawDuration =
          data.drawDuration;

      }

      if (
        typeof data.drawRemaining ===
        "number"
      ) {

        drawRemaining =
          data.drawRemaining;

      }

      if (
        typeof data.inDraw ===
        "boolean"
      ) {

        inDraw =
          data.inDraw;

      }

      render();

    }
  );

}


/* =========================================================
   NORMALIZE USER
   ========================================================= */

function normalizeUser(data = {}) {

  return {

    key:
      getUserKey(data),

    userId:
      data.userId ||
      data.user_id ||
      data.uid ||
      "",

    username:
      data.username ||
      data.uniqueId ||
      data.unique_id ||
      "",

    name:
      data.name ||
      data.nickname ||
      data.displayName ||
      data.username ||
      data.uniqueId ||
      "Viewer",

    coins:
      Math.max(
        0,
        Number(
          data.coins ??
          data.coin ??
          data.diamonds ??
          data.diamond ??
          0
        ) || 0
      ),

    avatar:
      getAvatar(data)

  };

}


/* =========================================================
   UPDATE USER
   ========================================================= */

function updateUser(data = {}) {

  const normalized =
    normalizeUser(data);

  const key =
    normalized.key;

  let user =
    users.find(
      (u) =>
        u.key === key ||
        (
          normalized.userId &&
          u.userId &&
          String(u.userId) ===
            String(normalized.userId)
        ) ||
        (
          normalized.username &&
          u.username &&
          normalizeUserId(
            u.username
          ) ===
          normalizeUserId(
            normalized.username
          )
        )
    );


  if (!user) {

    users.push(
      normalized
    );

  } else {

    if (normalized.name) {
      user.name =
        normalized.name;
    }

    if (normalized.username) {
      user.username =
        normalized.username;
    }

    if (normalized.avatar) {
      user.avatar =
        normalized.avatar;
    }

    if (
      Number.isFinite(
        normalized.coins
      )
    ) {

      user.coins =
        normalized.coins;

    }

  }


  render();
}


/* =========================================================
   HANDLE GIFT
   ========================================================= */

function handleGift(data = {}) {

  const user =
    normalizeUser(data);


  /*
   * PENTING:
   * Coin dipakai 1:1.
   *
   * Tidak ada:
   * coins * 2
   * coins * repeat
   * coins * streak
   */


  let coins =
    Number(
      data.coins ??
      data.coinCount ??
      data.coinValue ??
      data.diamondCount ??
      data.diamonds ??
      0
    );


  if (
    !Number.isFinite(coins) ||
    coins < 0
  ) {

    coins = 0;

  }


  coins =
    Math.floor(coins);


  const key =
    getUserKey(data);


  let existing =
    users.find(
      (u) =>
        u.key === key ||
        (
          user.username &&
          u.username &&
          normalizeUserId(
            u.username
          ) ===
          normalizeUserId(
            user.username
          )
        )
    );


  if (!existing) {

    existing = {
      ...user,
      coins: 0
    };

    users.push(
      existing
    );

  }


  /*
   * COIN 1:1
   */

  existing.coins =
    Number(
      existing.coins || 0
    ) + coins;


  if (user.name) {
    existing.name =
      user.name;
  }

  if (user.username) {
    existing.username =
      user.username;
  }

  if (user.avatar) {
    existing.avatar =
      user.avatar;
  }


  liveEventCount++;


  activities.unshift({

    name:
      user.name ||
      existing.name ||
      "Viewer",

    username:
      user.username ||
      existing.username ||
      "",

    avatar:
      user.avatar ||
      existing.avatar ||
      "",

    gift:
      data.giftName ||
      data.gift ||
      data.name ||
      "Gift",

    coins

  });


  activities =
    activities.slice(
      0,
      50
    );


  render();

}


/* =========================================================
   GLOBAL FUNCTIONS
   =========================================================

   Membuat tombol HTML lama tetap bekerja
   apabila menggunakan onclick.
   ========================================================= */

window.startAuction =
  startAuction;

window.pauseAuction =
  pauseAuction;

window.resetAuction =
  resetAuction;

window.finishAuction =
  finishButton;

window.setRunning =
  setRunning;

window.startDrawTime =
  startDrawTime;


/* =========================================================
   INIT
   ========================================================= */

function init() {

  readSettings();

  bindButtons();

  bindInputs();

  render();

  connectSocket();

}


/* =========================================================
   DOM READY
   ========================================================= */

if (
  document.readyState ===
  "loading"
) {

  document.addEventListener(
    "DOMContentLoaded",
    init
  );

} else {

  init();

}


/* =========================================================
   DEBUG
   ========================================================= */

window.auctionDebug = {

  getUsers:
    () => users,

  getState:
    () => ({
      duration,
      remaining,
      running,
      extraTime,
      extraRemaining,
      extraActive,
      drawDuration,
      drawRemaining,
      inDraw,
      auctionFinished
    }),

  addTestCoin:
    (username = "Test User", coins = 10) => {

      handleGift({

        username,

        uniqueId:
          username,

        nickname:
          username,

        gift:
          "Test Gift",

        giftName:
          "Test Gift",

        coins:
          Number(coins) || 0

      });

    },

  reset:
    resetAuction

};

console.log(
  "✅ Coin Auction Dashboard V5 siap."
);
