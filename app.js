"use strict";

/* =========================================================
   COIN AUCTION DASHBOARD
   =========================================================
   COIN:
   - 1 gift = nilai coin sebenarnya
   - Tidak ada x2
   - Streak dihitung dari total coin yang dikirim server

   TIMER:
   - Waktu utama = putih
   - Extra Time = merah
   - Draw Time = kuning

   UI:
   - Ranking compact
   - Foto profil diprioritaskan
   - Tidak menampilkan @viewer
   ========================================================= */


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
   EXTRA TIME
   ========================================================= */

let extraTime = 30;
let extraRemaining = 0;
let extraActive = false;


/* =========================================================
   GIFT DUPLICATE PROTECTION
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_DEDUPE_TIME = 30000;


/* =========================================================
   DOM
   ========================================================= */

const $ = (id) => {
  return document.getElementById(id);
};


/* =========================================================
   FORMAT TIME
   ========================================================= */

function formatTime(seconds) {

  seconds = Math.max(
    0,
    Math.floor(
      Number(seconds) || 0
    )
  );

  const minutes =
    Math.floor(seconds / 60);

  const secs =
    seconds % 60;

  return (
    String(minutes).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0")
  );
}


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function esc(value) {

  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    (char) => {

      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      };

      return map[char];

    }
  );

}


/* =========================================================
   INITIAL
   ========================================================= */

function getInitial(name) {

  const text =
    String(
      name || "Viewer"
    ).trim();

  if (!text) {
    return "?";
  }

  return text.charAt(0).toUpperCase();
}


/* =========================================================
   NORMALIZE ID
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

function getUserKey(data = {}) {

  const id =
    normalizeUserId(
      data.userId ||
      data.user_id ||
      data.uid
    );

  if (id) {
    return "id:" + id;
  }


  const username =
    normalizeUserId(
      data.username ||
      data.uniqueId ||
      data.unique_id
    );

  if (username) {
    return "username:" + username;
  }


  const nickname =
    normalizeUserId(
      data.nickname ||
      data.name ||
      data.displayName
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
   DISPLAY NAME
   ========================================================= */

function getDisplayName(data = {}) {

  let name =
    data.nickname ||
    data.name ||
    data.displayName ||
    data.username ||
    data.uniqueId ||
    "Viewer";

  name =
    String(name).trim();


  /*
   * Jangan tampilkan @viewer.
   */

  if (
    name.toLowerCase() === "@viewer" ||
    name.toLowerCase() === "viewer"
  ) {

    return "Peserta";

  }


  return name;

}


/* =========================================================
   AVATAR
   ========================================================= */

function getAvatar(data = {}) {

  return (
    data.avatar ||
    data.profilePictureUrl ||
    data.profilePicture ||
    data.avatarLarger ||
    data.avatarMedium ||
    data.avatarThumb ||
    data.profilePicUrl ||
    data.profile_picture_url ||
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
    getDisplayName(user);


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
          onerror="
            this.style.display='none';
            if(this.nextElementSibling){
              this.nextElementSibling.style.display='flex';
            }
          "
        >

        <span
          class="avatar-fallback"
          style="display:none"
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
   SORT USERS
   ========================================================= */

function sortedUsers() {

  return [...users].sort(
    (a, b) => {

      const coinA =
        Number(a.coins || 0);

      const coinB =
        Number(b.coins || 0);


      if (coinA !== coinB) {

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
   LEADER TIE
   ========================================================= */

function leadersAreTied() {

  const sorted =
    sortedUsers();


  if (sorted.length < 2) {
    return false;
  }


  const first =
    Number(
      sorted[0].coins || 0
    );


  const second =
    Number(
      sorted[1].coins || 0
    );


  return (
    first > 0 &&
    first === second
  );

}


/* =========================================================
   CLEAR LEADER
   ========================================================= */

function hasClearLeader() {

  const sorted =
    sortedUsers();


  if (!sorted.length) {
    return false;
  }


  const first =
    Number(
      sorted[0].coins || 0
    );


  if (first <= 0) {
    return false;
  }


  if (sorted.length === 1) {
    return true;
  }


  const second =
    Number(
      sorted[1].coins || 0
    );


  return first > second;

}


/* =========================================================
   TOAST
   ========================================================= */

function toast(message) {

  const el =
    $("toast");


  if (!el) {
    return;
  }


  el.textContent =
    message;


  el.classList.add(
    "show"
  );


  clearTimeout(
    window.__auctionToastTimer
  );


  window.__auctionToastTimer =
    setTimeout(
      () => {

        el.classList.remove(
          "show"
        );

      },
      2200
    );

}


/* =========================================================
   TIMER COLOR
   ========================================================= */

function updateTimerColor() {

  const timer =
    $("timer");


  if (!timer) {
    return;
  }


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
   READ MAIN TIME
   ========================================================= */

function readMainDuration() {

  const minuteInput =
    $("minuteInput");

  const secondInput =
    $("secondInput");


  let minutes =
    Number(
      minuteInput?.value ?? 5
    );


  let seconds =
    Number(
      secondInput?.value ?? 0
    );


  if (!Number.isFinite(minutes)) {
    minutes = 5;
  }


  if (!Number.isFinite(seconds)) {
    seconds = 0;
  }


  minutes =
    Math.max(
      0,
      Math.min(
        120,
        Math.floor(minutes)
      )
    );


  seconds =
    Math.max(
      0,
      Math.min(
        59,
        Math.floor(seconds)
      )
    );


  duration =
    minutes * 60 +
    seconds;


  if (duration <= 0) {
    duration = 1;
  }


  /*
   * Kalau timer belum berjalan,
   * langsung gunakan waktu baru.
   */

  if (
    !running &&
    !extraActive &&
    !inDraw
  ) {

    remaining =
      duration;

  }

}


/* =========================================================
   READ EXTRA TIME
   ========================================================= */

function readExtraTime() {

  const input =
    $("extraTimeInput");


  if (!input) {
    return;
  }


  let value =
    Number(
      input.value
    );


  if (!Number.isFinite(value)) {
    value = 30;
  }


  value =
    Math.max(
      0,
      Math.min(
        3600,
        Math.floor(value)
      )
    );


  extraTime =
    value;

}


/* =========================================================
   READ SETTINGS
   ========================================================= */

function readSettings() {

  readMainDuration();

  readExtraTime();


  const titleInput =
    $("titleInput");


  if (
    titleInput &&
    titleInput.value.trim()
  ) {

    auctionTitle =
      titleInput.value.trim();

  }


  const topInput =
    $("topInput");


  if (topInput) {

    const value =
      Number(
        topInput.value
      );


    if (
      Number.isFinite(value) &&
      value > 0
    ) {

      topLimit =
        Math.floor(value);

    }

  }


  render();

}


/* =========================================================
   SAVE SETTINGS
   ========================================================= */

function saveSettings() {

  const wasRunning =
    running;


  readSettings();


  /*
   * Jika tidak sedang berjalan,
   * reset timer utama ke pengaturan baru.
   */

  if (!wasRunning) {

    remaining =
      duration;

    extraActive =
      false;

    extraRemaining =
      0;

    inDraw =
      false;

    drawRemaining =
      drawDuration;

    auctionFinished =
      false;

  }


  syncAuctionState();

  render();


  toast(
    "⚙️ Pengaturan berhasil disimpan"
  );

}


/* =========================================================
   START EXTRA TIME
   ========================================================= */

function startExtraTime() {

  readExtraTime();


  if (extraTime <= 0) {

    if (leadersAreTied()) {

      startDrawTime();

    } else {

      finishAuction(
        "Waktu habis"
      );

    }

    return;

  }


  extraActive =
    true;


  extraRemaining =
    extraTime;


  auctionFinished =
    false;


  const note =
    $("timerNote");


  if (note) {

    note.textContent =
      "🔴 EXTRA TIME AKTIF";

  }


  toast(
    `🔴 Extra Time ${formatTime(extraTime)}`
  );


  syncAuctionState();

  render();

}


/* =========================================================
   START DRAW
   ========================================================= */

function startDrawTime() {

  inDraw =
    true;


  drawRemaining =
    drawDuration;


  extraActive =
    false;


  extraRemaining =
    0;


  auctionFinished =
    false;


  const note =
    $("timerNote");


  if (note) {

    note.textContent =
      "⚡ DRAW TIME AKTIF";

  }


  toast(
    `⚡ DRAW TIME ${drawDuration} DETIK`
  );


  syncAuctionState();

  render();

}


/* =========================================================
   FINISH
   ========================================================= */

function finishAuction(
  message = "Selesai"
) {

  running =
    false;


  clearInterval(
    interval
  );


  interval =
    null;


  extraActive =
    false;


  extraRemaining =
    0;


  inDraw =
    false;


  auctionFinished =
    true;


  const note =
    $("timerNote");


  if (note) {

    note.textContent =
      message;

  }


  const extraStatus =
    $("extraTimeStatus");


  if (extraStatus) {

    extraStatus.textContent =
      "";

    extraStatus.classList.remove(
      "active"
    );

  }


  syncAuctionState();

  render();


  toast(
    "🏆 " + message
  );

}


/* =========================================================
   HANDLE TIMER END
   ========================================================= */

function handleTimeEnd() {

  /*
   * DRAW TIME SELESAI
   */

  if (inDraw) {

    if (hasClearLeader()) {

      finishAuction(
        "DRAW TIME selesai"
      );

    } else {

      finishAuction(
        "Hasil masih seri"
      );

    }

    return;

  }


  /*
   * EXTRA TIME SELESAI
   */

  if (extraActive) {

    extraActive =
      false;


    extraRemaining =
      0;


    if (leadersAreTied()) {

      startDrawTime();

    } else {

      finishAuction(
        "Extra Time selesai"
      );

    }

    return;

  }


  /*
   * WAKTU UTAMA SELESAI
   *
   * Extra Time dijalankan dahulu.
   */

  readExtraTime();


  if (extraTime > 0) {

    startExtraTime();

    return;

  }


  /*
   * Tidak ada Extra Time.
   * Kalau seri -> Draw Time.
   */

  if (leadersAreTied()) {

    startDrawTime();

    return;

  }


  finishAuction(
    "Waktu selesai"
  );

}


/* =========================================================
   TIMER TICK
   ========================================================= */

function tick() {

  if (!running) {
    return;
  }


  /*
   * DRAW
   */

  if (inDraw) {

    if (drawRemaining > 0) {

      drawRemaining--;

      render();

      syncAuctionState();

      return;

    }


    handleTimeEnd();

    return;

  }


  /*
   * EXTRA
   */

  if (extraActive) {

    if (extraRemaining > 0) {

      extraRemaining--;

      render();

      syncAuctionState();

      return;

    }


    handleTimeEnd();

    return;

  }


  /*
   * MAIN
   */

  if (remaining > 0) {

    remaining--;

    render();

    syncAuctionState();

    return;

  }


  handleTimeEnd();

}


/* =========================================================
   SET RUNNING
   ========================================================= */

function setRunning(value) {

  running =
    Boolean(value);


  clearInterval(
    interval
  );


  interval =
    null;


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
   START AUCTION
   ========================================================= */

function startAuction() {

  /*
   * Kalau sebelumnya sudah selesai,
   * mulai sesi baru.
   */

  if (auctionFinished) {

    auctionFinished =
      false;

    remaining =
      duration;

    extraActive =
      false;

    extraRemaining =
      0;

    inDraw =
      false;

    drawRemaining =
      drawDuration;

  }


  /*
   * Jika timer utama sudah 0
   * dan belum masuk fase lain,
   * mulai dari durasi baru.
   */

  if (
    remaining <= 0 &&
    !extraActive &&
    !inDraw
  ) {

    remaining =
      duration;

  }


  setRunning(
    true
  );


  toast(
    "▶️ Dimulai"
  );

}


/* =========================================================
   PAUSE
   ========================================================= */

function pauseAuction() {

  if (!running) {

    toast(
      "⏸ Sudah dijeda"
    );

    return;

  }


  setRunning(
    false
  );


  toast(
    "⏸ Dijeda"
  );

}


/* =========================================================
   RESET
   ========================================================= */

function resetAuction() {

  clearInterval(
    interval
  );


  interval =
    null;


  running =
    false;


  auctionFinished =
    false;


  inDraw =
    false;


  extraActive =
    false;


  remaining =
    duration;


  extraRemaining =
    0;


  drawRemaining =
    drawDuration;


  users = [];

  activities = [];

  liveEventCount =
    0;


  const note =
    $("timerNote");


  if (note) {

    note.textContent =
      "Siap untuk memulai";

  }


  syncAuctionState();

  render();


  toast(
    "↻ Di-reset"
  );

}


/* =========================================================
   FINISH BUTTON
   ========================================================= */

function finishButton() {

  finishAuction(
    "Selesai"
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
      getDisplayName(data),

    coins:
      Math.max(
        0,
        Number(
          data.coins ??
          data.coin ??
          data.coinValue ??
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


  let existing =
    users.find(
      (user) => {

        if (
          normalized.userId &&
          user.userId
        ) {

          return (
            String(
              normalized.userId
            ) ===
            String(
              user.userId
            )
          );

        }


        if (
          normalized.username &&
          user.username
        ) {

          return (
            normalizeUserId(
              normalized.username
            ) ===
            normalizeUserId(
              user.username
            )
          );

        }


        return (
          user.key ===
          normalized.key
        );

      }
    );


  if (!existing) {

    users.push(
      normalized
    );

  } else {

    if (normalized.name) {

      existing.name =
        normalized.name;

    }


    if (normalized.username) {

      existing.username =
        normalized.username;

    }


    if (normalized.avatar) {

      existing.avatar =
        normalized.avatar;

    }


    if (
      Number.isFinite(
        normalized.coins
      )
    ) {

      existing.coins =
        normalized.coins;

    }

  }


  render();

}


/* =========================================================
   GIFT EVENT KEY
   ========================================================= */

function getGiftEventKey(data = {}) {

  const stableId =
    data.msgId ||
    data.messageId ||
    data.transactionId ||
    data.transaction_id ||
    data.groupId ||
    data.group_id;


  if (stableId) {

    return (
      "gift:" +
      String(stableId)
    );

  }


  return [
    data.username ||
    data.uniqueId ||
    "",

    data.giftId ||
    "",

    data.giftName ||
    "",

    data.coinValue ??
    data.coins ??
    data.diamondCount ??
    "",

    data.repeatCount ??
    ""

  ].join("|");

}


/* =========================================================
   GIFT DUPLICATE CHECK
   ========================================================= */

function isDuplicateGift(data) {

  /*
   * Test/manual gift jangan dideduplikasi.
   */

  if (data.__test) {
    return false;
  }


  const key =
    getGiftEventKey(data);


  const now =
    Date.now();


  /*
   * Bersihkan data lama.
   */

  for (
    const [oldKey, timestamp]
    of processedGiftEvents
  ) {

    if (
      now - timestamp >
      GIFT_DEDUPE_TIME
    ) {

      processedGiftEvents.delete(
        oldKey
      );

    }

  }


  if (
    processedGiftEvents.has(key)
  ) {

    return true;

  }


  processedGiftEvents.set(
    key,
    now
  );


  return false;

}


/* =========================================================
   HANDLE GIFT
   ========================================================= */

function handleGift(data = {}) {

  /*
   * Jangan proses gift yang sama dua kali.
   */

  if (
    isDuplicateGift(data)
  ) {

    console.log(
      "Gift duplicate diabaikan:",
      data
    );

    return;

  }


  /*
   * TikTok streak gift:
   * server seharusnya mengirim final event.
   */

  if (
    Number(data.giftType) === 1 &&
    data.repeatEnd === false
  ) {

    return;

  }


  /*
   * COIN 1:1
   *
   * Prioritas:
   * coinValue dari server
   * kemudian coins
   * kemudian diamondCount.
   *
   * Tidak ada x2.
   */

  let coins;


  if (
    data.coinValue !== undefined &&
    data.coinValue !== null
  ) {

    coins =
      Number(
        data.coinValue
      );

  } else if (
    data.coins !== undefined &&
    data.coins !== null
  ) {

    coins =
      Number(
        data.coins
      );

  } else {

    const diamondCount =
      Number(
        data.diamondCount ||
        data.diamonds ||
        0
      );


    const repeatCount =
      Number(
        data.repeatCount ||
        1
      );


    /*
     * 1 coin per diamond,
     * repeat count hanya untuk
     * menghitung jumlah gift streak.
     */

    coins =
      diamondCount *
      Math.max(
        1,
        repeatCount
      );

  }


  if (
    !Number.isFinite(coins) ||
    coins <= 0
  ) {

    console.warn(
      "Gift tanpa coin diabaikan:",
      data
    );

    return;

  }


  coins =
    Math.floor(
      coins
    );


  const normalized =
    normalizeUser(data);


  let existing =
    users.find(
      (user) => {

        if (
          normalized.userId &&
          user.userId
        ) {

          return (
            String(
              normalized.userId
            ) ===
            String(
              user.userId
            )
          );

        }


        if (
          normalized.username &&
          user.username
        ) {

          return (
            normalizeUserId(
              normalized.username
            ) ===
            normalizeUserId(
              user.username
            )
          );

        }


        return (
          user.key ===
          normalized.key
        );

      }
    );


  if (!existing) {

    existing = {
      ...normalized,
      coins: 0
    };


    users.push(
      existing
    );

  }


  /*
   * Tambahkan coin 1:1.
   */

  existing.coins =
    Number(
      existing.coins || 0
    ) + coins;


  if (normalized.name) {

    existing.name =
      normalized.name;

  }


  if (normalized.username) {

    existing.username =
      normalized.username;

  }


  if (normalized.avatar) {

    existing.avatar =
      normalized.avatar;

  }


  liveEventCount++;


  activities.unshift({

    name:
      existing.name,

    username:
      existing.username,

    avatar:
      existing.avatar,

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
   RENDER RANKING
   ========================================================= */

function renderRanking() {

  const list =
    $("rankingList");


  if (!list) {
    return;
  }


  const sorted =
    sortedUsers();


  if (!sorted.length) {

    list.innerHTML = `
      <div class="rank-card rank-box empty-box">
        <div class="rank-info">
          <strong>Menunggu peserta</strong>
        </div>
      </div>
    `;

    return;

  }


  const medals = [
    "🥇",
    "🥈",
    "🥉"
  ];


  list.innerHTML =
    sorted
      .slice(
        0,
        topLimit
      )
      .map(
        (user, index) => {

          const rank =
            index + 1;


          const medal =
            medals[index] ||
            "#" + rank;


          return `
            <article
              class="rank-card rank-box"
            >

              <div class="box-top">

                <span class="rank-no">
                  ${medal}
                </span>

                <span class="box-rank">
                  ${rank}
                </span>

              </div>

              ${avatarHTML(user)}

              <div class="rank-info">

                <strong>
                  ${esc(
                    getDisplayName(user)
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
                    ).toLocaleString(
                      "id-ID"
                    )
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

  const list =
    $("activityList");


  if (!list) {
    return;
  }


  if (!activities.length) {

    list.innerHTML = `
      <p class="empty">
        Belum ada gift masuk.
      </p>
    `;

    return;

  }


  list.innerHTML =
    activities
      .slice(
        0,
        10
      )
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
                    "Peserta"
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
                🪙 +${
                  Number(
                    activity.coins || 0
                  ).toLocaleString(
                    "id-ID"
                  )
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

    let currentTime;


    if (inDraw) {

      currentTime =
        drawRemaining;

    } else if (extraActive) {

      currentTime =
        extraRemaining;

    } else {

      currentTime =
        remaining;

    }


    timer.textContent =
      formatTime(
        currentTime
      );

  }


  /*
   * Judul
   */

  const title =
    $("auctionTitleDisplay");


  if (title) {

    title.textContent =
      auctionTitle;

  }


  /*
   * Jumlah peserta
   */

  const count =
    $("participantCount");


  if (count) {

    count.textContent =
      `${users.length} peserta`;

  }


  /*
   * Progress
   */

  const progress =
    $("progressBar");


  if (progress) {

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


    progress.style.width =
      percent + "%";

  }


  /*
   * Timer note
   */

  const note =
    $("timerNote");


  if (note) {

    if (inDraw) {

      note.textContent =
        "⚡ DRAW TIME AKTIF";

    } else if (extraActive) {

      note.textContent =
        "🔴 EXTRA TIME AKTIF";

    } else if (auctionFinished) {

      /*
       * Jangan menimpa pesan selesai.
       */

    } else if (running) {

      note.textContent =
        "⏱️ Waktu sedang berjalan";

    } else if (
      remaining < duration
    ) {

      note.textContent =
        "⏸ Dijeda";

    } else {

      note.textContent =
        "Siap untuk memulai";

    }

  }


  /*
   * Extra Time status
   */

  const extraStatus =
    $("extraTimeStatus");


  if (extraStatus) {

    if (extraActive) {

      extraStatus.textContent =
        "🔴 EXTRA TIME — " +
        formatTime(
          extraRemaining
        );

      extraStatus.classList.add(
        "active"
      );

    } else if (inDraw) {

      extraStatus.textContent =
        "⚡ DRAW TIME AKTIF";

      extraStatus.classList.remove(
        "active"
      );

    } else {

      if (extraTime > 0) {

        extraStatus.textContent =
          "Extra Time tersedia: " +
          formatTime(
            extraTime
          );

      } else {

        extraStatus.textContent =
          "Extra Time tidak digunakan";

      }


      extraStatus.classList.remove(
        "active"
      );

    }

  }


  /*
   * Event count
   */

  const hero =
    $("heroViewer");


  if (hero) {

    hero.textContent =
      liveEventCount;

  }


  /*
   * TikTok name
   */

  const liveName =
    $("liveName");


  if (liveName) {

    liveName.textContent =
      connectedUsername
        ? "@" +
          connectedUsername.replace(
            /^@/,
            ""
          )
        : "@Belum Terhubung";

  }


  /*
   * Status
   */

  const badge =
    $("statusBadge");


  if (badge) {

    badge.textContent =
      liveConnected
        ? "ONLINE"
        : "OFFLINE";


    badge.classList.toggle(
      "offline",
      !liveConnected
    );


    badge.classList.toggle(
      "online",
      liveConnected
    );

  }


  renderRanking();

  renderActivities();

  updateTimerColor();

}


/* =========================================================
   SYNC AUCTION STATE
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
   CONNECT TIKTOK
   ========================================================= */

function connectTikTok() {

  const input =
    $("tiktokUsername");


  if (!input) {
    return;
  }


  const username =
    input.value
      .trim()
      .replace(
        /^@/,
        ""
      );


  if (!username) {

    toast(
      "Masukkan username TikTok"
    );

    input.focus();

    return;

  }


  if (
    !socket ||
    !socket.connected
  ) {

    toast(
      "Server belum terhubung"
    );

    return;

  }


  const log =
    $("connectionLog");


  if (log) {

    log.textContent =
      "Status: menghubungkan ke TikTok LIVE...";

  }


  socket.emit(
    "live:connect",
    {
      username
    }
  );


  toast(
    "🔌 Menghubungkan..."
  );

}


/* =========================================================
   DISCONNECT TIKTOK
   ========================================================= */

function disconnectTikTok() {

  if (
    socket &&
    socket.connected
  ) {

    socket.emit(
      "live:disconnect"
    );

  }


  liveConnected =
    false;


  connectedUsername =
    "";


  const log =
    $("connectionLog");


  if (log) {

    log.textContent =
      "Status: koneksi diputuskan";

  }


  render();


  toast(
    "🔌 Koneksi diputuskan"
  );

}


/* =========================================================
   SOCKET CONNECTION
   ========================================================= */

function connectSocket() {

  if (
    typeof io !== "function"
  ) {

    console.error(
      "Socket.IO client tidak ditemukan."
    );

    const log =
      $("connectionLog");


    if (log) {

      log.textContent =
        "Status: Socket.IO tidak ditemukan";

    }

    return;

  }


  socket =
    io();


  socket.on(
    "connect",
    () => {

      console.log(
        "✅ Socket.IO connected"
      );


      const log =
        $("connectionLog");


      if (log) {

        log.textContent =
          "Status: server terhubung";

      }


      /*
       * Jangan menganggap socket connected
       * berarti TikTok LIVE connected.
       */

      render();

      syncAuctionState();

    }
  );


  socket.on(
    "disconnect",
    () => {

      console.log(
        "❌ Socket.IO disconnected"
      );


      liveConnected =
        false;


      const log =
        $("connectionLog");


      if (log) {

        log.textContent =
          "Status: server terputus";

      }


      render();

    }
  );


  /* =======================================================
     LIVE STATUS
     ======================================================= */

  socket.on(
    "live:status",
    (data = {}) => {

      console.log(
        "LIVE STATUS:",
        data
      );


      liveConnected =
        Boolean(
          data.connected ??
          data.active ??
          false
        );


      connectedUsername =
        data.username ||
        data.uniqueId ||
        data.user ||
        connectedUsername ||
        "";


      const log =
        $("connectionLog");


      if (log) {

        if (data.message) {

          log.textContent =
            "Status: " +
            data.message;

        } else {

          log.textContent =
            liveConnected
              ? "Status: TikTok LIVE terhubung"
              : "Status: belum terhubung";

        }

      }


      render();

    }
  );


  /* =======================================================
     PARTICIPANTS
     ======================================================= */

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


  /* =======================================================
     USER UPDATE
     ======================================================= */

  socket.on(
    "user:update",
    updateUser
  );


  socket.on(
    "participant:update",
    updateUser
  );


  /* =======================================================
     GIFT EVENTS
     ======================================================= */

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


  /*
   * live:event hanya diproses jika type = gift.
   */

  socket.on(
    "live:event",
    (event = {}) => {

      if (
        event.type === "gift" &&
        event.data
      ) {

        handleGift(
          event.data
        );

      }

    }
  );


  /* =======================================================
     AUCTION STATE
     ======================================================= */

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
        typeof data.inDraw ===
        "boolean"
      ) {

        inDraw =
          data.inDraw;

      }


      if (
        typeof data.drawRemaining ===
        "number"
      ) {

        drawRemaining =
          data.drawRemaining;

      }


      if (
        typeof data.drawDuration ===
        "number"
      ) {

        drawDuration =
          data.drawDuration;

      }


      render();

    }
  );

}


/* =========================================================
   BUTTON BIND
   ========================================================= */

function bindButtons() {

  const startBtn =
    $("startBtn");


  if (startBtn) {

    startBtn.addEventListener(
      "click",
      startAuction
    );

  }


  const pauseBtn =
    $("pauseBtn");


  if (pauseBtn) {

    pauseBtn.addEventListener(
      "click",
      pauseAuction
    );

  }


  const resetBtn =
    $("resetBtn");


  if (resetBtn) {

    resetBtn.addEventListener(
      "click",
      resetAuction
    );

  }


  const finishBtn =
    $("finishBtn");


  if (finishBtn) {

    finishBtn.addEventListener(
      "click",
      finishButton
    );

  }


  const connectBtn =
    $("connectBtn");


  if (connectBtn) {

    connectBtn.addEventListener(
      "click",
      connectTikTok
    );

  }


  const disconnectBtn =
    $("disconnectBtn");


  if (disconnectBtn) {

    disconnectBtn.addEventListener(
      "click",
      disconnectTikTok
    );

  }


  const saveBtn =
    $("saveSettings");


  if (saveBtn) {

    saveBtn.addEventListener(
      "click",
      saveSettings
    );

  }

}


/* =========================================================
   INPUT BIND
   ========================================================= */

function bindInputs() {

  const ids = [
    "minuteInput",
    "secondInput",
    "extraTimeInput",
    "titleInput",
    "topInput"
  ];


  ids.forEach(
    (id) => {

      const input =
        $(id);


      if (!input) {
        return;
      }


      input.addEventListener(
        "input",
        () => {

          /*
           * Jangan reset timer saat sedang berjalan.
           * Hanya update tampilan pengaturan.
           */

          if (id === "extraTimeInput") {

            const value =
              Number(
                input.value
              );


            if (
              Number.isFinite(value)
            ) {

              extraTime =
                Math.max(
                  0,
                  Math.min(
                    3600,
                    Math.floor(value)
                  )
                );

            }

          }


          if (id === "topInput") {

            const value =
              Number(
                input.value
              );


            if (
              Number.isFinite(value) &&
              value > 0
            ) {

              topLimit =
                Math.floor(value);

            }

          }


          if (id === "titleInput") {

            if (
              input.value.trim()
            ) {

              auctionTitle =
                input.value.trim();

            }

          }


          render();

        }
      );

    }
  );

}


/* =========================================================
   KEYBOARD ENTER FOR USERNAME
   ========================================================= */

function bindUsernameEnter() {

  const input =
    $("tiktokUsername");


  if (!input) {
    return;
  }


  input.addEventListener(
    "keydown",
    (event) => {

      if (
        event.key ===
        "Enter"
      ) {

        event.preventDefault();

        connectTikTok();

      }

    }
  );

}


/* =========================================================
   DEBUG / TEST
   =========================================================
   Karena coin TikTok Anda sudah habis,
   fungsi ini bisa dipakai untuk simulasi gift.

   Contoh di Console browser:

   auctionDebug.addTestCoin("Budi", 100)

   lalu:

   auctionDebug.addTestCoin("Andi", 200)
   ========================================================= */

window.auctionDebug = {

  getUsers: function() {

    return users;

  },


  getState: function() {

    return {

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

    };

  },


  addTestCoin: function(
    username = "Test User",
    coins = 10
  ) {

    handleGift({

      __test: true,

      username,

      uniqueId:
        username,

      nickname:
        username,

      giftName:
        "Test Gift",

      coinValue:
        Number(coins) || 0

    });

  },


  reset:
    resetAuction

};


/* =========================================================
   GLOBAL FUNCTIONS
   ========================================================= */

window.startAuction =
  startAuction;

window.pauseAuction =
  pauseAuction;

window.resetAuction =
  resetAuction;

window.finishAuction =
  finishButton;

window.saveSettings =
  saveSettings;


/* =========================================================
   INIT
   ========================================================= */

function init() {

  console.log(
    "🚀 Coin Auction Dashboard mulai..."
  );


  /*
   * Baca pengaturan awal.
   */

  readSettings();


  /*
   * Pasang event tombol.
   */

  bindButtons();


  /*
   * Pasang event input.
   */

  bindInputs();


  /*
   * Enter pada username.
   */

  bindUsernameEnter();


  /*
   * Render awal.
   */

  render();


  /*
   * Socket.
   */

  connectSocket();


  console.log(
    "✅ Semua tombol sudah dipasang."
  );

}


/* =========================================================
   START AFTER DOM READY
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
