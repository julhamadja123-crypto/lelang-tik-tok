/* =========================================================
   COIN AUCTION DASHBOARD - FINAL APP.JS
   ========================================================= */

(() => {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function injectMobileAuctionUI() {
    if (document.getElementById("coin-auction-mobile-ui")) return;

    const style = document.createElement("style");
    style.id = "coin-auction-mobile-ui";
    style.textContent = `
      /* Tampilan peserta mobile: hanya ranking + nama + coin */
      #rankingList .participant-row {
        display: grid !important;
        grid-template-columns: 58px minmax(0, 1fr) auto !important;
        align-items: center !important;
        gap: 10px !important;
        min-height: 52px !important;
        padding: 8px 4px !important;
        border: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }

      #rankingList .participant-avatar,
      #rankingList .participant-username {
        display: none !important;
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
        line-height: 1.2 !important;
      }

      #rankingList .participant-rank {
        width: 58px !important;
        min-width: 58px !important;
        text-align: left !important;
        font-size: 23px !important;
        font-weight: 800 !important;
      }

      #rankingList .participant-coins {
        white-space: nowrap !important;
        font-size: 16px !important;
        font-weight: 800 !important;
      }

      #rankingList .coin-icon {
        display: none !important;
      }

      /* Jangan tampilkan progress bar yang berat/menyita ruang */
      #progressBar {
        display: none !important;
      }

      /* Sembunyikan panel aktivitas pada layar HP agar fokus ke peserta */
      @media (max-width: 700px) {
        #activityList,
        .activity-list,
        .activity-panel {
          display: none !important;
        }

        #rankingList {
          width: 100% !important;
        }

        #rankingList .participant-row {
          grid-template-columns: 58px minmax(0, 1fr) auto !important;
        }
      }
    `;
    document.head.appendChild(style);

    // Pastikan heading tidak kembali menjadi "PESERTA LELANG".
    document.querySelectorAll("h1,h2,h3,h4,.section-title,.panel-title,.card-title").forEach(node => {
      if ((node.textContent || "").trim().toUpperCase() === "PESERTA LELANG") {
        node.textContent = "PESERTA";
      }
    });
  }

  function init() {

    /* =======================================================
       MOBILE UI PATCH - RINGAN
       Tidak mengubah koneksi TikTok / gift / coin.
       ======================================================= */
    injectMobileAuctionUI();

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

      drawTimeInput: document.getElementById("drawTimeInput"),
      drawCustomInput: document.getElementById("drawCustomInput"),
      drawCustomWrap: document.getElementById("drawCustomWrap"),
      drawTimeDisplay: document.getElementById("drawTimeDisplay"),

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

      drawTime: 20,
      drawActive: false,
      drawDeadline: null,

      top: 5,

      version: 0,

      timerInterval: null,

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

    function getDrawTime() {

      const mode =
        String(el.drawTimeInput?.value || "20");

      if (mode === "custom") {
        return clampInt(
          el.drawCustomInput?.value ?? 20,
          1,
          3600
        );
      }

      return clampInt(mode, 1, 3600);
    }

    function updateDrawTimeSettingsUI() {

      const custom =
        String(el.drawTimeInput?.value || "20") === "custom";

      if (el.drawCustomWrap) {
        el.drawCustomWrap.style.display =
          custom ? "flex" : "none";
      }

      state.drawTime = getDrawTime();

      if (el.drawTimeDisplay) {
        el.drawTimeDisplay.textContent =
          `${state.drawTime} DETIK`;
      }
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

        if (el.drawTimeInput) {
          const savedDraw = clampInt(
            saved.drawTime ?? 20,
            1,
            3600
          );
          const standard = [10, 20, 30];
          if (standard.includes(savedDraw)) {
            el.drawTimeInput.value = String(savedDraw);
          } else {
            el.drawTimeInput.value = "custom";
            if (el.drawCustomInput) {
              el.drawCustomInput.value = String(savedDraw);
            }
          }
          updateDrawTimeSettingsUI();
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
        top: getTop(),
        drawTime: getDrawTime()
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

      state.drawTime =
        getDrawTime();

      updateDrawTimeSettingsUI();

      if (
        state.auction === "idle" ||
        state.auction === "finished"
      ) {

        state.timer =
          state.initialTimer;

        state.timerDeadline =
          null;

        state.extraUsed =
          false;

        state.drawActive = false;
        state.drawDeadline = null;
        state.drawTime = getDrawTime();

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

        const isFinished =
          state.auction === "finished";

        el.timer.textContent =
          isFinished
            ? "00:00"
            : formatTime(state.timer);

        el.timer.classList.toggle(
          "finished-timer",
          isFinished
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

    function stopTimer() {

      if (state.timerInterval) {

        clearInterval(
          state.timerInterval
        );

        state.timerInterval =
          null;
      }
    }

    function startTimer() {

      stopTimer();

      if (state.auction !== "running") {
        return;
      }

      /*
       * Jangan pernah membuat deadline baru hanya karena
       * startTimer() dipanggil ulang. Deadline hanya dibuat
       * saat timer benar-benar mulai / resume.
       */
      if (!Number.isFinite(state.timerDeadline) || state.timerDeadline <= 0) {
        if (state.timer <= 0) {
          timerFinished();
          return;
        }

        state.timerDeadline =
          Date.now() + Math.max(0, state.timer) * 1000;
      }

      applyExtraTimeColor();

      const tick = () => {

        if (state.auction !== "running") {
          return;
        }

        if (!Number.isFinite(state.timerDeadline)) {
          stopTimer();
          return;
        }

        const remainingMs =
          state.timerDeadline - Date.now();

        /*
         * Jangan render 00:00 sebelum keputusan akhir dibuat.
         * Ini mencegah kedipan 00:00 dan lompatan palsu.
         */
        if (remainingMs <= 0) {
          stopTimer();
          state.timer = 0;
          timerFinished();
          return;
        }

        const remaining = Math.max(
          1,
          Math.ceil(remainingMs / 1000)
        );

        if (remaining !== state.timer) {
          state.timer = remaining;
          renderTimer();
        }
      };

      tick();

      if (state.auction === "running") {
        state.timerInterval = setInterval(tick, 100);
      }
    }

    function getTopTwoParticipants() {

      return Array.from(state.participants.values())
        .sort((a, b) => {
          const coinDiff = num(b.coins) - num(a.coins);
          if (coinDiff !== 0) return coinDiff;
          return num(a.joinedAt) - num(b.joinedAt);
        })
        .slice(0, 2);
    }

    function isTopTwoTied() {

      const topTwo = getTopTwoParticipants();

      return (
        topTwo.length >= 2 &&
        num(topTwo[0].coins, 0) === num(topTwo[1].coins, 0)
      );
    }

    function resumeDrawTime() {

      if (state.auction !== "running" || !state.drawActive || state.timer <= 0) {
        return;
      }

      state.drawDeadline = Date.now() + state.timer * 1000;

      if (el.timer) {
        el.timer.classList.remove("extra-time-active");
        el.timer.classList.add("draw-time-active");
      }

      if (el.timerNote) {
        el.timerNote.textContent =
          "DRAW TIME — Coin peringkat 1 & 2 sama";
      }

      stopTimer();

      const tick = () => {
        if (state.auction !== "running" || !state.drawActive) return;

        const remainingMs = state.drawDeadline - Date.now();
        if (remainingMs <= 0) {
          stopTimer();
          state.timer = 0;
          state.drawActive = false;
          state.drawDeadline = null;
          if (el.timer) el.timer.classList.remove("draw-time-active");
          finishAuction(true);
          return;
        }

        const remaining = Math.max(1, Math.ceil(remainingMs / 1000));
        if (remaining !== state.timer) {
          state.timer = remaining;
          renderTimer();
        }
      };

      tick();
      state.timerInterval = setInterval(tick, 100);
    }

    function startDrawTime() {

      const duration = getDrawTime();

      if (duration <= 0) {
        finishAuction(true);
        return;
      }

      state.drawTime = duration;
      state.drawActive = true;
      state.drawDeadline = Date.now() + duration * 1000;
      state.timer = duration;
      state.timerDeadline = null;

      if (el.timer) {
        el.timer.classList.remove("extra-time-active");
        el.timer.classList.add("draw-time-active");
      }

      if (el.extraStatus) {
        el.extraStatus.textContent =
          `Draw Time aktif: ${formatTime(duration)}`;
        el.extraStatus.classList.remove("active");
      }

      if (el.timerNote) {
        el.timerNote.textContent =
          "DRAW TIME — Coin peringkat 1 & 2 sama";
        el.timerNote.classList.remove("finished-note");
      }

      renderTimer();
      showToast(`Draw Time dimulai: ${duration} detik`);

      stopTimer();

      const tick = () => {
        if (state.auction !== "running" || !state.drawActive) {
          return;
        }

        const remainingMs = state.drawDeadline - Date.now();

        if (remainingMs <= 0) {
          stopTimer();
          state.timer = 0;
          state.drawActive = false;
          state.drawDeadline = null;
          if (el.timer) el.timer.classList.remove("draw-time-active");
          finishAuction(true);
          return;
        }

        const remaining = Math.max(1, Math.ceil(remainingMs / 1000));

        if (remaining !== state.timer) {
          state.timer = remaining;
          renderTimer();
        }
      };

      tick();
      state.timerInterval = setInterval(tick, 100);
    }

    function timerFinished() {

      if (state.auction !== "running") {
        return;
      }

      /* Main timer -> Extra Time */
      if (!state.extraUsed && state.extraTime > 0) {

        state.extraUsed = true;
        state.timer = state.extraTime;
        state.timerDeadline =
          Date.now() + Math.max(0, state.extraTime) * 1000;

        if (el.extraStatus) {
          el.extraStatus.textContent =
            `Extra Time aktif: ${formatTime(state.extraTime)}`;
        }

        if (el.timer) {
          el.timer.classList.remove("draw-time-active");
          el.timer.classList.add("extra-time-active");
        }

        renderTimer();
        showToast("Extra Time dimulai");
        startTimer();
        return;
      }

      /* Setelah Extra Time selesai, cek seri peringkat 1 & 2. */
      state.timer = 0;
      state.timerDeadline = null;

      if (isTopTwoTied()) {
        startDrawTime();
        return;
      }

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

      if (state.drawActive) {
        resumeDrawTime();
      } else {
        startTimer();
      }

      sendAuctionState(
        "running"
      );
    }

    function pauseAuction() {

      if (state.auction !== "running") {
        return;
      }

      if (state.drawActive && Number.isFinite(state.drawDeadline)) {
        state.timer = Math.max(
          0,
          Math.ceil((state.drawDeadline - Date.now()) / 1000)
        );
        state.drawDeadline = null;
        stopTimer();
      } else if (Number.isFinite(state.timerDeadline)) {
        state.timer = Math.max(
          0,
          Math.ceil((state.timerDeadline - Date.now()) / 1000)
        );
        state.timerDeadline = null;
        stopTimer();
      } else {
        stopTimer();
      }

      renderTimer();
      state.auction = "paused";
      applyExtraTimeColor();
      if (el.timer && state.drawActive) {
        el.timer.classList.add("draw-time-active");
      }
      setAuctionUI("paused");
      updateButtons();
      sendAuctionState("paused");
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

      state.drawActive = false;
      state.drawDeadline = null;
      state.drawTime = getDrawTime();

      state.timer =
        state.initialTimer;

      state.timerDeadline =
        null;

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

      stopTimer();

      state.timer = 0;
      state.timerDeadline = null;
      state.drawActive = false;
      state.drawDeadline = null;

      if (el.timer) el.timer.classList.remove("draw-time-active");

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
          "Lelang selesai"
      };

      if (el.timerNote) {

        el.timerNote.textContent =
          next === "finished"
            ? "FINISHED"
            : (state.drawActive && next === "running"
                ? "DRAW TIME — Coin peringkat 1 & 2 sama"
                : (labels[next] || ""));

        el.timerNote.classList.toggle(
          "finished-note",
          next === "finished"
        );
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
           * Event running dari Socket.IO tidak boleh membuat
           * deadline baru jika timer lokal sudah berjalan.
           * Ini mencegah timer meloncat / reset mendadak.
           */
          if (previous !== "running" || !state.timerInterval) {
            if (state.drawActive) {
              resumeDrawTime();
            } else {
              if (!Number.isFinite(state.timerDeadline) && state.timer > 0) {
                state.timerDeadline = Date.now() + state.timer * 1000;
              }
              startTimer();
            }
          }

        } else {

          stopTimer();

          state.timerDeadline =
            null;

          if (next !== "paused") {
            state.drawDeadline = null;
          }

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
      el.topInput,
      el.drawTimeInput,
      el.drawCustomInput
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

            state.drawTime =
              getDrawTime();

            updateDrawTimeSettingsUI();

            if (
              state.auction ===
                "idle" ||
              state.auction ===
                "finished"
            ) {

              state.timer =
                state.initialTimer;

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

    state.extraTime =
      getExtraTime();

    state.top =
      getTop();

    state.drawTime =
      getDrawTime();

    updateDrawTimeSettingsUI();

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

          drawTime:
            state.drawTime,

          drawActive:
            state.drawActive,

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
