/* =========================================================
   COIN AUCTION DASHBOARD - FINAL APP.JS
   Cocok dengan index (1).html

   FUNGSI:
   - Hubungkan TikTok LIVE
   - Putuskan koneksi TikTok LIVE
   - Mulai
   - Pause
   - Reset
   - Selesai
   - Timer countdown
   - Extra Time
   - Peserta realtime
   - Coin realtime
   - Anti double render
   - Simpan pengaturan
   - LocalStorage
   - Tidak ada popup gift yang mengganggu
   ========================================================= */

(() => {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function init() {

    /* =======================================================
       SOCKET.IO
       ======================================================= */

    const socket = window.io ? window.io() : null;

    /* =======================================================
       ELEMENT HTML
       SEMUA ID DISESUAIKAN DENGAN index (1).html
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

      // idle | running | paused | finished
      auction: "idle",

      participants: new Map(),

      timer: 0,
      initialTimer: 300,

      extraTime: 0,
      extraUsed: false,

      top: 5,

      version: 0,

      timerInterval: null,

      connected: false,
      connecting: false
    };

    /* =======================================================
       STORAGE
       ======================================================= */

    const STORAGE_KEY = "coinAuctionSettingsVFinal";

    /* =======================================================
       BASIC HELPERS
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
          Math.floor(num(value, min))
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
          localStorage.getItem(STORAGE_KEY);

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

        state.extraUsed =
          false;

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

    function renderTimer() {

      if (el.timer) {

        el.timer.textContent =
          formatTime(
            state.timer
          );
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

      if (
        state.timerInterval
      ) {

        clearInterval(
          state.timerInterval
        );

        state.timerInterval =
          null;
      }
    }

    function startTimer() {

      stopTimer();

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      state.timerInterval =
        setInterval(() => {

          if (
            state.auction !==
            "running"
          ) {
            return;
          }

          if (
            state.timer > 0
          ) {

            state.timer--;

            renderTimer();
          }

          if (
            state.timer <= 0
          ) {

            timerFinished();
          }

        }, 1000);
    }

    function timerFinished() {

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      /*
       * EXTRA TIME
       */

      if (
        !state.extraUsed &&
        state.extraTime > 0
      ) {

        state.extraUsed =
          true;

        state.timer =
          state.extraTime;

        if (el.extraStatus) {

          el.extraStatus.textContent =
            `Extra Time aktif: ${formatTime(
              state.extraTime
            )}`;
        }

        renderTimer();

        showToast(
          "Extra Time dimulai"
        );

        return;
      }

      /*
       * WAKTU BENAR-BENAR HABIS
       */

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

        /*
         * Pertahankan timer.
         */
      }

      /*
       * IDLE / FINISHED -> TIMER BARU
       */

      else {

        state.timer =
          state.initialTimer;

        state.extraUsed =
          false;

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

      stopTimer();

      state.auction =
        "paused";

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

      /*
       * SERVER JUGA RESET
       */

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

      state.auction =
        "finished";

      /*
       * PENTING:
       *
       * FINISH TIDAK MENGHAPUS
       * PESERTA.
       */

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

      /*
       * RESET SELALU BISA DITEKAN
       */

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

            const username =
              escapeHtml(
                p.username ||
                "viewer"
              );

            const coins =
              num(
                p.coins,
                0
              );

            const gifts =
              num(
                p.gifts,
                0
              );

            return `
              <div
                class="participant-row rank-card"
                data-user-id="${escapeAttr(
                  participantKey(p)
                )}"
              >

                <div
                  class="participant-rank rank-number"
                >
                  ${index + 1}
                </div>

                ${avatarHtml(p)}

                <div
                  class="participant-info"
                >

                  <div
                    class="participant-name"
                  >
                    ${nickname}
                  </div>

                  <div
                    class="participant-username"
                  >
                    @${username}
                  </div>

                </div>

                <div
                  class="participant-coins"
                >
                  🪙 ${coins}
                </div>

              </div>
            `;
          }
        ).join("");
    }

    /* =======================================================
       ACTIVITY
       Gift tidak membuat popup.
       Hanya ditampilkan secara ringan di activity list.
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
        "activity-item";

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
        <div class="activity-main">

          <strong>
            ${escapeHtml(username)}
          </strong>

          <span>
            ${escapeHtml(giftName)}
          </span>

        </div>

        <div class="activity-coins">
          +${coins} 🪙
        </div>
      `;

      el.activityList.prepend(
        item
      );

      /*
       * Maksimal 10 activity.
       */

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
       DISCONNECT TIKTOK
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
       SOCKET.IO EVENTS
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

    /*
     * SERVER SOCKET CONNECTED
     */

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

    /*
     * SERVER SOCKET DISCONNECTED
     */

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

    /*
     * SOCKET ERROR
     */

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

    /* =======================================================
       TIKTOK ERROR
       ======================================================= */

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
       AUCTION STATE DARI SERVER
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

        /*
         * Abaikan state lama.
         */

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

        /*
         * SERVER RUNNING
         */

        if (
          next === "running"
        ) {

          /*
           * Jangan reset timer ketika
           * server hanya mengirim ulang
           * state yang sama.
           */

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
          }

          startTimer();
        }

        /*
         * PAUSED / IDLE / FINISHED
         */

        else {

          stopTimer();
        }

        setAuctionUI(
          next
        );

        renderTimer();

        updateButtons();
      }
    );

    /* =======================================================
       PARTICIPANT SNAPSHOT
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
       GIFT EVENT
       ======================================================= */

    socket.on(
      "live:gift",
      gift => {

        /*
         * SERVER HANYA MENGIRIM EVENT
         * SETELAH GIFT DITERIMA.
         *
         * Jadi tidak perlu menghitung
         * coin di frontend lagi.
         */

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
         * Tidak ada popup.
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

        /*
         * Chat sengaja tidak
         * dibuat popup.
         */

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
       BUTTON EVENT DELEGATION
       =======================================================

       Menggunakan document delegation supaya
       tombol tetap berfungsi walaupun ada
       perubahan/re-render elemen.
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
       ENTER PADA USERNAME
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
