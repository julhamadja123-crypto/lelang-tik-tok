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
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 18px !important;
        height: 18px !important;
        font-size: 15px !important;
        line-height: 1 !important;
        flex: 0 0 18px !important;
      }

      /* Jangan tampilkan progress bar yang berat/menyita ruang */
      #progressBar {
        display: none !important;
      }

      /* DRAW TIME: timer kuning */
      #timer.draw-time-active {
        color: #facc15 !important;
        text-shadow: 0 0 12px rgba(250, 204, 21, 0.35) !important;
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

    /* =======================================================
       TIKTOK CONNECTION MONITOR - DASHBOARD
       Panel visual untuk membuktikan koneksi dan event stream.
       Tidak mengubah perhitungan coin/gift.
       ======================================================= */
    if (!document.getElementById("tiktokConnectionMonitor")) {
      const monitor = document.createElement("section");
      monitor.id = "tiktokConnectionMonitor";
      monitor.innerHTML = `
        <div class="tcm-head">
          <div>
            <div class="tcm-kicker">TIKTOK LIVE</div>
            <div class="tcm-title">Connection Monitor</div>
          </div>
          <div id="tcmStatus" class="tcm-status offline">
            <span class="tcm-dot"></span>
            <span id="tcmStatusText">OFFLINE</span>
          </div>
        </div>
        <div class="tcm-account" id="tcmAccount">@—</div>
        <div class="tcm-message" id="tcmMessage">Belum terhubung ke TikTok LIVE.</div>
        <div class="tcm-grid">
          <div class="tcm-stat"><span>CONNECTION</span><strong id="tcmConnection">OFFLINE</strong></div>
          <div class="tcm-stat"><span>EVENT MASUK</span><strong id="tcmEvents">0</strong></div>
          <div class="tcm-stat"><span>GIFT DITERIMA</span><strong id="tcmGifts">0</strong></div>
          <div class="tcm-stat"><span>GIFT TERAKHIR</span><strong id="tcmLastGift">—</strong></div>
        </div>
        <div class="tcm-footer">
          <span id="tcmLastEvent">Belum ada event</span>
          <span id="tcmReconnect"></span>
        </div>
      `;
      document.body.insertBefore(monitor, document.body.firstElementChild);

      const s = document.createElement("style");
      s.id = "tiktokConnectionMonitorStyle";
      s.textContent = `
        #tiktokConnectionMonitor {
          box-sizing:border-box;width:min(1100px,calc(100% - 24px));margin:12px auto 8px;
          padding:16px;border:1px solid rgba(148,163,184,.20);border-radius:18px;
          background:rgba(15,23,42,.88);color:#e5e7eb;box-shadow:0 12px 35px rgba(0,0,0,.20);
          font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        }
        #tiktokConnectionMonitor .tcm-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
        #tiktokConnectionMonitor .tcm-kicker{font-size:10px;letter-spacing:.16em;font-weight:800;opacity:.65}
        #tiktokConnectionMonitor .tcm-title{font-size:18px;font-weight:800;margin-top:2px}
        #tiktokConnectionMonitor .tcm-account{margin-top:10px;font-weight:700;font-size:14px}
        #tiktokConnectionMonitor .tcm-message{margin-top:4px;font-size:12px;opacity:.78;min-height:18px}
        #tiktokConnectionMonitor .tcm-status{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;
          font-size:11px;font-weight:900;letter-spacing:.04em;background:rgba(239,68,68,.12);color:#fca5a5}
        #tiktokConnectionMonitor .tcm-status.connected{background:rgba(34,197,94,.12);color:#86efac}
        #tiktokConnectionMonitor .tcm-status.waiting,#tiktokConnectionMonitor .tcm-status.reconnecting{background:rgba(245,158,11,.12);color:#fcd34d}
        #tiktokConnectionMonitor .tcm-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 10px currentColor}
        #tiktokConnectionMonitor .tcm-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}
        #tiktokConnectionMonitor .tcm-stat{padding:10px 11px;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06)}
        #tiktokConnectionMonitor .tcm-stat span{display:block;font-size:9px;opacity:.55;letter-spacing:.08em;font-weight:800}
        #tiktokConnectionMonitor .tcm-stat strong{display:block;margin-top:4px;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #tiktokConnectionMonitor .tcm-footer{display:flex;justify-content:space-between;gap:10px;margin-top:10px;font-size:10px;opacity:.55}
        @media (max-width:700px){
          #tiktokConnectionMonitor{width:calc(100% - 14px);margin:7px auto;padding:13px;border-radius:15px}
          #tiktokConnectionMonitor .tcm-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
          #tiktokConnectionMonitor .tcm-title{font-size:16px}
        }
      `;
      document.head.appendChild(s);
    }

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
      timerRunId: 0,
      initialTimer: 300,

      extraTime: 0,
      extraUsed: false,

      // DRAW TIME
      drawTime: false,
      drawTimeSeconds: 20,
      drawTimeRunId: 0,

      top: 5,

      version: 0,

      timerInterval: null,

      connected: false,
      connecting: false,
      tiktokPhase: "offline",
      tiktokEventCount: 0,
      tiktokGiftCount: 0,
      tiktokLastEventAt: 0,
      tiktokLastGiftAt: 0,
      tiktokLastGiftName: "",
      tiktokLastGiftCoins: 0
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

        state.timerDeadline =
          null;

        state.extraUsed =
          false;

        state.drawTime = false;
        state.drawTimeRunId =
          (state.drawTimeRunId || 0) + 1;
        state.drawTimeSeconds = 20;

        removeExtraTimeColor();
        removeDrawTimeColor();

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
       DRAW TIME
       ======================================================= */

    function hasCoinTie() {
  // DRAW hanya berlaku untuk peserta dengan coin tertinggi.
  // Hanya dua peserta dengan coin tertinggi yang dibandingkan.
  const participants = Array.from(
    state.participants.values()
  );

  if (participants.length < 2) return false;

  participants.sort(
    (a, b) =>
      num(b?.coins, 0) -
      num(a?.coins, 0)
  );

  const topCoin = num(
    participants[0]?.coins,
    0
  );
  const secondCoin = num(
    participants[1]?.coins,
    0
  );

  return topCoin === secondCoin;
    }
    function applyDrawTimeColor() {
      if (!el.timer) return;

      el.timer.classList.toggle(
        "draw-time-active",
        state.drawTime === true &&
        state.auction === "running"
      );
    }

    function removeDrawTimeColor() {
      if (!el.timer) return;
      el.timer.classList.remove("draw-time-active");
    }

    function startDrawTime() {
      if (state.auction !== "running") return false;
      if (!hasCoinTie()) return false;

      stopTimer();

      state.drawTime = true;
      state.drawTimeSeconds = 20;
      state.drawTimeRunId =
        (state.drawTimeRunId || 0) + 1;

      const runId = state.drawTimeRunId;
      const deadline = Date.now() + 20000;

      state.timerDeadline = deadline;
      state.timer = 20;

      removeExtraTimeColor();
      applyDrawTimeColor();
      setAuctionUI("draw");
      renderTimer();

      sendAuctionState("running", true);

      showToast("DRAW TIME dimulai — 20 detik");

      const tick = () => {
        if (
          runId !== state.drawTimeRunId ||
          !state.drawTime ||
          state.auction !== "running" ||
          state.timerDeadline !== deadline
        ) {
          return;
        }

        const remaining =
          Math.max(
            0,
            Math.ceil(
              (deadline - Date.now()) / 1000
            )
          );

        state.drawTimeSeconds = remaining;
        state.timer = remaining;

        renderTimer();

        if (remaining <= 0) {
          clearInterval(state.timerInterval);
          state.timerInterval = null;

          state.timer = 0;
          renderTimer();

          finishDrawTime();
        }
      };

      tick();
      state.timerInterval = setInterval(tick, 100);

      return true;
    }

    function finishDrawTime() {
      if (
        !state.drawTime ||
        state.auction !== "running"
      ) {
        return;
      }

      // Coin berubah sebelum 00:00 tidak langsung finish.
      state.drawTime = false;
      state.drawTimeRunId =
        (state.drawTimeRunId || 0) + 1;

      if (hasCoinTie()) {
        // Masih seri -> ulangi Draw Time 20 detik.
        state.timer = 20;
        state.timerDeadline = null;
        removeDrawTimeColor();
        startDrawTime();
        return;
      }

      // Coin sudah berbeda -> FINISHED.
      state.timer = 0;
      state.timerDeadline = null;
      removeDrawTimeColor();
      renderTimer();

      finishAuction(true);
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
        applyDrawTimeColor();
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

      // Invalidate every previously scheduled timer callback.
      // This prevents an old callback from finishing Extra Time.
      state.timerRunId = (state.timerRunId || 0) + 1;

      if (state.timerInterval) {

        clearInterval(
          state.timerInterval
        );

        state.timerInterval =
          null;
      }
    }

    function startTimer() {

      // Stop/invalidate the previous timer first.
      stopTimer();

      if (state.auction !== "running") {
        return;
      }

      // Create ONE immutable deadline for this timer run.
      if (!Number.isFinite(state.timerDeadline) || state.timerDeadline <= 0) {
        state.timerDeadline = Date.now() + Math.max(0, Number(state.timer) || 0) * 1000;
      }

      const runId = state.timerRunId;
      const deadline = state.timerDeadline;

      applyExtraTimeColor();

      const tick = () => {
        // Ignore callbacks belonging to an older timer run.
        if (runId !== state.timerRunId) return;
        if (state.auction !== "running") return;
        if (state.timerDeadline !== deadline) return;

        const remainingMs = deadline - Date.now();
        const remaining = Math.max(0, Math.ceil(remainingMs / 1000));

        state.timer = remaining;
        renderTimer();

        if (remaining <= 0) {
          // Invalidate this run BEFORE switching to Extra Time.
          stopTimer();
          state.timer = 0;
          renderTimer();
          timerFinished();
        }
      };

      tick();

      if (runId === state.timerRunId && state.auction === "running" && state.timerDeadline === deadline) {
        state.timerInterval = setInterval(tick, 100);
      }
    }

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
          Date.now() +
          Math.max(0, state.extraTime) * 1000;

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

        // Start a completely new timer run using the NEW Extra Time deadline.
        // Do not reuse the expired main-timer callback.
        startTimer();

        return;
      }

      /* =====================================================
         DRAW TIME
         ===================================================== */

      // Setelah timer utama + Extra Time habis, jika masih ada
      // peserta dengan jumlah coin yang sama, masuk Draw Time.
      if (hasCoinTie()) {
        state.timer = 0;
        state.timerDeadline = null;
        renderTimer();

        startDrawTime();
        return;
      }

      /* =====================================================
         WAKTU BENAR-BENAR HABIS
         ===================================================== */

      state.timer = 0;
      state.timerDeadline = null;
      renderTimer();

      finishAuction(true);
    }

    /* =======================================================
       AUCTION STATE
       ======================================================= */

    function sendAuctionState(next, drawTime = false) {

      if (!socket) return;

      socket.emit(
        "auction:state",
        {
          state: next,
          drawTime: drawTime === true
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

      /*
       * Simpan sisa waktu aktual sebelum pause.
       */
      if (
        Number.isFinite(state.timerDeadline)
      ) {
        state.timer =
          Math.max(
            0,
            Math.ceil(
              (state.timerDeadline - Date.now()) / 1000
            )
          );
      }

      stopTimer();

      state.timerDeadline =
        null;

      renderTimer();

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

      state.drawTime = false;
      state.drawTimeRunId =
        (state.drawTimeRunId || 0) + 1;
      state.drawTimeSeconds = 20;

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

      state.drawTime = false;
      state.drawTimeRunId =
        (state.drawTimeRunId || 0) + 1;

      state.timer = 0;
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
      removeDrawTimeColor();

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

        draw:
          "DRAW TIME",

        finished:
          "Lelang selesai"
      };

      if (el.timerNote) {

        el.timerNote.textContent =
          next === "finished"
            ? "FINISHED"
            : (labels[next] || "");

        el.timerNote.classList.toggle(
          "finished-note",
          next === "finished"
        );

        el.timerNote.classList.toggle(
          "draw-time-note",
          next === "draw"
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

      // Jangan gunakan userId="unknown" sebagai key. Jika TikTool tidak
      // mengirim userId, peserta harus tetap dibedakan dengan uniqueId.
      const userId = String(p?.userId || "").trim();

      if (userId && userId.toLowerCase() !== "unknown") {
        return `id:${userId}`;
      }

      const uniqueId = String(
        p?.uniqueId ||
        p?.username ||
        p?.nickname ||
        "unknown"
      ).trim();

      return `user:${uniqueId.toLowerCase()}`;
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
                  aria-label="${coins} koin"
                >
                  <span class="coin-icon" aria-hidden="true">🪙</span>
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

    function updateTikTokMonitor(data = {}) {
      const phase = String(data?.phase || (data?.ok ? "connected" : "offline"));
      const ok = !!data?.ok && phase === "connected";
      const status = document.getElementById("tcmStatus");
      const statusText = document.getElementById("tcmStatusText");
      const account = document.getElementById("tcmAccount");
      const message = document.getElementById("tcmMessage");
      const connection = document.getElementById("tcmConnection");
      const events = document.getElementById("tcmEvents");
      const gifts = document.getElementById("tcmGifts");
      const lastGift = document.getElementById("tcmLastGift");
      const lastEvent = document.getElementById("tcmLastEvent");
      const reconnect = document.getElementById("tcmReconnect");

      if (!status) return;

      state.tiktokPhase = phase;
      state.tiktokEventCount = num(data?.eventCount, 0);
      state.tiktokGiftCount = num(data?.giftCount, 0);
      state.tiktokLastEventAt = num(data?.lastEventAt, 0);
      state.tiktokLastGiftAt = num(data?.lastGiftAt, 0);

      status.classList.remove("connected","waiting","reconnecting","offline");
      status.classList.add(
        ok ? "connected" :
        phase === "reconnecting" ? "reconnecting" :
        phase === "connected_waiting" || phase === "connecting" ? "waiting" :
        "offline"
      );

      statusText.textContent =
        ok ? "TERHUBUNG" :
        phase === "reconnecting" ? "RECONNECTING" :
        phase === "connected_waiting" ? "MENUNGGU EVENT" :
        phase === "connecting" ? "MENGHUBUNGKAN" :
        phase === "error" ? "ERROR" : "OFFLINE";

      account.textContent =
        data?.username ? `@${String(data.username).replace(/^@/,"")}` : "@—";

      message.textContent = String(data?.message || "Belum terhubung ke TikTok LIVE.");

      connection.textContent =
        ok ? "LIVE CONNECTED" :
        phase === "reconnecting" ? "RECONNECTING" :
        phase === "connected_waiting" ? "WAITING STREAM" :
        phase.toUpperCase();

      events.textContent = String(state.tiktokEventCount);
      gifts.textContent = String(state.tiktokGiftCount);

      if (state.tiktokLastGiftAt) {
        const sec = Math.max(0, Math.floor((Date.now() - state.tiktokLastGiftAt) / 1000));
        lastGift.textContent =
          state.tiktokLastGiftName
            ? `${state.tiktokLastGiftName} • ${sec}s lalu`
            : `${sec}s lalu`;
      } else {
        lastGift.textContent = "—";
      }

      if (state.tiktokLastEventAt) {
        const sec = Math.max(0, Math.floor((Date.now() - state.tiktokLastEventAt) / 1000));
        lastEvent.textContent = `Event terakhir ${sec}s lalu`;
      } else {
        lastEvent.textContent = "Belum ada event";
      }

      reconnect.textContent =
        num(data?.reconnectCount, 0) > 0
          ? `Reconnect: ${num(data?.reconnectCount,0)}`
          : "";

      state.connected = ok;
    }

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

      const monitorMessage =
        document.getElementById("tcmMessage");

      if (monitorMessage && message) {
        monitorMessage.textContent = String(message);
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
          data?.phase === "connecting" ||
          data?.phase === "reconnecting" ||
          data?.phase === "connected_waiting";

        updateTikTokMonitor(data);

        setConnectionText(
          message,
          ok
        );

        updateButtons();

        console.log(
          "[TikTok]",
          data?.phase || "unknown",
          message,
          `events=${num(data?.eventCount,0)}`,
          `gifts=${num(data?.giftCount,0)}`
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

        // Extra Time is owned by this countdown. A delayed/stale FINISHED
        // broadcast must not cancel Extra Time while it is still running.
        if (
          next === "finished" &&
          state.extraUsed &&
          Number(state.timer) > 0 &&
          Number.isFinite(state.timerDeadline)
        ) {
          return;
        }

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

          startTimer();

        } else {

          stopTimer();

          state.timerDeadline =
            null;

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
          console.warn("[GIFT] live:gift diterima tanpa participant:", gift);
          return;
        }

        console.log(
          `[GIFT] participant diterima: @${gift.participant.uniqueId || gift.participant.username || "Viewer"} = ${Number(gift.participant.coins) || 0} coin`
        );

        state.tiktokLastGiftAt = Date.now();
        state.tiktokLastGiftName = String(gift?.giftName || "Gift");
        state.tiktokLastGiftCoins = num(gift?.coinValue, 0);
        const monitorLastGift = document.getElementById("tcmLastGift");
        if (monitorLastGift) {
          monitorLastGift.textContent =
            `${state.tiktokLastGiftName} • ${state.tiktokLastGiftCoins} coin`;
        }

        // Server mengirim participant lengkap dengan total coin.
        // Merge berdasarkan identitas agar perubahan userId TikTok
        // tidak membuat peserta baru/terpisah di layar.
        const incomingParticipant = {
          ...(gift.participant || {})
        };

        let key = participantKey(incomingParticipant);
        let existing = state.participants.get(key);

        if (!existing) {
          const incomingUnique =
            String(
              incomingParticipant.uniqueId ||
              incomingParticipant.username ||
              ""
            ).trim().toLowerCase();

          if (incomingUnique) {
            for (const [existingKey, p] of state.participants.entries()) {
              const existingUnique =
                String(
                  p?.uniqueId ||
                  p?.username ||
                  ""
                ).trim().toLowerCase();

              if (existingUnique && existingUnique === incomingUnique) {
                key = existingKey;
                existing = p;
                break;
              }
            }
          }
        }

        const existingCoins = Number(existing?.coins) || 0;
        const incomingCoins = Number(incomingParticipant.coins);

        // Server sudah menghitung TOTAL coin peserta.
        // Jangan tambahkan gift.coinValue lagi di browser karena event
        // yang sama juga dikirim melalui auction:participant:update.
        // Penambahan kedua inilah yang dapat membuat 1 coin menjadi 2.
        const safeCoins = Number.isFinite(incomingCoins)
          ? Math.max(incomingCoins, existingCoins)
          : existingCoins;

        const mergedParticipant = {
          ...(existing || {}),
          ...incomingParticipant,
          coins: safeCoins,
          userId:
            incomingParticipant.userId ||
            existing?.userId ||
            "unknown",
          uniqueId:
            incomingParticipant.uniqueId ||
            existing?.uniqueId ||
            incomingParticipant.username ||
            "unknown",
          username:
            incomingParticipant.username ||
            existing?.username ||
            incomingParticipant.uniqueId ||
            "unknown",
          nickname:
            incomingParticipant.nickname ||
            existing?.nickname ||
            "Viewer",
          avatar:
            incomingParticipant.avatar ||
            existing?.avatar ||
            null,
          joinedAt:
            existing?.joinedAt ||
            incomingParticipant.joinedAt ||
            Date.now()
        };

        state.participants.set(
          key,
          mergedParticipant
        );

        renderParticipants();

        /*
         * DRAW TIME:
         * Gift tetap diproses selama DRAW TIME.
         * PERUBAHAN COIN TIDAK BOLEH mengakhiri DRAW TIME lebih awal.
         * Hasil hanya diperiksa ketika timer benar-benar mencapai 00:00.
         */

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
       PARTICIPANT UPDATE (FAST PATH)
       ======================================================= */

    socket.on(
      "auction:participant:update",
      data => {

        const incomingVersion =
          Number(data?.version);

        if (
          Number.isFinite(incomingVersion) &&
          incomingVersion < state.version
        ) {
          return;
        }

        if (Number.isFinite(incomingVersion)) {
          state.version = incomingVersion;
        }

        if (data?.reset) {
          state.participants.clear();
          renderParticipants();
          return;
        }

        if (data?.participant) {
          const incoming = { ...data.participant };
          let key = participantKey(incoming);
          let existing = state.participants.get(key);

          if (!existing) {
            const incomingUnique =
              String(
                incoming.uniqueId ||
                incoming.username ||
                ""
              ).trim().toLowerCase();

            if (incomingUnique) {
              for (const [existingKey, p] of state.participants.entries()) {
                const existingUnique =
                  String(
                    p?.uniqueId ||
                    p?.username ||
                    ""
                  ).trim().toLowerCase();

                if (existingUnique && existingUnique === incomingUnique) {
                  key = existingKey;
                  existing = p;
                  break;
                }
              }
            }
          }

          const incomingCoins = Number(incoming.coins);
          const existingCoins = Number(existing?.coins) || 0;

          const merged = {
            ...(existing || {}),
            ...incoming,
            // A fast-path snapshot must never move a participant backwards.
            coins: Number.isFinite(incomingCoins)
              ? Math.max(incomingCoins, existingCoins)
              : existingCoins
          };

          state.participants.set(key, merged);
          renderParticipants();
        }
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

    state.extraUsed =
      false;

    removeExtraTimeColor();
    removeDrawTimeColor();

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
