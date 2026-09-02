/* =========================================================
   COIN AUCTION DASHBOARD V6
   =========================================================

   FITUR:

   - Coin gift 1:1
   - Tidak ada x2
   - Repeat gift dihitung sesuai repeatCount
   - Tidak menampilkan @viewer
   - Foto profil TikTok diprioritaskan
   - Peserta compact
   - Extra Time benar-benar berjalan
   - Timer utama PUTIH
   - Extra Time MERAH saat aktif
   - Draw Time KUNING saat aktif
   - Menit + detik digunakan
   - Socket.IO compatible
   - Anti double gift event
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
   EXTRA TIME
   ========================================================= */

let extraTime = 30;
let extraRemaining = 0;
let extraActive = false;


/* =========================================================
   ANTI DOUBLE EVENT
   ========================================================= */

const processedGiftEvents = new Map();

const GIFT_DEDUP_TIME = 60000;


/* =========================================================
   DOM HELPER
   ========================================================= */

const $ = (id) =>
  document.getElementById(id);


/* =========================================================
   FORMAT NUMBER
   ========================================================= */

function formatNumber(value) {

  const number =
    Number(value || 0);

  return Math.max(
    0,
    Math.floor(number)
  ).toLocaleString(
    "id-ID"
  );

}


/* =========================================================
   FORMAT TIME
   ========================================================= */

function formatTime(sec) {

  sec =
    Math.max(
      0,
      Math.floor(
        Number(sec) || 0
      )
    );


  const minutes =
    Math.floor(sec / 60);

  const seconds =
    sec % 60;


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

  return String(
    value ?? ""
  ).replace(
    /[&<>"']/g,
    (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[m])
  );

}


/* =========================================================
   INITIAL
   ========================================================= */

function getInitial(name) {

  const text =
    String(
      name ||
      "Peserta"
    ).trim();


  if (!text) {
    return "?";
  }


  return text
    .charAt(0)
    .toUpperCase();

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
   USER NAME
   ========================================================= */

function getUserName(data = {}) {

  let name =
    data.nickname ||
    data.displayName ||
    data.name ||
    data.uniqueId ||
    data.unique_id ||
    data.username ||
    "";


  name =
    String(name || "")
      .trim();


  /*
   * Jangan tampilkan @viewer
   */

  if (
    name.toLowerCase() === "@viewer" ||
    name.toLowerCase() === "viewer"
  ) {

    return "Peserta";

  }


  if (
    name.startsWith("@")
  ) {

    name =
      name.substring(1);

  }


  return (
    name ||
    "Peserta"
  );

}


/* =========================================================
   USER KEY
   ========================================================= */

function getUserKey(data = {}) {

  const id =
    normalizeUserId(
      data.userId ||
      data.user_id ||
      data.uid ||
      data.id
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
    user?.name ||
    "Peserta";


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
   SORT USERS
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
   LEADER TIE
   ========================================================= */

function leadersAreTied() {

  const sorted =
    sortedUsers();


  if (
    sorted.length < 2
  ) {

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


  if (
    sorted.length < 1
  ) {

    return false;

  }


  const first =
    Number(
      sorted[0].coins || 0
    );


  if (first <= 0) {

    return false;

  }


  if (
    sorted.length === 1
  ) {

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


  /*
   * DRAW = KUNING
   */

  if (inDraw) {

    timer.classList.add(
      "draw-time-active"
    );

    timer.style.color =
      "#ffd43b";

    return;

  }


  /*
   * EXTRA = MERAH
   */

  if (extraActive) {

    timer.classList.add(
      "extra-active"
    );

    timer.style.color =
      "#ff3030";

    return;

  }


  /*
   * TIMER UTAMA = PUTIH
   */

  timer.style.color =
    "#ffffff";

}


/* =========================================================
   MAIN DURATION
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


  if (
    !Number.isFinite(minutes)
  ) {

    minutes = 5;

  }


  if (
    !Number.isFinite(seconds)
  ) {

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


  /*
   * Minimal 1 detik
   */

  if (
    duration <= 0
  ) {

    duration = 1;

  }


  /*
   * Hanya reset timer utama
   * kalau belum berjalan.
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
   EXTRA TIME
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


  if (
    !Number.isFinite(value)
  ) {

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


  if (!extraActive) {

    extraRemaining = 0;

  }


  updateExtraSettingDisplay();

}


/* =========================================================
   EXTRA TIME DISPLAY
   ========================================================= */

function updateExtraSettingDisplay() {

  const status =
    $("extraTimeStatus");


  if (!status) {
    return;
  }


  /*
   * Extra aktif
   */

  if (extraActive) {

    status.textContent =
      "🔴 EXTRA TIME AKTIF — " +
      formatTime(extraRemaining);

    status.classList.add(
      "active"
    );

    return;

  }


  /*
   * Draw aktif
   */

  if (inDraw) {

    status.textContent =
      "🟡 DRAW TIME AKTIF — " +
      formatTime(drawRemaining);

    status.classList.remove(
      "active"
    );

    return;

  }


  /*
   * Belum aktif
   */

  if (
    extraTime > 0
  ) {

    status.textContent =
      "Extra Time tersedia — " +
      formatTime(extraTime);

  } else {

    status.textContent =
      "Extra Time: OFF";

  }


  status.classList.remove(
    "active"
  );

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


  updateTitleDisplay();

  render();

}


/* =========================================================
   SAVE SETTINGS
   ========================================================= */

function saveSettings() {

  readSettings();


  toast(
    "✓ Pengaturan berhasil disimpan"
  );


  syncAuctionState();

}


/* =========================================================
   WRITE SETTINGS TO INPUT
   ========================================================= */

function writeSettingsToInputs() {

  const titleInput =
    $("titleInput");


  if (titleInput) {

    titleInput.value =
      auctionTitle;

  }


  const totalMinutes =
    Math.floor(
      duration / 60
    );


  const totalSeconds =
    duration % 60;


  const minuteInput =
    $("minuteInput");


  const secondInput =
    $("secondInput");


  if (minuteInput) {

    minuteInput.value =
      totalMinutes;

  }


  if (secondInput) {

    secondInput.value =
      totalSeconds;

  }


  const topInput =
    $("topInput");


  if (topInput) {

    topInput.value =
      String(topLimit);

  }


  const extraInput =
    $("extraTimeInput");


  if (extraInput) {

    extraInput.value =
      extraTime;

  }

}


/* =========================================================
   TITLE DISPLAY
   ========================================================= */

function updateTitleDisplay() {

  const el =
    $("auctionTitleDisplay");


  if (!el) {
    return;
  }


  el.textContent =
    auctionTitle ||
    "LIVE COIN AUCTION";

}


/* =========================================================
   TIMER NOTE
   ========================================================= */

function updateTimerNote() {

  const note =
    $("timerNote");


  if (!note) {
    return;
  }


  if (auctionFinished) {

    note.textContent =
      "Sesi selesai";

    return;

  }


  if (inDraw) {

    if (running) {

      note.textContent =
        "🟡 DRAW TIME — Tentukan hasil";

    } else {

      note.textContent =
        "⏸ Draw Time dijeda";

    }

    return;

  }


  if (extraActive) {

    if (running) {

      note.textContent =
        "🔴 EXTRA TIME sedang berjalan";

    } else {

      note.textContent =
        "⏸ Extra Time dijeda";

    }

    return;

  }


  if (running) {

    note.textContent =
      "⏱️ Waktu utama berjalan";

    return;

  }


  if (
    remaining < duration
  ) {

    note.textContent =
      "⏸ Dijeda";

    return;

  }


  note.textContent =
    "Siap untuk dimulai";

}


/* =========================================================
   PROGRESS
   ========================================================= */

function updateProgress() {

  const bar =
    $("progressBar");


  if (!bar) {
    return;
  }


  let current = 0;
  let total = 1;


  if (inDraw) {

    current =
      drawRemaining;

    total =
      drawDuration;

  } else if (extraActive) {

    current =
      extraRemaining;

    total =
      extraTime || 1;

  } else {

    current =
      remaining;

    total =
      duration || 1;

  }


  let percent =
    (
      current /
      total
    ) * 100;


  percent =
    Math.max(
      0,
      Math.min(
        100,
        percent
      )
    );


  bar.style.width =
    percent + "%";

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


  const visible =
    sorted.slice(
      0,
      topLimit
    );


  if (!visible.length) {

    list.innerHTML = `
      <div class="empty-box">
        Menunggu peserta
      </div>
    `;

    return;

  }


  list.innerHTML =
    visible.map(
      (user, index) => {

        const rank =
          index + 1;


        const coin =
          Number(
            user.coins || 0
          );


        return `
          <div
            class="rank-card rank-box"
          >

            <div class="box-top">

              <div class="rank-no">
                ${rank}
              </div>


              ${avatarHTML(user)}


              <div class="rank-info">

                <strong>
                  ${esc(user.name)}
                </strong>

                <span>
                  @${esc(user.username || "")}
                </span>

              </div>


              <div class="coin">

                <span class="coin-icon">
                  🪙
                </span>

                <strong>
                  ${formatNumber(coin)}
                </strong>

              </div>

            </div>

          </div>
        `;

      }
    ).join("");

}


/* =========================================================
   RENDER ACTIVITY
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
      .slice(0, 20)
      .map(
        (item) => `

          <div class="activity-item">

            <div class="activity-avatar">

              ${avatarHTML(
                {
                  name: item.name,
                  avatar: item.avatar
                },
                "user-avatar"
              )}

            </div>


            <div class="activity-info">

              <strong>
                ${esc(item.name)}
              </strong>

              <span>
                ${esc(item.giftName)}
                × ${formatNumber(item.repeatCount)}
              </span>

            </div>


            <div class="activity-coins">

              +${formatNumber(item.coins)}

            </div>

          </div>

        `
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

    if (inDraw) {

      timer.textContent =
        formatTime(drawRemaining);

    } else if (extraActive) {

      timer.textContent =
        formatTime(extraRemaining);

    } else {

      timer.textContent =
        formatTime(remaining);

    }

  }


  updateTitleDisplay();

  updateTimerNote();

  updateProgress();

  updateExtraSettingDisplay();

  updateTimerColor();

  renderRanking();

  renderActivities();


  const count =
    $("participantCount");


  if (count) {

    count.textContent =
      users.length +
      " peserta";

  }


  const hero =
    $("heroViewer");


  if (hero) {

    hero.textContent =
      liveEventCount;

  }


  /*
   * Tampilkan event count
   */

  const heroStat =
    document.querySelector(
      ".hero-stat span"
    );


  if (heroStat) {

    heroStat.textContent =
      "EVENT LIVE";

  }

}


/* =========================================================
   CONNECTION STATUS
   ========================================================= */

function updateConnectionUI(
  connected,
  username = "",
  message = ""
) {

  liveConnected =
    Boolean(connected);


  if (username) {

    connectedUsername =
      String(username)
        .replace(/^@/, "")
        .trim();

  }


  const badge =
    $("statusBadge");


  const name =
    $("liveName");


  const log =
    $("connectionLog");


  const connectBtn =
    $("connectBtn");


  const disconnectBtn =
    $("disconnectBtn");


  if (liveConnected) {

    if (badge) {

      badge.textContent =
        "ONLINE";

      badge.classList.remove(
        "offline"
      );

      badge.classList.add(
        "online"
      );

    }


    if (name) {

      name.textContent =
        "@" +
        (
          connectedUsername ||
          "LIVE"
        );

    }


    if (log) {

      log.textContent =
        message ||
        "Status: TikTok LIVE terhubung.";

    }


    if (connectBtn) {

      connectBtn.disabled =
        false;

    }


  } else {

    if (badge) {

      badge.textContent =
        "OFFLINE";

      badge.classList.remove(
        "online"
      );

      badge.classList.add(
        "offline"
      );

    }


    if (name) {

      name.textContent =
        "@Belum Terhubung";

    }


    if (log) {

      log.textContent =
        message ||
        "Status: Belum terhubung ke TikTok LIVE.";

    }

  }


  if (disconnectBtn) {

    disconnectBtn.disabled =
      !liveConnected;

  }

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


  let username =
    String(
      input.value || ""
    )
      .trim()
      .replace(/^@/, "");


  if (!username) {

    toast(
      "Masukkan username TikTok terlebih dahulu."
    );

    input.focus();

    return;

  }


  if (!socket) {

    toast(
      "Socket belum siap."
    );

    return;

  }


  connectedUsername =
    username;


  if ($("connectionLog")) {

    $("connectionLog").textContent =
      "Status: menghubungkan ke TikTok LIVE...";

  }


  if ($("statusBadge")) {

    $("statusBadge").textContent =
      "CONNECTING";

  }


  /*
   * Server event
   */

  socket.emit(
    "live:connect",
    {
      username
    }
  );


  toast(
    "⏳ Menghubungkan @" +
    username
  );

}


/* =========================================================
   DISCONNECT TIKTOK
   ========================================================= */

function disconnectTikTok() {

  if (!socket) {
    return;
  }


  socket.emit(
    "live:disconnect"
  );


  liveConnected =
    false;


  connectedUsername =
    "";


  updateConnectionUI(
    false,
    "",
    "Status: koneksi TikTok LIVE diputuskan."
  );


  toast(
    "✓ Koneksi diputuskan"
  );

}


/* =========================================================
   FIND USER
   ========================================================= */

function findUser(data) {

  const key =
    getUserKey(data);


  return {
    key,
    index:
      users.findIndex(
        (user) =>
          user.key === key
      )
  };

}


/* =========================================================
   UPSERT USER
   ========================================================= */

function upsertUser(
  data = {},
  coinsToAdd = 0
) {

  const {
    key,
    index
  } =
    findUser(data);


  const name =
    getUserName(data);


  const username =
    String(
      data.username ||
      data.uniqueId ||
      data.unique_id ||
      ""
    )
      .replace(/^@/, "")
      .trim();


  const avatar =
    getAvatar(data);


  const add =
    Math.max(
      0,
      Math.floor(
        Number(
          coinsToAdd || 0
        )
      )
    );


  if (index >= 0) {

    const user =
      users[index];


    if (
      name &&
      name !== "Peserta"
    ) {

      user.name =
        name;

    }


    if (username) {

      user.username =
        username;

    }


    if (avatar) {

      user.avatar =
        avatar;

    }


    user.coins =
      Math.max(
        0,
        Number(
          user.coins || 0
        )
      ) + add;


    return user;

  }


  const user = {

    key,

    userId:
      data.userId ||
      data.user_id ||
      data.uid ||
      "",

    username,

    name,

    nickname:
      data.nickname ||
      name,

    avatar,

    coins:
      add

  };


  users.push(
    user
  );


  return user;

}


/* =========================================================
   UPDATE USER FROM SERVER
   ========================================================= */

function updateUserFromServer(data) {

  if (!data) {
    return;
  }


  /*
   * Kalau server mengirim array user
   */

  if (
    Array.isArray(data)
  ) {

    users =
      data.map(
        (item) => {

          const user = {

            key:
              getUserKey(item),

            userId:
              item.userId ||
              item.user_id ||
              item.uid ||
              "",

            username:
              String(
                item.username ||
                item.uniqueId ||
                item.unique_id ||
                ""
              )
                .replace(/^@/, ""),

            name:
              getUserName(item),

            nickname:
              item.nickname ||
              getUserName(item),

            avatar:
              getAvatar(item),

            coins:
              Math.max(
                0,
                Number(
                  item.coins ??
                  item.coin ??
                  item.coinValue ??
                  0
                )
              )

          };


          return user;

        }
      );


    render();

    return;

  }


  /*
   * Satu user
   */

  const user =
    upsertUser(
      data,
      0
    );


  if (
    data.coins !== undefined
  ) {

    user.coins =
      Math.max(
        0,
        Number(
          data.coins || 0
        )
      );

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
    data.groupId ||
    data.giftEventId;


  if (stableId) {

    return String(
      stableId
    );

  }


  /*
   * Fallback
   */

  const username =
    normalizeUserId(
      data.username ||
      data.uniqueId ||
      data.unique_id ||
      data.userId
    );


  const giftId =
    data.giftId ||
    data.gift_id ||
    "";


  const giftName =
    data.giftName ||
    data.gift_name ||
    "";


  const coinValue =
    data.coinValue ??
    data.coins ??
    data.coinCount ??
    data.diamondCount ??
    0;


  const repeatCount =
    data.repeatCount ??
    data.repeat_count ??
    1;


  return [
    username,
    giftId,
    giftName,
    coinValue,
    repeatCount
  ].join("|");

}


/* =========================================================
   CHECK DUPLICATE
   ========================================================= */

function isDuplicateGift(data) {

  /*
   * Test manual tidak didedup.
   */

  if (
    data.__test
  ) {

    return false;

  }


  const key =
    getGiftEventKey(data);


  const now =
    Date.now();


  /*
   * Cleanup
   */

  for (
    const [
      oldKey,
      timestamp
    ] of processedGiftEvents
  ) {

    if (
      now - timestamp >
      GIFT_DEDUP_TIME
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

  if (!data) {
    return;
  }


  /*
   * Streak gift TikTok:
   * hanya proses final event.
   */

  const giftType =
    Number(
      data.giftType ??
      data.gift_type ??
      0
    );


  const repeatEnd =
    data.repeatEnd ??
    data.repeat_end;


  if (
    giftType === 1 &&
    repeatEnd === false
  ) {

    return;

  }


  /*
   * Jangan proses dua kali
   */

  if (
    isDuplicateGift(data)
  ) {

    return;

  }


  /*
   * Nama user
   */

  const name =
    getUserName(data);


  /*
   * Repeat count
   */

  const repeatCount =
    Math.max(
      1,
      Math.floor(
        Number(
          data.repeatCount ??
          data.repeat_count ??
          1
        )
      )
    );


  /*
   * =======================================================
   * COIN 1:1
   * =======================================================
   *
   * Kalau server sudah mengirim coinValue,
   * gunakan nilai tersebut.
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

    const diamond =
      Number(
        data.diamondCount ??
        data.coinCount ??
        data.coin ??
        0
      );


    /*
     * 1 gift coin = 1 coin.
     *
     * Kalau gift dikirim 5 kali,
     * diamondCount × 5.
     *
     * BUKAN ×2.
     */

    coins =
      diamond *
      repeatCount;

  }


  coins =
    Math.max(
      0,
      Math.floor(
        coins || 0
      )
    );


  if (
    coins <= 0
  ) {

    return;

  }


  /*
   * Update participant
   */

  const user =
    upsertUser(
      data,
      coins
    );


  /*
   * Event count
   */

  liveEventCount++;


  /*
   * Gift name
   */

  const giftName =
    data.giftName ||
    data.gift_name ||
    "Gift";


  /*
   * Activity
   */

  activities.unshift({

    name:
      name,

    avatar:
      getAvatar(data),

    giftName:
      giftName,

    coins:
      coins,

    repeatCount:
      repeatCount,

    time:
      Date.now()

  });


  activities =
    activities.slice(
      0,
      20
    );


  render();


  /*
   * Broadcast state
   */

  syncAuctionState();


  toast(
    "🎁 " +
    name +
    " +" +
    formatNumber(coins) +
    " coin"
  );

}


/* =========================================================
   HANDLE LIVE EVENT
   ========================================================= */

function handleLiveEvent(event) {

  if (!event) {
    return;
  }


  /*
   * Server bisa mengirim:
   *
   * {
   *   type: "gift",
   *   data: {...}
   * }
   */

  const type =
    String(
      event.type ||
      ""
    ).toLowerCase();


  if (
    type === "gift"
  ) {

    handleGift(
      event.data ||
      event
    );

  }

}


/* =========================================================
   START EXTRA TIME
   ========================================================= */

function startExtraTime() {

  if (
    extraTime <= 0
  ) {

    /*
     * Tidak ada Extra Time.
     * Langsung cek Draw.
     */

    if (
      leadersAreTied()
    ) {

      startDrawTime();

    } else {

      finishAuction();

    }

    return;

  }


  extraActive =
    true;


  extraRemaining =
    extraTime;


  running =
    true;


  auctionFinished =
    false;


  toast(
    "🔴 EXTRA TIME dimulai!"
  );


  render();

  syncAuctionState();

}


/* =========================================================
   START DRAW TIME
   ========================================================= */

function startDrawTime() {

  stopInterval();


  inDraw =
    true;


  extraActive =
    false;


  drawRemaining =
    drawDuration;


  running =
    true;


  auctionFinished =
    false;


  toast(
    "🟡 DRAW TIME dimulai!"
  );


  startInterval();

  render();

  syncAuctionState();

}


/* =========================================================
   FINISH AUCTION
   ========================================================= */

function finishAuction() {

  stopInterval();


  running =
    false;


  extraActive =
    false;


  inDraw =
    false;


  extraRemaining =
    0;


  drawRemaining =
    drawDuration;


  auctionFinished =
    true;


  const sorted =
    sortedUsers();


  if (
    sorted.length > 0 &&
    Number(
      sorted[0].coins || 0
    ) > 0
  ) {

    if (
      hasClearLeader()
    ) {

      toast(
        "🏆 Selesai — " +
        sorted[0].name +
        " menang!"
      );

    } else {

      toast(
        "🤝 Selesai"
      );

    }

  } else {

    toast(
      "■ Selesai"
    );

  }


  render();

  syncAuctionState();

}


/* =========================================================
   HANDLE TIME END
   ========================================================= */

function handleTimeEnd() {

  /*
   * DRAW SELESAI
   */

  if (inDraw) {

    inDraw =
      false;


    running =
      false;


    drawRemaining =
      drawDuration;


    if (
      leadersAreTied()
    ) {

      auctionFinished =
        true;


      toast(
        "🤝 Hasil masih seri"
      );

    } else {

      finishAuction();

    }


    render();

    syncAuctionState();

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


    /*
     * Setelah Extra Time,
     * baru cek Draw Time.
     */

    if (
      leadersAreTied()
    ) {

      startDrawTime();

    } else {

      finishAuction();

    }


    return;

  }


  /*
   * WAKTU UTAMA SELESAI
   */

  remaining =
    0;


  /*
   * Extra Time selalu mendapat
   * kesempatan terlebih dahulu.
   */

  if (
    extraTime > 0
  ) {

    startExtraTime();

    return;

  }


  /*
   * Jika tidak ada Extra Time,
   * langsung cek seri.
   */

  if (
    leadersAreTied()
  ) {

    startDrawTime();

    return;

  }


  finishAuction();

}


/* =========================================================
   INTERVAL
   ========================================================= */

function startInterval() {

  stopInterval();


  interval =
    setInterval(
      tick,
      1000
    );

}


function stopInterval() {

  if (interval) {

    clearInterval(
      interval
    );

    interval =
      null;

  }

}


/* =========================================================
   TICK
   ========================================================= */

function tick() {

  if (!running) {
    return;
  }


  /*
   * DRAW
   */

  if (inDraw) {

    if (
      drawRemaining > 0
    ) {

      drawRemaining--;

    }


    if (
      drawRemaining <= 0
    ) {

      drawRemaining =
        0;

      handleTimeEnd();

      return;

    }


    render();

    return;

  }


  /*
   * EXTRA
   */

  if (extraActive) {

    if (
      extraRemaining > 0
    ) {

      extraRemaining--;

    }


    if (
      extraRemaining <= 0
    ) {

      extraRemaining =
        0;

      handleTimeEnd();

      return;

    }


    render();

    return;

  }


  /*
   * MAIN
   */

  if (
    remaining > 0
  ) {

    remaining--;

  }


  if (
    remaining <= 0
  ) {

    remaining =
      0;

    handleTimeEnd();

    return;

  }


  render();

}


/* =========================================================
   SET RUNNING
   ========================================================= */

function setRunning(value) {

  running =
    Boolean(value);


  if (running) {

    startInterval();

  } else {

    stopInterval();

  }


  render();

  syncAuctionState();

}


/* =========================================================
   START AUCTION
   ========================================================= */

function startAuction() {

  /*
   * Kalau sesi sudah selesai,
   * mulai sesi baru.
   */

  if (
    auctionFinished
  ) {

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

  }


  /*
   * Kalau Draw sedang pause,
   * lanjutkan Draw.
   */

  if (
    inDraw
  ) {

    running =
      true;

    startInterval();

    render();

    syncAuctionState();

    toast(
      "▶ Draw Time dilanjutkan"
    );

    return;

  }


  /*
   * Kalau Extra sedang pause,
   * lanjutkan Extra.
   */

  if (
    extraActive
  ) {

    running =
      true;

    startInterval();

    render();

    syncAuctionState();

    toast(
      "▶ Extra Time dilanjutkan"
    );

    return;

  }


  /*
   * Kalau timer kosong dan belum selesai,
   * mulai dari awal.
   */

  if (
    remaining <= 0
  ) {

    remaining =
      duration;

  }


  running =
    true;


  auctionFinished =
    false;


  startInterval();

  render();

  syncAuctionState();


  toast(
    "▶ Dimulai"
  );

}


/* =========================================================
   PAUSE AUCTION
   ========================================================= */

function pauseAuction() {

  if (
    !running
  ) {

    toast(
      "⏸ Sudah dijeda"
    );

    return;

  }


  running =
    false;


  stopInterval();

  render();

  syncAuctionState();


  toast(
    "⏸ Dijeda"
  );

}


/* =========================================================
   RESET AUCTION
   ========================================================= */

function resetAuction() {

  stopInterval();


  running =
    false;


  remaining =
    duration;


  extraRemaining =
    0;


  extraActive =
    false;


  drawRemaining =
    drawDuration;


  inDraw =
    false;


  auctionFinished =
    false;


  /*
   * Peserta tetap dipertahankan?
   *
   * Untuk Reset, kita kosongkan
   * peserta dan activity.
   */

  users = [];

  activities = [];

  liveEventCount = 0;


  render();

  syncAuctionState();


  toast(
    "↻ Di-reset"
  );

}


/* =========================================================
   FINISH BUTTON
   ========================================================= */

function finishButton() {

  finishAuction();

}


/* =========================================================
   SOCKET STATE
   ========================================================= */

function syncAuctionState() {

  if (
    !socket
  ) {

    return;

  }


  socket.emit(
    "auction:state",
    {

      active:
        running ||
        extraActive ||
        inDraw,

      running:
        running,

      remaining:
        remaining,

      duration:
        duration,

      extraTime:
        extraTime,

      extraRemaining:
        extraRemaining,

      extraActive:
        extraActive,

      inDraw:
        inDraw,

      drawRemaining:
        drawRemaining,

      drawDuration:
        drawDuration,

      auctionFinished:
        auctionFinished,

      auctionTitle:
        auctionTitle,

      topLimit:
        topLimit

    }
  );

}


/* =========================================================
   SOCKET CONNECT
   ========================================================= */

function connectSocket() {

  if (
    typeof io !== "function"
  ) {

    console.error(
      "Socket.IO tidak ditemukan."
    );

    toast(
      "Socket.IO tidak ditemukan."
    );

    return;

  }


  socket =
    io({
      transports: [
        "websocket",
        "polling"
      ]
    });


  /*
   * Browser connected ke server
   */

  socket.on(
    "connect",
    () => {

      console.log(
        "Socket connected:",
        socket.id
      );


      if ($("connectionLog")) {

        $("connectionLog").textContent =
          "Status: server terhubung.";

      }

    }
  );


  /*
   * Socket disconnect
   *
   * Tidak otomatis berarti TikTok
   * disconnected.
   */

  socket.on(
    "disconnect",
    () => {

      console.log(
        "Socket disconnected"
      );


      if ($("connectionLog")) {

        $("connectionLog").textContent =
          "Status: koneksi server terputus.";

      }

    }
  );


  /* =======================================================
     LIVE STATUS
     ======================================================= */

  socket.on(
    "live:status",
    (data) => {

      data =
        data || {};


      updateConnectionUI(
        Boolean(
          data.connected
        ),
        data.username ||
        data.uniqueId ||
        connectedUsername,
        data.message ||
        data.status ||
        ""
      );

    }
  );


  /* =======================================================
     PARTICIPANTS
     ======================================================= */

  socket.on(
    "participants",
    (data) => {

      updateUserFromServer(
        data
      );

    }
  );


  socket.on(
    "participants:update",
    (data) => {

      updateUserFromServer(
        data
      );

    }
  );


  socket.on(
    "live:participants",
    (data) => {

      updateUserFromServer(
        data
      );

    }
  );


  /* =======================================================
     USER UPDATE
     ======================================================= */

  socket.on(
    "user:update",
    (data) => {

      updateUserFromServer(
        data
      );

    }
  );


  socket.on(
    "live:user",
    (data) => {

      updateUserFromServer(
        data
      );

    }
  );


  /* =======================================================
     GIFT
     ======================================================= */

  socket.on(
    "live:gift",
    (data) => {

      handleGift(
        data
      );

    }
  );


  /*
   * Server juga bisa mengirim event umum.
   *
   * Anti-double-event mencegah
   * gift dihitung dua kali.
   */

  socket.on(
    "live:event",
    (event) => {

      handleLiveEvent(
        event
      );

    }
  );


  /* =======================================================
     AUCTION STATE FROM SERVER
     ======================================================= */

  socket.on(
    "auction:state",
    (state) => {

      if (!state) {
        return;
      }


      /*
       * Jangan memaksa running dari server
       * jika state kosong.
       */

      if (
        typeof state.remaining ===
        "number"
      ) {

        remaining =
          Math.max(
            0,
            Math.floor(
              state.remaining
            )
          );

      }


      if (
        typeof state.duration ===
        "number" &&
        state.duration > 0
      ) {

        duration =
          Math.floor(
            state.duration
          );

      }


      if (
        typeof state.extraTime ===
        "number"
      ) {

        extraTime =
          Math.max(
            0,
            Math.floor(
              state.extraTime
            )
          );

      }


      if (
        typeof state.extraRemaining ===
        "number"
      ) {

        extraRemaining =
          Math.max(
            0,
            Math.floor(
              state.extraRemaining
            )
          );

      }


      if (
        typeof state.extraActive ===
        "boolean"
      ) {

        extraActive =
          state.extraActive;

      }


      if (
        typeof state.inDraw ===
        "boolean"
      ) {

        inDraw =
          state.inDraw;

      }


      if (
        typeof state.drawRemaining ===
        "number"
      ) {

        drawRemaining =
          Math.max(
            0,
            Math.floor(
              state.drawRemaining
            )
          );

      }


      if (
        typeof state.running ===
        "boolean"
      ) {

        running =
          state.running;

      }


      if (
        typeof state.auctionFinished ===
        "boolean"
      ) {

        auctionFinished =
          state.auctionFinished;

      }


      if (
        state.auctionTitle
      ) {

        auctionTitle =
          String(
            state.auctionTitle
          );

      }


      updateTitleDisplay();

      writeSettingsToInputs();

      render();


      if (running) {

        startInterval();

      } else {

        stopInterval();

      }

    }
  );


  /* =======================================================
     VIEWER / ROOM
     ======================================================= */

  socket.on(
    "live:viewers",
    (data) => {

      if (!data) {
        return;
      }


      const count =
        Number(
          data.viewerCount ??
          data.viewers ??
          data.count ??
          0
        );


      /*
       * Hanya tampilkan jika server
       * memang mengirim viewer count.
       */

      if (
        Number.isFinite(count) &&
        count >= 0
      ) {

        const hero =
          $("heroViewer");


        const label =
          document.querySelector(
            ".hero-stat span"
          );


        if (hero) {

          hero.textContent =
            formatNumber(count);

        }


        if (label) {

          label.textContent =
            "VIEWERS";

        }

      }

    }
  );


}


/* =========================================================
   INPUT BINDING
   ========================================================= */

function bindInputs() {

  const titleInput =
    $("titleInput");


  if (titleInput) {

    titleInput.addEventListener(
      "input",
      () => {

        auctionTitle =
          titleInput.value ||
          "LIVE COIN AUCTION";


        updateTitleDisplay();

      }
    );

  }


  const minuteInput =
    $("minuteInput");


  if (minuteInput) {

    minuteInput.addEventListener(
      "change",
      () => {

        readSettings();

      }
    );

  }


  const secondInput =
    $("secondInput");


  if (secondInput) {

    secondInput.addEventListener(
      "change",
      () => {

        readSettings();

      }
    );

  }


  const extraInput =
    $("extraTimeInput");


  if (extraInput) {

    extraInput.addEventListener(
      "input",
      () => {

        readExtraTime();

        render();

      }
    );

  }


  const topInput =
    $("topInput");


  if (topInput) {

    topInput.addEventListener(
      "change",
      () => {

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


        render();

      }
    );

  }

}


/* =========================================================
   BUTTON BINDING
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


  const saveBtn =
    $("saveSettings");


  if (saveBtn) {

    saveBtn.addEventListener(
      "click",
      saveSettings
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


  const usernameInput =
    $("tiktokUsername");


  if (usernameInput) {

    usernameInput.addEventListener(
      "keydown",
      (event) => {

        if (
          event.key === "Enter"
        ) {

          event.preventDefault();

          connectTikTok();

        }

      }
    );

  }

}


/* =========================================================
   OPTIONAL TEST COIN
   =========================================================
   Bisa dipanggil dari console browser:

   addTestCoin("TestUser", 10)

   Tidak membutuhkan coin TikTok.
   ========================================================= */

function addTestCoin(
  name = "TestUser",
  coins = 10
) {

  const amount =
    Math.max(
      1,
      Math.floor(
        Number(coins) || 10
      )
    );


  const userData = {

    userId:
      "test-" +
      normalizeUserId(name),

    username:
      normalizeUserId(name),

    nickname:
      name,

    name:
      name,

    __test:
      true

  };


  const user =
    upsertUser(
      userData,
      amount
    );


  activities.unshift({

    name:
      user.name,

    avatar:
      "",

    giftName:
      "Test Gift",

    coins:
      amount,

    repeatCount:
      1,

    time:
      Date.now()

  });


  activities =
    activities.slice(
      0,
      20
    );


  liveEventCount++;


  render();


  toast(
    "🧪 Test +" +
    formatNumber(amount) +
    " coin"
  );

}


/* =========================================================
   CLEAR TEST USERS
   ========================================================= */

function clearParticipants() {

  users = [];

  activities = [];

  liveEventCount = 0;

  render();

}


/* =========================================================
   GLOBAL DEBUG
   ========================================================= */

window.addTestCoin =
  addTestCoin;

window.clearParticipants =
  clearParticipants;


/* =========================================================
   INITIALIZE
   ========================================================= */

function init() {

  /*
   * Default settings
   */

  auctionTitle =
    "LIVE COIN AUCTION";


  duration =
    300;


  remaining =
    duration;


  extraTime =
    30;


  extraRemaining =
    0;


  drawDuration =
    20;


  drawRemaining =
    drawDuration;


  running =
    false;


  extraActive =
    false;


  inDraw =
    false;


  auctionFinished =
    false;


  topLimit =
    5;


  writeSettingsToInputs();

  updateConnectionUI(
    false,
    "",
    "Status: Belum terhubung ke TikTok LIVE."
  );


  bindInputs();

  bindButtons();

  connectSocket();

  render();


  console.log(
    "Coin Auction Dashboard V6 siap."
  );

}


/* =========================================================
   START
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
