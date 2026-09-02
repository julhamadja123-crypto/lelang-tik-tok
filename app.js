/* =========================================================
   COIN AUCTION DASHBOARD - FINAL APP.JS
   ========================================================= */

(() => {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function injectMobileAuctionUI() {
    if (document.getElementById("coin-auction-target-ui")) return;

    const style = document.createElement("style");
    style.id = "coin-auction-target-ui";
    style.textContent = `
      /* =====================================================
         TARGET MOBILE UI
         Referensi: dashboard TikTok LIVE Coin Auction
         Tidak mengubah koneksi / gift / coin / timer logic.
         ===================================================== */

      /* Panel peserta */
      #rankingList {
        width: 100% !important;
        box-sizing: border-box !important;
      }

      #rankingList .participant-row {
        display: grid !important;
        grid-template-columns: 52px minmax(0, 1fr) auto !important;
        align-items: center !important;
        gap: 8px !important;
        min-height: 54px !important;
        margin: 4px 0 !important;
        padding: 6px 12px !important;
        border-radius: 10px !important;
        border: 1px solid rgba(255,255,255,.08) !important;
        background: rgba(0,0,0,.16) !important;
        box-shadow: none !important;
        box-sizing: border-box !important;
      }

      #rankingList .participant-row:nth-child(1) {
        border-color: rgba(255,176,0,.72) !important;
        background: rgba(70,45,0,.28) !important;
      }

      #rankingList .participant-row:nth-child(2) {
        border-color: rgba(0,132,255,.58) !important;
        background: rgba(0,45,85,.20) !important;
      }

      #rankingList .participant-row:nth-child(3) {
        border-color: rgba(255,119,35,.58) !important;
        background: rgba(72,30,0,.20) !important;
      }

      #rankingList .participant-avatar,
      #rankingList .participant-username {
        display: none !important;
      }

      #rankingList .participant-rank {
        width: 52px !important;
        min-width: 52px !important;
        text-align: center !important;
        font-size: 28px !important;
        line-height: 1 !important;
        font-weight: 800 !important;
      }

      #rankingList .participant-info {
        min-width: 0 !important;
        display: block !important;
      }

      #rankingList .participant-name {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        font-size: 17px !important;
        font-weight: 700 !important;
        line-height: 1.25 !important;
      }

      #rankingList .participant-coins {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-end !important;
        gap: 5px !important;
        white-space: nowrap !important;
        font-size: 16px !important;
        font-weight: 800 !important;
        min-width: 46px !important;
      }

      #rankingList .coin-icon {
        display: inline-block !important;
      }

      #rankingList .participant-coins::before {
        content: "🪙" !important;
        font-size: 16px !important;
      }

      #rankingList .empty-participants {
        padding: 14px 0 !important;
        font-size: 16px !important;
      }

      /* Hilangkan progress bar */
      #progressBar {
        display: none !important;
      }

      /* Aktivitas tidak diperlukan pada mobile */
      @media (max-width: 700px) {
        #activityList,
        .activity-list,
        .activity-panel {
          display: none !important;
        }

        #rankingList .participant-row {
          grid-template-columns: 52px minmax(0, 1fr) auto !important;
        }

        #rankingList .participant-name {
          font-size: 17px !important;
        }
      }

      /* Kartu Draw Time */
      .coin-target-draw-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 12px 0 16px;
        padding: 12px 14px;
        border: 1px solid rgba(180,70,255,.25);
        border-radius: 10px;
        background: rgba(45,10,65,.16);
        box-sizing: border-box;
      }

      .coin-target-draw-left {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .coin-target-draw-icon {
        font-size: 27px;
        line-height: 1;
      }

      .coin-target-draw-title {
        font-weight: 800;
        font-size: 17px;
        line-height: 1.2;
        color: #c05cff;
      }

      .coin-target-draw-sub {
        margin-top: 4px;
        color: #b9b4c0;
        font-size: 13px;
        line-height: 1.3;
      }

      .coin-target-draw-value {
        flex: 0 0 auto;
        padding: 7px 12px;
        border-radius: 9px;
        background: rgba(112,32,150,.28);
        color: #e2a2ff;
        font-weight: 800;
        font-size: 16px;
      }

    `;
    document.head.appendChild(style);

    document.querySelectorAll("h1,h2,h3,h4,.section-title,.panel-title,.card-title").forEach(node => {
      const t = (node.textContent || "").trim().toUpperCase();
      if (t === "PESERTA LELANG") node.textContent = "PESERTA";
    });
  }

  function injectTargetDrawAndSettingsUI() {
    if (document.getElementById("coin-target-draw-card")) return;

    /* Draw Time: panel visual saja. Logika lelang tetap milik server/app yang ada. */
    const note = document.getElementById("timerNote");
    if (!note) return;

    const draw = document.createElement("div");
    draw.id = "coin-target-draw-card";
    draw.className = "coin-target-draw-card";
    draw.innerHTML = `
      <div class="coin-target-draw-left">
        <div class="coin-target-draw-icon">⌛</div>
        <div>
          <div class="coin-target-draw-title">DRAW TIME</div>
          <div class="coin-target-draw-sub">Jika hasil seri, Draw Time berlangsung 20 detik.</div>
        </div>
      </div>
      <div class="coin-target-draw-value">20 detik</div>
    `;
    const ranking = document.getElementById("rankingList");
    if (ranking) {
      ranking.insertAdjacentElement("afterend", draw);
    } else {
      note.insertAdjacentElement("afterend", draw);
    }
  }
  function init() {

    /* =======================================================
       MOBILE UI PATCH - RINGAN
       Tidak mengubah koneksi TikTok / gift / coin.
       ======================================================= */
    injectMobileAuctionUI();
    injectTargetDrawAndSettingsUI();

    /* =======================================================
       SOCKET.IO
       ======================================================= */

    const socket = window.io ? window.io() : null;

    /* =======================================================
       ELEMENT HTML
       ======================================================= */

    const el = {
      username: document.getElementById("tiktokUsername"),

      connect: document.getElementById("connectBtn"),
      disconnect: document.getElementById("disconnectBtn"),

      start: document.getElementById("startBtn"),
      pause: document.getElementById("pauseBtn"),
      reset: document.getElementById("resetBtn"),
      finish: document.getElementById("finishBtn"),

      timer: document.getElementById("timer"),
      progress: document.getElementById("progressBar"),

      titleInput: document.getElementById("titleInput"),
      titleDisplay: document.getElementById("auctionTitleDisplay"),

      minuteInput: document.getElementById("minuteInput"),
      secondInput: document.getElementById("secondInput"),
      extraInput: document.getElementById("extraTimeInput"),
      topInput: document.getElementById("topInput"),

      save: document.getElementById("saveSettings"),

      participantCount: document.getElementById("participantCount"),
      rankingList: document.getElementById("rankingList"),

      connectionLog: document.getElementById("connectionLog"),
      statusBadge: document.getElementById("statusBadge"),

      activityList: document.getElementById("activityList"),
      extraStatus: document.getElementById("extraTimeStatus"),

      timerNote: document.getElementById("timerNote"),
      toast: document.getElementById("toast")
    };

    /* =======================================================
       STATE
       ======================================================= */

    const state = {
      auction: "idle",

      participants: new Map(),

      timer: 0,
      initialTimer: 300,

      extraTime: 0,
      extraUsed: false,

      top: 5,

      version: 0,

      timerInterval: null,
      timerDeadline: null,
      lastTimerPaint: null,

      connected: false,
      connecting: false
    };

    const STORAGE_KEY =
      "coinAuctionSettingsVFinal";

    /* =======================================================
       HELPERS
       ======================================================= */

    function num(value, fallback = 0) {

      const n = Number(value);

      return Number.isFinite(n)
        ? n
        : fallback;
    }

    function clampInt(value, min, max) {

      return Math.max(
        min,
        Math.min(
          max,
          Math.floor(
            num(value, min)
          )
        )
      );
    }

    function escapeHtml(value) {

      return String(value ?? "").replace(
        /[&<>"']/g,
        char => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[char])
      );
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    /* =======================================================
       SETTINGS
       ======================================================= */

    function getTitle() {

      return (
        String(
          el.titleInput?.value ||
          "LIVE COIN AUCTION"
        )
          .trim()
          .slice(0, 140)
      ) || "LIVE COIN AUCTION";
    }

    function getMinutes() {

      return clampInt(
        el.minuteInput?.value ?? 5,
        0,
        120
      );
    }

    function getSeconds() {

      return clampInt(
        el.secondInput?.value ?? 0,
        0,
        59
      );
    }

    function getMainTime() {

      return Math.max(
        0,
        getMinutes() * 60 +
        getSeconds()
      );
    }

    function getExtraTime() {

      return clampInt(
        el.extraInput?.value ?? 0,
        0,
        3600
      );
    }

    function getTop() {

      return clampInt(
        el.topInput?.value ?? 5,
        1,
        100
      );
    }

    function loadSettings() {

      try {

        const raw =
          localStorage.getItem(
            STORAGE_KEY
          );

        if (!raw) return;

        const saved =
          JSON.parse(raw);

        if (!saved) return;

        if (
          el.titleInput &&
          typeof saved.title === "string"
        ) {
          el.titleInput.value =
            saved.title;
        }

        if (
          el.minuteInput &&
          saved.minutes !== undefined
        ) {
          el.minuteInput.value =
            clampInt(
              saved.minutes,
              0,
              120
            );
        }

        if (
          el.secondInput &&
          saved.seconds !== undefined
        ) {
          el.secondInput.value =
            clampInt(
              saved.seconds,
              0,
              59
            );
        }

        if (
          el.extraInput &&
          saved.extra !== undefined
        ) {
          el.extraInput.value =
            clampInt(
              saved.extra,
              0,
              3600
            );
        }

        if (
          el.topInput &&
          saved.top !== undefined
        ) {

          const top =
            clampInt(
              saved.top,
              1,
              100
            );

          const optionExists =
            [...el.topInput.options]
              .some(
                option =>
                  Number(option.value) === top
              );

          if (optionExists) {
            el.topInput.value =
              String(top);
          }
        }

      } catch (error) {

        console.warn(
          "[Settings] Gagal membaca settings:",
          error
        );
      }
    }

    function saveSettings() {

      const settings = {
        title: getTitle(),
        minutes: getMinutes(),
        seconds: getSeconds(),
        extra: getExtraTime(),
        top: getTop()
      };

      try {

        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(settings)
        );

      } catch (error) {

        console.warn(
          "[Settings] Gagal menyimpan:",
          error
        );
      }

      state.initialTimer =
        getMainTime();

      state.extraTime =
        getExtraTime();

      state.top =
        getTop();

      if (
        state.auction === "idle" ||
        state.auction === "finished"
      ) {

        state.timer =
          state.initialTimer;

        state.timerDeadline = null;
        state.lastTimerPaint = null;

        state.extraUsed =
          false;

        removeExtraTimeColor();

        renderTimer();
      }

      if (el.titleDisplay) {

        el.titleDisplay.textContent =
          settings.title ||
          "LIVE COIN AUCTION";
      }

      renderParticipants();

      updateProgress();

      showToast(
        "Pengaturan berhasil disimpan"
      );
    }

    /* =======================================================
       TIMER
       ======================================================= */

    function formatTime(total) {

      total =
        Math.max(
          0,
          Math.floor(total)
        );

      const hours =
        Math.floor(
          total / 3600
        );

      const minutes =
        Math.floor(
          (total % 3600) / 60
        );

      const seconds =
        total % 60;

      if (hours > 0) {

        return (
          String(hours)
            .padStart(2, "0") +
          ":" +
          String(minutes)
            .padStart(2, "0") +
          ":" +
          String(seconds)
            .padStart(2, "0")
        );
      }

      return (
        String(minutes)
          .padStart(2, "0") +
        ":" +
        String(seconds)
          .padStart(2, "0")
      );
    }

    /* =======================================================
       EXTRA TIME COLOR
       ======================================================= */

    function applyExtraTimeColor() {

      if (!el.timer) return;

      const active =
        state.extraUsed === true &&
        state.extraTime > 0 &&
        state.auction === "running";

      el.timer.classList.toggle(
        "extra-time-active",
        active
      );
    }

    function removeExtraTimeColor() {

      if (!el.timer) return;

      el.timer.classList.remove(
        "extra-time-active"
      );
    }

    function renderTimer() {

      if (el.timer) {

        el.timer.textContent =
          formatTime(
            state.timer
          );

        applyExtraTimeColor();
      }

      updateProgress();
    }

    function updateProgress() {

      if (!el.progress) return;

      const total =
        Math.max(
          1,
          state.initialTimer
        );

      const percent =
        Math.max(
          0,
          Math.min(
            100,
            state.timer /
            total *
            100
          )
        );

      el.progress.style.width =
        `${percent}%`;
    }

    function syncTimerNow(forceRender = false) {

      if (state.auction !== "running" || !state.timerDeadline) {
        return state.timer;
      }

      const remainingMs = Math.max(0, state.timerDeadline - Date.now());
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

      if (forceRender || remaining !== state.timer || state.lastTimerPaint !== remaining) {
        state.timer = remaining;
        state.lastTimerPaint = remaining;
        renderTimer();
      }

      return remaining;
    }

    function stopTimer() {

      if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
      }
    }

    function startTimer() {

      stopTimer();

      if (state.auction !== "running") {
        return;
      }

      // Gunakan deadline absolut agar countdown tidak melambat/jeda
      // ketika browser HP menunda callback JavaScript.
      state.timerDeadline = Date.now() + Math.max(0, state.timer) * 1000;
      state.lastTimerPaint = null;
      syncTimerNow(true);
      applyExtraTimeColor();

      state.timerInterval = setInterval(() => {
        if (state.auction !== "running") {
          return;
        }

        const remaining = syncTimerNow(false);

        if (remaining <= 0) {
          // Pastikan layar selalu 00:00 SEBELUM status FINISHED.
          state.timer = 0;
          state.lastTimerPaint = 0;
          renderTimer();
          stopTimer();
          timerFinished();
        }
      }, 100);
    }

    /* =====================================================
       MOBILE / BACKGROUND TIMER SYNC
       Saat browser HP menunda JavaScript, jangan membuat
       countdown kembali dari angka lama. Begitu halaman aktif
       lagi, langsung hitung dari deadline absolut.
       ===================================================== */
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (state.auction === "running" && state.timerDeadline) {
          syncTimerNow(true);
        }
      }
    });

    function timerFinished() {

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      /* =====================================================
         EXTRA TIME AKTIF
         ===================================================== */

      if (
        !state.extraUsed &&
        state.extraTime > 0
      ) {

        state.extraUsed =
          true;

        state.timer =
          state.extraTime;

        state.timerDeadline =
          Date.now() + state.extraTime * 1000;
        state.lastTimerPaint = null;

        if (el.extraStatus) {

          el.extraStatus.textContent =
            `Extra Time aktif: ${formatTime(
              state.extraTime
            )}`;
        }

        /*
         * LANGSUNG UBAH TIMER MENJADI MERAH
         */

        if (el.timer) {

          el.timer.classList.add(
            "extra-time-active"
          );
        }

        renderTimer();

        showToast(
          "Extra Time dimulai"
        );

        return;
      }

      /* =====================================================
         WAKTU BENAR-BENAR HABIS
         ===================================================== */

      finishAuction(true);
    }

    /* =======================================================
       AUCTION STATE
       ======================================================= */

    function sendAuctionState(next) {

      if (!socket) return;

      socket.emit(
        "auction:state",
        {
          state: next
        }
      );
    }

    function startAuction() {

      if (
        state.auction ===
        "running"
      ) {
        return;
      }

      state.initialTimer =
        getMainTime();

      state.extraTime =
        getExtraTime();

      state.top =
        getTop();

      /*
       * PAUSE -> LANJUT
       */

      if (
        state.auction ===
        "paused" &&
        state.timer > 0
      ) {

        /* Pertahankan timer */
      }

      /*
       * IDLE / FINISHED -> TIMER BARU
       */

      else {

        state.timer =
          state.initialTimer;

        state.timerDeadline = null;
        state.lastTimerPaint = null;

        state.extraUsed =
          false;

        removeExtraTimeColor();

        if (el.extraStatus) {

          el.extraStatus.textContent =
            "";
        }
      }

      if (
        state.timer <= 0
      ) {

        showToast(
          "Atur waktu lelang terlebih dahulu"
        );

        return;
      }

      state.auction =
        "running";

      renderTimer();

      setAuctionUI(
        "running"
      );

      updateButtons();

      startTimer();

      sendAuctionState(
        "running"
      );
    }

    function pauseAuction() {

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      syncTimerNow(true);
      stopTimer();
      state.timerDeadline = null;

      state.auction =
        "paused";

      /*
       * Saat pause, warna Extra Time
       * tetap merah jika memang sedang
       * berada di Extra Time.
       */

      applyExtraTimeColor();

      setAuctionUI(
        "paused"
      );

      updateButtons();

      sendAuctionState(
        "paused"
      );
    }

    function resetAuction() {

      stopTimer();

      state.auction =
        "idle";

      state.initialTimer =
        getMainTime();

      state.extraTime =
        getExtraTime();

      state.top =
        getTop();

      state.extraUsed =
        false;

      state.timer =
        state.initialTimer;

      state.timerDeadline = null;
      state.lastTimerPaint = null;

      /*
       * HAPUS WARNA MERAH
       */

      removeExtraTimeColor();

      /*
       * HAPUS SEMUA PESERTA
       */

      state.participants.clear();

      if (el.extraStatus) {

        el.extraStatus.textContent =
          "";
      }

      renderTimer();

      renderParticipants();

      clearActivity();

      setAuctionUI(
        "idle"
      );

      updateButtons();

      if (socket) {

        socket.emit(
          "auction:reset"
        );
      }

      showToast(
        "Lelang di-reset"
      );
    }

    function finishAuction(
      fromTimer = false
    ) {

      if (
        state.auction ===
          "idle" ||
        state.auction ===
          "finished"
      ) {
        return;
      }

      if (fromTimer) {
        state.timer = 0;
        state.lastTimerPaint = 0;
        renderTimer();
      }

      stopTimer();
      state.timerDeadline = null;

      state.auction =
        "finished";

      /*
       * FINISH TIDAK MENGHAPUS PESERTA
       */

      /*
       * HILANGKAN WARNA EXTRA TIME
       * KARENA LELANG SUDAH SELESAI
       */

      removeExtraTimeColor();

      setAuctionUI(
        "finished"
      );

      updateButtons();

      if (socket) {

        socket.emit(
          "auction:state",
          {
            state: "finished"
          }
        );
      }

      if (fromTimer) {

        showToast(
          "Waktu habis — lelang selesai"
        );

      } else {

        showToast(
          "Lelang selesai"
        );
      }
    }

    /* =======================================================
       BUTTON STATE
       ======================================================= */

    function updateButtons() {

      if (el.connect) {

        el.connect.disabled =
          state.connecting;
      }

      if (el.disconnect) {

        el.disconnect.disabled =
          !state.connected;
      }

      if (el.start) {

        el.start.disabled =
          state.auction ===
          "running";
      }

      if (el.pause) {

        el.pause.disabled =
          state.auction !==
          "running";
      }

      if (el.reset) {

        el.reset.disabled =
          false;
      }

      if (el.finish) {

        el.finish.disabled =
          state.auction ===
            "idle" ||
          state.auction ===
            "finished";
      }

      if (el.save) {

        el.save.disabled =
          false;
      }
    }

    /* =======================================================
       AUCTION UI
       ======================================================= */

    function setAuctionUI(next) {

      const labels = {

        idle:
          "Siap untuk memulai",

        running:
          "Lelang sedang berjalan",

        paused:
          "Lelang dijeda",

        finished:
          "FINISHED"
      };

      if (el.timerNote) {

        el.timerNote.textContent =
          labels[next] || "";
      }

      if (el.statusBadge) {

        el.statusBadge.dataset.auctionState =
          next;
      }
    }

    /* =======================================================
       TOAST
       ======================================================= */

    function showToast(message) {

      if (!el.toast) {

        console.log(
          "[Toast]",
          message
        );

        return;
      }

      el.toast.textContent =
        String(message || "");

      el.toast.classList.add(
        "show"
      );

      clearTimeout(
        showToast.timer
      );

      showToast.timer =
        setTimeout(() => {

          el.toast.classList.remove(
            "show"
          );

        }, 1800);
    }

    /* =======================================================
       PARTICIPANT KEY
       ======================================================= */

    function participantKey(p) {

      return String(
        p?.userId ||
        p?.username ||
        p?.uniqueId ||
        p?.nickname ||
        "unknown"
      );
    }

    /* =======================================================
       AVATAR
       ======================================================= */

    function avatarHtml(p) {

      const name =
        String(
          p?.nickname ||
          p?.username ||
          "V"
        );

      const first =
        escapeHtml(
          name
            .charAt(0)
            .toUpperCase()
        );

      if (p?.avatar) {

        return `
          <img
            class="participant-avatar"
            src="${escapeAttr(p.avatar)}"
            alt=""
            loading="lazy"
            onerror="
              this.style.display='none';
              this.nextElementSibling.style.display='flex';
            "
          >

          <div
            class="participant-avatar participant-initial"
            style="display:none"
          >
            ${first}
          </div>
        `;
      }

      return `
        <div
          class="participant-avatar participant-initial"
        >
          ${first}
        </div>
      `;
    }

    /* =======================================================
       RENDER PESERTA
       ======================================================= */

    function renderParticipants() {

      const list =
        Array.from(
          state.participants.values()
        )
        .sort((a, b) => {

          const coinDiff =
            num(b.coins) -
            num(a.coins);

          if (
            coinDiff !== 0
          ) {
            return coinDiff;
          }

          return (
            num(a.joinedAt) -
            num(b.joinedAt)
          );
        });

      if (el.participantCount) {

        el.participantCount.textContent =
          `${list.length} peserta`;
      }

      if (!el.rankingList) {
        return;
      }

      if (!list.length) {

        el.rankingList.innerHTML = `
          <div class="empty-participants">
            Menunggu peserta
          </div>
        `;

        return;
      }

      const visible =
        list.slice(
          0,
          state.top
        );

      el.rankingList.innerHTML =
        visible.map(
          (p, index) => {

            const nickname =
              escapeHtml(
                p.nickname ||
                p.username ||
                "Viewer"
              );

            const coins =
              num(
                p.coins,
                0
              );

            const medal =
              index === 0 ? "🥇" :
              index === 1 ? "🥈" :
              index === 2 ? "🥉" :
              String(index + 1);

            return `
              <div
                class="participant-row rank-card rank-box"
                data-user-id="${escapeAttr(
                  participantKey(p)
                )}"
              >

                <div
                  class="participant-rank rank-number rank-no"
                  aria-label="Peringkat ${index + 1}"
                >
                  ${medal}
                </div>

                <div
                  class="participant-info rank-info"
                >
                  <div
                    class="participant-name"
                  >
                    ${nickname}
                  </div>
                </div>

                <div
                  class="participant-coins coin"
                  aria-label="${coins} coin"
                >
                  <strong>${coins}</strong>
                </div>

              </div>
            `;
          }
        ).join("");
    }

    /* =======================================================
       ACTIVITY
       ======================================================= */

    function addActivity(gift) {

      if (
        !el.activityList ||
        !gift
      ) {
        return;
      }

      const empty =
        el.activityList.querySelector(
          ".empty"
        );

      if (empty) {
        empty.remove();
      }

      const item =
        document.createElement(
          "div"
        );

      item.className =
        "activity";

      const username =
        gift.nickname ||
        gift.username ||
        "Viewer";

      const giftName =
        gift.giftName ||
        "Gift";

      const coins =
        num(
          gift.coinValue,
          0
        );

      item.innerHTML = `
        <div class="activity-avatar">
          ${
            gift.avatar
              ? `
                <img
                  src="${escapeAttr(gift.avatar)}"
                  alt=""
                  loading="lazy"
                >
              `
              : "🧑"
          }
        </div>

        <div>
          <strong>
            ${escapeHtml(username)}
          </strong>

          <span>
            ${escapeHtml(giftName)}
          </span>
        </div>

        <div class="event-coin">
          +${coins} 🪙
        </div>
      `;

      el.activityList.prepend(
        item
      );

      while (
        el.activityList.children
          .length > 10
      ) {

        el.activityList
          .lastElementChild
          .remove();
      }
    }

    function clearActivity() {

      if (!el.activityList) {
        return;
      }

      el.activityList.innerHTML = `
        <p class="empty">
          Belum ada gift masuk.
        </p>
      `;
    }

    /* =======================================================
       TIKTOK USERNAME
       ======================================================= */

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
          ""
        );
    }

    /* =======================================================
       CONNECT TIKTOK
       ======================================================= */

    function connectTikTok() {

      if (!socket) {

        showToast(
          "Socket.IO tidak tersedia"
        );

        return;
      }

      const username =
        cleanUsername(
          el.username?.value
        );

      if (!username) {

        showToast(
          "Masukkan username TikTok"
        );

        el.username?.focus();

        return;
      }

      state.connecting =
        true;

      updateButtons();

      setConnectionText(
        `Menghubungkan ke @${username}...`,
        false
      );

      socket.emit(
        "live:connect",
        {
          username
        }
      );
    }

    /* =======================================================
       DISCONNECT
       ======================================================= */

    function disconnectTikTok() {

      if (!socket) {
        return;
      }

      socket.emit(
        "live:disconnect"
      );

      state.connected =
        false;

      state.connecting =
        false;

      setConnectionText(
        "Koneksi TikTok LIVE diputus.",
        false
      );

      updateButtons();
    }

    /* =======================================================
       CONNECTION STATUS
       ======================================================= */

    function setConnectionText(
      message,
      ok = false
    ) {

      if (el.connectionLog) {

        el.connectionLog.textContent =
          `Status: ${
            message ||
            "belum terhubung"
          }`;
      }

      if (el.statusBadge) {

        el.statusBadge.textContent =
          ok
            ? "TERHUBUNG"
            : "OFFLINE";

        el.statusBadge.classList.toggle(
          "online",
          !!ok
        );

        el.statusBadge.classList.toggle(
          "connected",
          !!ok
        );
      }
    }

    /* =======================================================
       SOCKET
       ======================================================= */

    if (!socket) {

      console.error(
        "[Auction] Socket.IO tidak ditemukan."
      );

      showToast(
        "Socket.IO tidak ditemukan"
      );

      updateButtons();

      return;
    }

    socket.on(
      "connect",
      () => {

        console.log(
          "[Socket] Terhubung:",
          socket.id
        );

        state.connecting =
          false;

        updateButtons();
      }
    );

    socket.on(
      "disconnect",
      () => {

        console.warn(
          "[Socket] Terputus"
        );

        state.connected =
          false;

        state.connecting =
          false;

        setConnectionText(
          "Koneksi server terputus.",
          false
        );

        updateButtons();
      }
    );

    socket.on(
      "connect_error",
      error => {

        console.error(
          "[Socket] Error:",
          error
        );

        state.connected =
          false;

        state.connecting =
          false;

        setConnectionText(
          "Gagal terhubung ke server.",
          false
        );

        updateButtons();
      }
    );

    /* =======================================================
       TIKTOK STATUS
       ======================================================= */

    socket.on(
      "live:status",
      data => {

        const message =
          String(
            data?.message ||
            "Status TikTok tidak diketahui"
          );

        const ok =
          !!data?.ok;

        state.connected =
          ok;

        state.connecting =
          false;

        setConnectionText(
          message,
          ok
        );

        updateButtons();

        console.log(
          "[TikTok]",
          message
        );
      }
    );

    socket.on(
      "live:error",
      data => {

        const message =
          String(
            data?.message ||
            "Gagal menghubungkan TikTok LIVE."
          );

        state.connected =
          false;

        state.connecting =
          false;

        setConnectionText(
          message,
          false
        );

        updateButtons();

        showToast(
          message
        );

        console.error(
          "[TikTok]",
          message
        );
      }
    );

    /* =======================================================
       AUCTION STATE
       ======================================================= */

    socket.on(
      "auction:state",
      data => {

        const next =
          data?.state ||
          (
            data?.active
              ? "running"
              : "idle"
          );

        const incomingVersion =
          Number(
            data?.version
          );

        if (
          Number.isFinite(
            incomingVersion
          ) &&
          incomingVersion <
            state.version
        ) {
          return;
        }

        if (
          Number.isFinite(
            incomingVersion
          )
        ) {

          state.version =
            incomingVersion;
        }

        if (
          ![
            "idle",
            "running",
            "paused",
            "finished"
          ].includes(next)
        ) {
          return;
        }

        const previous =
          state.auction;

        state.auction =
          next;

        if (next === "finished") {
          state.timer = 0;
          state.lastTimerPaint = 0;
          state.timerDeadline = null;
          renderTimer();
        }

        if (
          next === "running"
        ) {

          if (
            previous !== "running" &&
            state.timer <= 0
          ) {

            state.initialTimer =
              getMainTime();

            state.timer =
              state.initialTimer;

            state.extraTime =
              getExtraTime();

            state.extraUsed =
              false;

            removeExtraTimeColor();
          }

          /*
           * PENTING: jangan restart deadline setiap kali
           * server mengirim auction:state.
           * Server biasanya mengirim update berkala dengan
           * nilai remaining yang sudah dibulatkan. Jika deadline
           * dibuat ulang pada setiap update, countdown di HP bisa
           * terlihat macet/jeda. Deadline lokal hanya dibuat saat
           * benar-benar masuk ke status running atau deadline belum ada.
           */
          if (
            previous !== "running" ||
            !state.timerDeadline
          ) {
            startTimer();
          } else {
            syncTimerNow(true);
          }

        } else {

          stopTimer();
          state.timerDeadline = null;

          /*
           * FINISH / IDLE
           * HILANGKAN WARNA MERAH
           */

          if (
            next === "idle" ||
            next === "finished"
          ) {

            removeExtraTimeColor();
          }
        }

        setAuctionUI(
          next
        );

        renderTimer();

        updateButtons();
      }
    );

    /* =======================================================
       PARTICIPANTS
       ======================================================= */

    socket.on(
      "auction:participants",
      data => {

        const incomingVersion =
          Number(
            data?.version
          );

        if (
          Number.isFinite(
            incomingVersion
          ) &&
          incomingVersion <
            state.version
        ) {
          return;
        }

        if (
          Number.isFinite(
            incomingVersion
          )
        ) {

          state.version =
            incomingVersion;
        }

        state.participants.clear();

        const participants =
          Array.isArray(
            data?.participants
          )
            ? data.participants
            : [];

        for (
          const participant
          of participants
        ) {

          state.participants.set(
            participantKey(
              participant
            ),
            participant
          );
        }

        renderParticipants();
      }
    );

    /* =======================================================
       GIFT
       ======================================================= */

    socket.on(
      "live:gift",
      gift => {

        if (
          !gift?.participant
        ) {
          return;
        }

        const participant =
          gift.participant;

        state.participants.set(
          participantKey(
            participant
          ),
          participant
        );

        renderParticipants();

        /*
         * Tidak ada popup gift.
         */

        addActivity(
          gift
        );

        console.log(
          `[GIFT] ${
            gift.username ||
            "Viewer"
          } +${
            gift.coinValue ||
            0
          } coin`
        );
      }
    );

    /* =======================================================
       LIVE EVENT
       ======================================================= */

    socket.on(
      "live:event",
      event => {

        if (
          event?.type ===
          "chat"
        ) {

          console.log(
            `[TikTok] Chat @${
              event.username ||
              "Viewer"
            }`
          );
        }
      }
    );

    /* =======================================================
       BUTTON DELEGATION
       ======================================================= */

    document.addEventListener(
      "click",
      event => {

        const button =
          event.target?.closest?.(
            "button"
          );

        if (!button) {
          return;
        }

        switch (button.id) {

          case "connectBtn":

            event.preventDefault();

            connectTikTok();

            break;

          case "disconnectBtn":

            event.preventDefault();

            disconnectTikTok();

            break;

          case "startBtn":

            event.preventDefault();

            startAuction();

            break;

          case "pauseBtn":

            event.preventDefault();

            pauseAuction();

            break;

          case "resetBtn":

            event.preventDefault();

            resetAuction();

            break;

          case "finishBtn":

            event.preventDefault();

            finishAuction(false);

            break;

          case "saveSettings":

            event.preventDefault();

            saveSettings();

            break;
        }
      }
    );

    /* =======================================================
       INPUT SETTINGS
       ======================================================= */

    [
      el.minuteInput,
      el.secondInput,
      el.extraInput,
      el.topInput
    ]
      .filter(Boolean)
      .forEach(input => {

        input.addEventListener(
          "change",
          () => {

            state.initialTimer =
              getMainTime();

            state.extraTime =
              getExtraTime();

            state.top =
              getTop();

            if (
              state.auction ===
                "idle" ||
              state.auction ===
                "finished"
            ) {

              state.timer =
                state.initialTimer;

              state.timerDeadline = null;
              state.lastTimerPaint = null;

              state.extraUsed =
                false;

              removeExtraTimeColor();

              renderTimer();
            }

            renderParticipants();
          }
        );
      });

    /* =======================================================
       TITLE INPUT
       ======================================================= */

    if (el.titleInput) {

      el.titleInput.addEventListener(
        "input",
        () => {

          if (el.titleDisplay) {

            el.titleDisplay.textContent =
              getTitle();
          }
        }
      );
    }

    /* =======================================================
       ENTER USERNAME
       ======================================================= */

    if (el.username) {

      el.username.addEventListener(
        "keydown",
        event => {

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

    /* =======================================================
       INITIAL STATE
       ======================================================= */

    loadSettings();

    state.initialTimer =
      getMainTime();

    state.timer =
      state.initialTimer;

    state.timerDeadline = null;
    state.lastTimerPaint = null;

    state.extraTime =
      getExtraTime();

    state.top =
      getTop();

    state.extraUsed =
      false;

    removeExtraTimeColor();

    if (el.titleDisplay) {

      el.titleDisplay.textContent =
        getTitle();
    }

    renderTimer();

    renderParticipants();

    clearActivity();

    setAuctionUI(
      "idle"
    );

    setConnectionText(
      "Belum terhubung ke TikTok LIVE.",
      false
    );

    updateButtons();

    console.log(
      "[Auction] app.js FINAL berhasil dimuat."
    );

    /* =======================================================
       COMPATIBILITY API
       ======================================================= */

    window.coinAuction = {

      socket,

      start:
        startAuction,

      pause:
        pauseAuction,

      reset:
        resetAuction,

      finish:
        finishAuction,

      connect:
        connectTikTok,

      disconnect:
        disconnectTikTok,

      saveSettings:
        saveSettings,

      getState() {

        return {

          auction:
            state.auction,

          timer:
            state.timer,

          initialTimer:
            state.initialTimer,

          extraTime:
            state.extraTime,

          extraUsed:
            state.extraUsed,

          version:
            state.version,

          connected:
            state.connected,

          participants:
            Array.from(
              state.participants.values()
            )
        };
      }
    };
  }

})();
