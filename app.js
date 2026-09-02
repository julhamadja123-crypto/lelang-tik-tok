/* =========================================================
   COIN AUCTION - APP.JS
   FINAL VERSION
   ========================================================= */

(() => {
  "use strict";

  function initAuctionApp() {

    console.log("[APP] Coin Auction App dimulai");

    /* =======================================================
       SOCKET.IO
       ======================================================= */

    const socket = window.io();

    /* =======================================================
       STATE
       ======================================================= */

    const state = {
      auction: "idle",
      participants: new Map(),
      timer: 0,
      initialTimer: 0,
      timerInterval: null,
      extraTime: 0,
      extraUsed: 0,
      version: 0
    };

    /* =======================================================
       HELPERS
       ======================================================= */

    const $ = (selectors) => {

      for (const selector of selectors) {

        const el =
          document.querySelector(selector);

        if (el) {
          return el;
        }
      }

      return null;
    };

    const $$ = (selectors) => {

      for (const selector of selectors) {

        const els =
          document.querySelectorAll(selector);

        if (els.length) {
          return Array.from(els);
        }
      }

      return [];
    };

    function num(value, fallback = 0) {

      const n =
        Number(value);

      return Number.isFinite(n)
        ? n
        : fallback;
    }

    function escapeHtml(value) {

      return String(value ?? "")
        .replace(
          /[&<>'"]/g,
          char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
          })[char]
        );
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    /* =======================================================
       FIND ELEMENTS
       ======================================================= */

    const usernameInput = $([
      "#username",
      "#tiktokUsername",
      "#tiktok-username",
      "input[name='username']",
      "input[placeholder*='username' i]"
    ]);

    const connectButton = $([
      "#connectTikTok",
      "#connectBtn",
      "#btnConnect",
      "button[data-action='connect']"
    ]);

    const startButton = $([
      "#startAuction",
      "#startBtn",
      "#btnStart",
      "button[data-action='start']"
    ]);

    const pauseButton = $([
      "#pauseAuction",
      "#pauseBtn",
      "#btnPause",
      "button[data-action='pause']"
    ]);

    const resetButton = $([
      "#resetAuction",
      "#resetBtn",
      "#btnReset",
      "button[data-action='reset']"
    ]);

    const finishButton = $([
      "#finishAuction",
      "#finishBtn",
      "#btnFinish",
      "button[data-action='finish']"
    ]);

    const saveSettingsButton = $([
      "#saveSettings",
      "#saveSettingsBtn",
      "#btnSaveSettings",
      "#simpanPengaturan",
      "#btnSimpanPengaturan",
      "button[data-action='save-settings']"
    ]);

    const timerEl = $([
      "#timer",
      "#auctionTimer",
      "#countdown",
      "[data-role='timer']"
    ]);

    const participantCountEl = $([
      "#participantCount",
      "#participantsCount",
      "#jumlahPeserta",
      "[data-role='participant-count']"
    ]);

    const participantList = $([
      "#participants",
      "#participantList",
      "#participantsList",
      ".participants-list",
      "[data-role='participants']"
    ]);

    const extraTimeEl = $([
      "#extraTime",
      "#extraTimeAvailable",
      "[data-role='extra-time']"
    ]);

    const titleInput = $([
      "#auctionTitle",
      "#titleAuction",
      "#judulLelang",
      "input[name='auctionTitle']",
      "input[name='title']"
    ]);

    const minutesInput = $([
      "#minutes",
      "#auctionMinutes",
      "#menit",
      "input[name='minutes']"
    ]);

    const secondsInput = $([
      "#seconds",
      "#auctionSeconds",
      "#detik",
      "input[name='seconds']"
    ]);

    const extraInput = $([
      "#extraSeconds",
      "#extraTimeSeconds",
      "#extraTimeInput",
      "input[name='extraTime']"
    ]);

    function findButtonByText(label) {

      const wanted =
        label.toLowerCase();

      return $$([
        "button",
        "[role='button']"
      ]).find(el => {

        return (
          el.textContent ||
          ""
        )
          .trim()
          .toLowerCase()
          .includes(wanted);
      }) || null;
    }

    const btnStart =
      startButton ||
      findButtonByText("mulai");

    const btnPause =
      pauseButton ||
      findButtonByText("pause");

    const btnReset =
      resetButton ||
      findButtonByText("reset");

    const btnFinish =
      finishButton ||
      findButtonByText("selesai");

    const btnConnect =
      connectButton ||
      findButtonByText("hubungkan");

    /* =======================================================
       DEBUG ELEMENTS
       ======================================================= */

    console.log(
      "[BUTTON] Connect:",
      btnConnect
    );

    console.log(
      "[BUTTON] Start:",
      btnStart
    );

    console.log(
      "[BUTTON] Pause:",
      btnPause
    );

    console.log(
      "[BUTTON] Reset:",
      btnReset
    );

    console.log(
      "[BUTTON] Finish:",
      btnFinish
    );

    console.log(
      "[BUTTON] Save:",
      saveSettingsButton
    );

    /* =======================================================
       TIMER
       ======================================================= */

    function parseTimerText(text) {

      const match =
        String(text || "")
          .match(
            /(\d+)\s*:\s*(\d+)/
          );

      if (!match) {
        return 0;
      }

      return (
        Number(match[1]) * 60 +
        Number(match[2])
      );
    }

    function readInitialTimer() {

      const minutes =
        num(
          minutesInput?.value,
          0
        );

      const seconds =
        num(
          secondsInput?.value,
          0
        );

      const total =
        Math.max(
          0,
          Math.floor(
            minutes * 60 +
            seconds
          )
        );

      if (total > 0) {
        return total;
      }

      const current =
        parseTimerText(
          timerEl?.textContent ||
          ""
        );

      return current > 0
        ? current
        : 300;
    }

    function readExtraTime() {

      const value =
        num(
          extraInput?.value,
          0
        );

      if (value > 0) {
        return Math.floor(value);
      }

      return 0;
    }

    function formatTime(total) {

      total =
        Math.max(
          0,
          Math.floor(
            total || 0
          )
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

      if (!timerEl) {
        return;
      }

      timerEl.textContent =
        formatTime(
          state.timer
        );
    }

    function clearTimer() {

      if (
        state.timerInterval
      ) {

        clearInterval(
          state.timerInterval
        );
      }

      state.timerInterval =
        null;
    }

    /* =======================================================
       LOCAL TIMER
       ======================================================= */

    function startLocalTimer() {

      clearTimer();

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

            return;
          }

          /*
            Timer habis.
          */

          if (
            state.extraTime >
            state.extraUsed
          ) {

            const remainingExtra =
              state.extraTime -
              state.extraUsed;

            state.timer =
              remainingExtra;

            state.extraUsed +=
              remainingExtra;

            renderTimer();

            return;
          }

          clearTimer();

          state.auction =
            "finished";

          updateButtons();

          socket.emit(
            "auction:state",
            {
              state: "finished"
            }
          );

          console.log(
            "[AUCTION] Timer habis -> FINISHED"
          );

        }, 1000);
    }

    /* =======================================================
       PARTICIPANT KEY
       ======================================================= */

    function participantKey(participant) {

      return String(
        participant?.userId ||
        participant?.username ||
        participant?.uniqueId ||
        "unknown"
      );
    }

    /* =======================================================
       RENDER PARTICIPANTS
       ======================================================= */

    function renderParticipants() {

      if (
        participantCountEl
      ) {

        participantCountEl.textContent =
          `${state.participants.size} peserta`;
      }

      if (
        !participantList
      ) {
        return;
      }

      const list =
        Array.from(
          state.participants.values()
        ).sort(
          (a, b) => {

            const coinDifference =
              num(b.coins) -
              num(a.coins);

            if (
              coinDifference !== 0
            ) {
              return coinDifference;
            }

            return (
              num(a.joinedAt) -
              num(b.joinedAt)
            );
          }
        );

      if (
        list.length === 0
      ) {

        participantList.innerHTML =
          `
          <div class="empty-participants">
            Menunggu peserta
          </div>
          `;

        return;
      }

      participantList.innerHTML =
        list.map(
          (participant, index) => {

            const nickname =
              escapeHtml(
                participant.nickname ||
                participant.username ||
                "Viewer"
              );

            const username =
              escapeHtml(
                participant.username ||
                participant.uniqueId ||
                "viewer"
              );

            let avatar;

            if (
              participant.avatar
            ) {

              avatar =
                `
                <img
                  src="${escapeAttr(
                    participant.avatar
                  )}"
                  alt=""
                  class="participant-avatar"
                  loading="lazy"
                >
                `;

            } else {

              const first =
                (
                  participant.nickname ||
                  participant.username ||
                  "V"
                )
                  .charAt(0)
                  .toUpperCase();

              avatar =
                `
                <div
                  class="participant-avatar participant-initial"
                >
                  ${escapeHtml(first)}
                </div>
                `;
            }

            return `
              <div
                class="participant-row"
                data-user-id="${escapeAttr(
                  participantKey(
                    participant
                  )
                )}"
              >

                <div class="participant-rank">
                  ${index + 1}
                </div>

                ${avatar}

                <div class="participant-info">

                  <div class="participant-name">
                    ${nickname}
                  </div>

                  <div class="participant-username">
                    @${username}
                  </div>

                </div>

                <div class="participant-coins">
                  🪙 ${num(
                    participant.coins,
                    0
                  )}
                </div>

              </div>
            `;
          }
        ).join("");
    }

    /* =======================================================
       BUTTON STATE
       ======================================================= */

    function updateButtons() {

      /*
        SEMUA TOMBOL SELALU AKTIF.
        Jangan menggunakan disabled karena
        beberapa layout mobile dapat membuat
        tombol tidak menerima touch.
      */

      [
        btnStart,
        btnPause,
        btnReset,
        btnFinish,
        btnConnect,
        saveSettingsButton
      ]
        .filter(Boolean)
        .forEach(button => {

          button.disabled =
            false;

          button.removeAttribute(
            "disabled"
          );

          button.style.pointerEvents =
            "auto";

          button.style.touchAction =
            "manipulation";

          button.style.cursor =
            "pointer";

          button.style.userSelect =
            "none";

          button.style.webkitTapHighlightColor =
            "transparent";
        });
    }

    /* =======================================================
       START AUCTION
       ======================================================= */

    function startAuction() {

      console.log(
        "[BUTTON] START ditekan"
      );

      if (
        state.auction ===
        "running"
      ) {
        return;
      }

      /*
        Kalau mulai dari idle/finished,
        timer kembali ke awal.

        Kalau pause,
        lanjut dari timer terakhir.
      */

      if (
        state.auction ===
        "paused" &&
        state.timer > 0
      ) {

        // lanjut timer

      } else {

        state.initialTimer =
          readInitialTimer();

        state.timer =
          state.initialTimer;

        state.extraUsed =
          0;
      }

      state.extraTime =
        readExtraTime();

      state.auction =
        "running";

      renderTimer();

      updateButtons();

      startLocalTimer();

      socket.emit(
        "auction:state",
        {
          state: "running"
        }
      );

      console.log(
        "[AUCTION] RUNNING"
      );
    }

    /* =======================================================
       PAUSE AUCTION
       ======================================================= */

    function pauseAuction() {

      console.log(
        "[BUTTON] PAUSE ditekan"
      );

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      clearTimer();

      state.auction =
        "paused";

      updateButtons();

      socket.emit(
        "auction:state",
        {
          state: "paused"
        }
      );

      console.log(
        "[AUCTION] PAUSED"
      );
    }

    /* =======================================================
       RESET AUCTION
       ======================================================= */

    function resetAuction() {

      console.log(
        "[BUTTON] RESET ditekan"
      );

      /*
        Hentikan timer.
      */

      clearTimer();

      /*
        Hapus peserta lokal.
      */

      state.participants.clear();

      /*
        Reset timer.
      */

      state.initialTimer =
        readInitialTimer();

      state.timer =
        state.initialTimer;

      /*
        Reset extra time.
      */

      state.extraTime =
        readExtraTime();

      state.extraUsed =
        0;

      /*
        Status idle.
      */

      state.auction =
        "idle";

      /*
        Naikkan version lokal.
      */

      state.version++;

      /*
        Render langsung.
      */

      renderTimer();

      renderParticipants();

      updateButtons();

      /*
        Reset server.
      */

      socket.emit(
        "auction:reset"
      );

      console.log(
        "[AUCTION] RESET selesai"
      );
    }

    /* =======================================================
       FINISH AUCTION
       ======================================================= */

    function finishAuction() {

      console.log(
        "[BUTTON] SELESAI ditekan"
      );

      /*
        Hentikan timer.
      */

      clearTimer();

      /*
        Status finished.
      */

      state.auction =
        "finished";

      /*
        JANGAN clear participants.
      */

      renderParticipants();

      updateButtons();

      /*
        Beritahu server.
      */

      socket.emit(
        "auction:state",
        {
          state: "finished"
        }
      );

      console.log(
        "[AUCTION] FINISHED - peserta tetap"
      );
    }

    /* =======================================================
       TIKTOK CONNECT
       ======================================================= */

    function connectTikTok() {

      console.log(
        "[BUTTON] CONNECT TIKTOK ditekan"
      );

      const username =
        String(
          usernameInput?.value ||
          ""
        )
          .trim()
          .replace(
            /^@/,
            ""
          );

      if (!username) {

        console.warn(
          "[TikTok] Username kosong"
        );

        return;
      }

      socket.emit(
        "live:connect",
        {
          username
        }
      );

      console.log(
        "[TikTok] Meminta koneksi:",
        username
      );
    }

    /* =======================================================
       SAVE SETTINGS
       ======================================================= */

    const SETTINGS_KEY =
      "coinAuctionSettings";

    function saveSettings() {

      console.log(
        "[BUTTON] SAVE SETTINGS ditekan"
      );

      const title =
        String(
          titleInput?.value ||
          ""
        ).trim();

      const minutes =
        Math.max(
          0,
          Math.floor(
            num(
              minutesInput?.value,
              0
            )
          )
        );

      const seconds =
        Math.max(
          0,
          Math.floor(
            num(
              secondsInput?.value,
              0
            )
          )
        );

      const extraTime =
        Math.max(
          0,
          Math.floor(
            num(
              extraInput?.value,
              0
            )
          )
        );

      const settings = {
        title,
        minutes,
        seconds,
        extraTime
      };

      try {

        localStorage.setItem(
          SETTINGS_KEY,
          JSON.stringify(
            settings
          )
        );

      } catch (error) {

        console.warn(
          "[SETTINGS] localStorage gagal",
          error
        );
      }

      state.initialTimer =
        minutes * 60 +
        seconds;

      state.extraTime =
        extraTime;

      state.extraUsed =
        0;

      if (
        state.auction === "idle" ||
        state.auction === "finished"
      ) {

        state.timer =
          state.initialTimer;
      }

      renderTimer();

      const titleDisplay =
        $([
          "#auctionTitleDisplay",
          "#displayAuctionTitle",
          "#auctionTitleText",
          "#displayTitle",
          "[data-role='auction-title']"
        ]);

      if (
        titleDisplay &&
        title
      ) {

        titleDisplay.textContent =
          title;
      }

      if (
        saveSettingsButton
      ) {

        const oldText =
          saveSettingsButton
            .textContent;

        saveSettingsButton.textContent =
          "✓ Pengaturan Tersimpan";

        setTimeout(() => {

          saveSettingsButton.textContent =
            oldText ||
            "Simpan Pengaturan";

        }, 1500);
      }

      console.log(
        "[SETTINGS] Tersimpan:",
        settings
      );
    }

    /* =======================================================
       LOAD SETTINGS
       ======================================================= */

    function loadSettings() {

      try {

        const raw =
          localStorage.getItem(
            SETTINGS_KEY
          );

        if (!raw) {
          return;
        }

        const settings =
          JSON.parse(raw);

        if (
          titleInput &&
          settings.title !==
            undefined
        ) {

          titleInput.value =
            settings.title;
        }

        if (
          minutesInput &&
          settings.minutes !==
            undefined
        ) {

          minutesInput.value =
            settings.minutes;
        }

        if (
          secondsInput &&
          settings.seconds !==
            undefined
        ) {

          secondsInput.value =
            settings.seconds;
        }

        if (
          extraInput &&
          settings.extraTime !==
            undefined
        ) {

          extraInput.value =
            settings.extraTime;
        }

      } catch (error) {

        console.warn(
          "[SETTINGS] Gagal membaca settings",
          error
        );
      }
    }

    /* =======================================================
       BUTTON BIND
       ======================================================= */

    function bindButton(
      button,
      handler,
      name
    ) {

      if (!button) {

        console.warn(
          `[BUTTON] ${name} tidak ditemukan`
        );

        return;
      }

      /*
        Pastikan tombol benar-benar aktif.
      */

      button.disabled =
        false;

      button.removeAttribute(
        "disabled"
      );

      button.style.pointerEvents =
        "auto";

      button.style.touchAction =
        "manipulation";

      button.style.cursor =
        "pointer";

      button.style.userSelect =
        "none";

      /*
        Animasi tekan.
      */

      button.addEventListener(
        "pointerdown",
        () => {

          button.style.transform =
            "scale(.96)";

          button.style.opacity =
            ".78";

        },
        {
          passive: true
        }
      );

      function releaseButton() {

        button.style.transform =
          "scale(1)";

        button.style.opacity =
          "1";
      }

      button.addEventListener(
        "pointerup",
        releaseButton,
        {
          passive: true
        }
      );

      button.addEventListener(
        "pointercancel",
        releaseButton,
        {
          passive: true
        }
      );

      button.addEventListener(
        "pointerleave",
        releaseButton,
        {
          passive: true
        }
      );

      /*
        CLICK.
      */

      button.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          console.log(
            `[BUTTON] ${name} CLICK`
          );

          handler();

        }
      );

      console.log(
        `[BUTTON] ${name} berhasil di-bind`
      );
    }

    /* =======================================================
       SOCKET CONNECT
       ======================================================= */

    socket.on(
      "connect",
      () => {

        console.log(
          "[SOCKET] Terhubung:",
          socket.id
        );

        updateButtons();
      }
    );

    socket.on(
      "disconnect",
      reason => {

        console.warn(
          "[SOCKET] Terputus:",
          reason
        );
      }
    );

    /* =======================================================
       TIKTOK STATUS
       ======================================================= */

    socket.on(
      "live:status",
      data => {

        console.log(
          "[TIKTOK STATUS]",
          data
        );

        const statusEl =
          $([
            "#connectionStatus",
            "#liveStatus",
            "#status",
            "[data-role='live-status']"
          ]);

        if (
          statusEl &&
          data?.message
        ) {

          statusEl.textContent =
            data.message;
        }
      }
    );

    socket.on(
      "live:error",
      data => {

        console.error(
          "[TIKTOK ERROR]",
          data
        );
      }
    );

    /* =======================================================
       SERVER AUCTION STATE
       ======================================================= */

    socket.on(
      "auction:state",
      data => {

        if (!data) {
          return;
        }

        const nextState =
          data.state ||
          (
            data.active
              ? "running"
              : "idle"
          );

        if (
          data.version !==
            undefined &&
          Number(data.version) <
            Number(state.version)
        ) {

          return;
        }

        if (
          data.version !==
            undefined
        ) {

          state.version =
            Number(data.version);
        }

        state.auction =
          nextState;

        console.log(
          "[AUCTION STATE FROM SERVER]",
          nextState
        );

        if (
          nextState ===
          "running"
        ) {

          startLocalTimer();

        } else {

          clearTimer();
        }

        updateButtons();
      }
    );

    /* =======================================================
       SERVER PARTICIPANTS
       ======================================================= */

    socket.on(
      "auction:participants",
      data => {

        if (!data) {
          return;
        }

        if (
          data.version !==
            undefined &&
          Number(data.version) <
            Number(state.version)
        ) {

          console.log(
            "[PARTICIPANTS] Snapshot lama diabaikan"
          );

          return;
        }

        if (
          data.version !==
            undefined
        ) {

          state.version =
            Number(data.version);
        }

        state.participants.clear();

        const list =
          Array.isArray(
            data.participants
          )
            ? data.participants
            : [];

        list.forEach(
          participant => {

            state.participants.set(
              participantKey(
                participant
              ),
              participant
            );
          }
        );

        renderParticipants();

        console.log(
          "[PARTICIPANTS] Update:",
          state.participants.size
        );
      }
    );

    /* =======================================================
       LIVE GIFT
       ======================================================= */

    socket.on(
      "live:gift",
      gift => {

        /*
          Jangan proses gift kalau
          lelang tidak running.
        */

        if (
          state.auction !==
          "running"
        ) {

          return;
        }

        if (
          gift?.participant
        ) {

          state.participants.set(
            participantKey(
              gift.participant
            ),
            gift.participant
          );

          renderParticipants();
        }

        console.log(
          "[GIFT]",
          gift?.username,
          "+",
          gift?.coinValue,
          "coin"
        );
      }
    );

    /* =======================================================
       BIND ALL BUTTONS
       ======================================================= */

    bindButton(
      btnConnect,
      connectTikTok,
      "CONNECT"
    );

    bindButton(
      btnStart,
      startAuction,
      "START"
    );

    bindButton(
      btnPause,
      pauseAuction,
      "PAUSE"
    );

    bindButton(
      btnReset,
      resetAuction,
      "RESET"
    );

    bindButton(
      btnFinish,
      finishAuction,
      "FINISH"
    );

    bindButton(
      saveSettingsButton,
      saveSettings,
      "SAVE SETTINGS"
    );

    /* =======================================================
       INITIALIZE
       ======================================================= */

    loadSettings();

    state.initialTimer =
      readInitialTimer();

    state.timer =
      state.initialTimer;

    state.extraTime =
      readExtraTime();

    renderTimer();

    renderParticipants();

    updateButtons();

    /* =======================================================
       PUBLIC API
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

          participants:
            Array.from(
              state.participants.values()
            )
        };
      }
    };

    console.log(
      "[APP] Coin Auction siap."
    );

  } // END initAuctionApp


  /* =========================================================
     DOM READY
     ========================================================= */

  if (
    document.readyState ===
    "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      initAuctionApp,
      {
        once: true
      }
    );

  } else {

    initAuctionApp();
  }

})();
