/* =========================================================
   LIVE COIN AUCTION
   APP.JS FINAL
   ========================================================= */

(() => {
  "use strict";

  /* =======================================================
     INIT
     ======================================================= */

  function initCoinAuction() {

    console.log(
      "[Auction] APP.JS dimulai."
    );

    /* =====================================================
       SOCKET
       ===================================================== */

    if (
      typeof window.io !== "function"
    ) {

      console.error(
        "[Auction] Socket.IO tidak ditemukan."
      );

      return;
    }

    const socket =
      window.io({
        transports: [
          "websocket",
          "polling"
        ]
      });

    /* =====================================================
       STATE
       ===================================================== */

    const state = {

      auction:
        "idle",

      participants:
        new Map(),

      timer:
        0,

      initialTimer:
        300,

      timerInterval:
        null,

      extraTime:
        0,

      extraUsed:
        0,

      version:
        0
    };

    /* =====================================================
       SELECTOR
       ===================================================== */

    function findElement(
      selectors
    ) {

      for (
        const selector of selectors
      ) {

        const el =
          document.querySelector(
            selector
          );

        if (el) {
          return el;
        }
      }

      return null;
    }

    function findButtonByText(
      words
    ) {

      const buttons =
        Array.from(
          document.querySelectorAll(
            "button, [role='button'], input[type='button'], input[type='submit']"
          )
        );

      for (
        const button of buttons
      ) {

        const text =
          String(
            button.textContent ||
            button.value ||
            ""
          )
            .trim()
            .toLowerCase();

        for (
          const word of words
        ) {

          if (
            text.includes(
              word.toLowerCase()
            )
          ) {

            return button;
          }
        }
      }

      return null;
    }

    /* =====================================================
       INPUTS
       ===================================================== */

    const usernameInput =
      findElement([
        "#username",
        "#tiktokUsername",
        "#tiktok-username",
        "input[name='username']",
        "input[name='tiktokUsername']",
        "input[placeholder*='username' i]"
      ]);

    /* =====================================================
       BUTTONS
       ===================================================== */

    const btnConnect =
      findElement([
        "#connectTikTok",
        "#connectBtn",
        "#btnConnect",
        "#hubungkanTikTok",
        "#btnHubungkan",
        "[data-action='connect']"
      ]) ||
      findButtonByText([
        "hubungkan tiktok",
        "hubungkan"
      ]);

    const btnStart =
      findElement([
        "#startAuction",
        "#startBtn",
        "#btnStart",
        "#mulaiAuction",
        "#btnMulai",
        "[data-action='start']"
      ]) ||
      findButtonByText([
        "mulai"
      ]);

    const btnPause =
      findElement([
        "#pauseAuction",
        "#pauseBtn",
        "#btnPause",
        "#btnJeda",
        "[data-action='pause']"
      ]) ||
      findButtonByText([
        "pause",
        "jeda"
      ]);

    const btnReset =
      findElement([
        "#resetAuction",
        "#resetBtn",
        "#btnReset",
        "[data-action='reset']"
      ]) ||
      findButtonByText([
        "reset"
      ]);

    const btnFinish =
      findElement([
        "#finishAuction",
        "#finishBtn",
        "#btnFinish",
        "#btnSelesai",
        "[data-action='finish']"
      ]) ||
      findButtonByText([
        "selesai",
        "finish"
      ]);

    /* =====================================================
       DISPLAY
       ===================================================== */

    const timerEl =
      findElement([
        "#timer",
        "#auctionTimer",
        "#countdown",
        "[data-role='timer']"
      ]);

    const participantCountEl =
      findElement([
        "#participantCount",
        "#participantsCount",
        "#participant-count",
        "[data-role='participant-count']"
      ]);

    const participantList =
      findElement([
        "#participants",
        "#participantList",
        "#participantsList",
        ".participants-list",
        "[data-role='participants']"
      ]);

    const statusEl =
      findElement([
        "#connectionStatus",
        "#liveStatus",
        "#status",
        "#tiktokStatus",
        "[data-role='live-status']"
      ]);

    /* =====================================================
       TIME INPUT
       ===================================================== */

    const minutesInput =
      findElement([
        "#minutes",
        "#auctionMinutes",
        "#menit",
        "input[name='minutes']"
      ]);

    const secondsInput =
      findElement([
        "#seconds",
        "#auctionSeconds",
        "#detik",
        "input[name='seconds']"
      ]);

    const extraInput =
      findElement([
        "#extraSeconds",
        "#extraTimeSeconds",
        "#extraTimeInput",
        "input[name='extraTime']"
      ]);

    const extraTimeEl =
      findElement([
        "#extraTime",
        "#extraTimeAvailable",
        "[data-role='extra-time']"
      ]);

    /* =====================================================
       DEBUG
       ===================================================== */

    console.log(
      "[Auction] Tombol ditemukan:",
      {
        connect:
          Boolean(btnConnect),

        start:
          Boolean(btnStart),

        pause:
          Boolean(btnPause),

        reset:
          Boolean(btnReset),

        finish:
          Boolean(btnFinish)
      }
    );

    /* =====================================================
       NUMBER
       ===================================================== */

    function num(
      value,
      fallback = 0
    ) {

      const n =
        Number(value);

      return Number.isFinite(n)
        ? n
        : fallback;
    }

    /* =====================================================
       TIMER PARSER
       ===================================================== */

    function parseTimerText(
      text
    ) {

      const match =
        String(text)
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

    /* =====================================================
       READ INITIAL TIMER
       ===================================================== */

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

      const screenTimer =
        parseTimerText(
          timerEl?.textContent ||
          ""
        );

      if (
        screenTimer > 0
      ) {
        return screenTimer;
      }

      return 300;
    }

    /* =====================================================
       READ EXTRA TIME
       ===================================================== */

    function readExtraTime() {

      const inputValue =
        num(
          extraInput?.value,
          0
        );

      if (
        inputValue > 0
      ) {

        return Math.floor(
          inputValue
        );
      }

      const text =
        extraTimeEl?.textContent ||
        "";

      const match =
        text.match(
          /(\d+)\s*:?\s*(\d+)?/
        );

      if (!match) {
        return 0;
      }

      if (match[2]) {

        return (
          Number(match[1]) * 60 +
          Number(match[2])
        );
      }

      return Number(match[1]);
    }

    /* =====================================================
       FORMAT TIMER
       ===================================================== */

    function formatTime(
      total
    ) {

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

      if (
        hours > 0
      ) {

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

    /* =====================================================
       RENDER TIMER
       ===================================================== */

    function renderTimer() {

      if (!timerEl) {
        return;
      }

      timerEl.textContent =
        formatTime(
          state.timer
        );
    }

    /* =====================================================
       CLEAR TIMER
       ===================================================== */

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

    /* =====================================================
       AUCTION STATE
       ===================================================== */

    function setLocalAuctionState(
      nextState
    ) {

      state.auction =
        nextState;

      updateButtons();
    }

    /* =====================================================
       LOCAL TIMER
       ===================================================== */

    function startLocalTimer() {

      clearTimer();

      if (
        state.auction !==
        "running"
      ) {
        return;
      }

      state.timerInterval =
        setInterval(
          () => {

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

            /* =============================================
               EXTRA TIME
               ============================================= */

            if (
              state.extraTime >
              state.extraUsed
            ) {

              const available =
                state.extraTime -
                state.extraUsed;

              state.timer =
                available;

              state.extraUsed +=
                available;

              renderTimer();

              return;
            }

            /* =============================================
               FINISH OTOMATIS
               ============================================= */

            clearTimer();

            state.auction =
              "finished";

            /*
             * IMPORTANT:
             * Jangan clear participants.
             */

            socket.emit(
              "auction:state",
              {
                state:
                  "finished"
              }
            );

            updateButtons();

          },
          1000
        );
    }

    /* =====================================================
       SEND AUCTION STATE
       ===================================================== */

    function sendAuctionState(
      nextState
    ) {

      socket.emit(
        "auction:state",
        {
          state:
            nextState
        }
      );
    }

    /* =====================================================
       MULAI
       ===================================================== */

    function startAuction() {

      if (
        state.auction ===
        "running"
      ) {

        return;
      }

      /*
       * Jika sebelumnya PAUSE,
       * lanjutkan timer.
       *
       * Jika IDLE / FINISHED,
       * mulai timer baru.
       */

      if (
        state.auction ===
        "paused" &&
        state.timer > 0
      ) {

        /* lanjutkan */
      } else {

        state.initialTimer =
          readInitialTimer();

        state.timer =
          state.initialTimer;

        state.extraTime =
          readExtraTime();

        state.extraUsed =
          0;
      }

      state.auction =
        "running";

      renderTimer();

      updateButtons();

      /*
       * SERVER menjadi aktif
       * menerima gift.
       */

      sendAuctionState(
        "running"
      );

      startLocalTimer();

      console.log(
        "[Auction] MULAI"
      );
    }

    /* =====================================================
       PAUSE
       ===================================================== */

    function pauseAuction() {

      if (
        state.auction !==
        "running"
      ) {

        return;
      }

      clearTimer();

      state.auction =
        "paused";

      /*
       * SERVER berhenti menerima gift.
       */

      sendAuctionState(
        "paused"
      );

      updateButtons();

      console.log(
        "[Auction] PAUSE"
      );
    }

    /* =====================================================
       RESET
       ===================================================== */

    function resetAuction() {

      clearTimer();

      /*
       * RESET:
       * peserta DIHAPUS.
       */

      state.participants.clear();

      state.initialTimer =
        readInitialTimer();

      state.timer =
        state.initialTimer;

      state.extraTime =
        readExtraTime();

      state.extraUsed =
        0;

      state.auction =
        "idle";

      renderTimer();

      renderParticipants();

      /*
       * Server juga menghapus
       * daftar peserta.
       */

      socket.emit(
        "auction:reset"
      );

      updateButtons();

      console.log(
        "[Auction] RESET"
      );
    }

    /* =====================================================
       SELESAI
       ===================================================== */

    function finishAuction() {

      /*
       * Hentikan timer.
       */

      clearTimer();

      /*
       * JANGAN:
       * state.participants.clear()
       *
       * Karena peserta harus tetap tampil.
       */

      state.auction =
        "finished";

      /*
       * SERVER berhenti menerima gift.
       */

      sendAuctionState(
        "finished"
      );

      renderParticipants();

      updateButtons();

      console.log(
        "[Auction] SELESAI - peserta tetap."
      );
    }

    /* =====================================================
       BUTTON STATE
       ===================================================== */

    function updateButtons() {

      /*
       * Jangan memakai disabled
       * terlalu agresif.
       *
       * Semua tombol tetap bisa
       * ditekan sesuai fungsi.
       */

      if (btnConnect) {

        btnConnect.disabled =
          false;

        btnConnect.style.pointerEvents =
          "auto";
      }

      if (btnStart) {

        btnStart.disabled =
          state.auction ===
          "running";

        btnStart.style.pointerEvents =
          "auto";
      }

      if (btnPause) {

        btnPause.disabled =
          state.auction !==
          "running";

        btnPause.style.pointerEvents =
          "auto";
      }

      if (btnReset) {

        btnReset.disabled =
          false;

        btnReset.style.pointerEvents =
          "auto";
      }

      if (btnFinish) {

        btnFinish.disabled =
          !(
            state.auction ===
            "running" ||
            state.auction ===
            "paused"
          );

        btnFinish.style.pointerEvents =
          "auto";
      }
    }

    /* =====================================================
       PARTICIPANT KEY
       ===================================================== */

    function participantKey(
      participant
    ) {

      return String(
        participant.userId ||
        participant.username ||
        participant.nickname ||
        "unknown"
      );
    }

    /* =====================================================
       ESCAPE HTML
       ===================================================== */

    function escapeHtml(
      value
    ) {

      return String(
        value ?? ""
      ).replace(
        /[&<>'"]/g,
        character => {

          const map = {
            "&":
              "&amp;",

            "<":
              "&lt;",

            ">":
              "&gt;",

            "'":
              "&#39;",

            '"':
              "&quot;"
          };

          return map[
            character
          ];
        }
      );
    }

    /* =====================================================
       ESCAPE ATTRIBUTE
       ===================================================== */

    function escapeAttr(
      value
    ) {

      return escapeHtml(
        value
      );
    }

    /* =====================================================
       RENDER PARTICIPANTS
       ===================================================== */

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
          (a, b) =>
            Number(b.coins || 0) -
              Number(a.coins || 0) ||
            Number(a.joinedAt || 0) -
              Number(b.joinedAt || 0)
        );

      if (
        !list.length
      ) {

        participantList.innerHTML =
          `<div class="empty-participants">
             Menunggu peserta
           </div>`;

        return;
      }

      participantList.innerHTML =
        list.map(
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

            let avatar;

            if (
              p.avatar
            ) {

              avatar =
                `<img
                  src="${escapeAttr(p.avatar)}"
                  alt=""
                  class="participant-avatar"
                  loading="lazy"
                >`;

            } else {

              const initial =
                (
                  p.nickname ||
                  p.username ||
                  "V"
                )
                  .charAt(0)
                  .toUpperCase();

              avatar =
                `<div
                  class="participant-avatar participant-initial"
                >
                  ${escapeHtml(initial)}
                </div>`;
            }

            return `
              <div
                class="participant-row"
                data-user-id="${escapeAttr(
                  participantKey(p)
                )}"
              >

                <div
                  class="participant-rank"
                >
                  ${index + 1}
                </div>

                ${avatar}

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
                  🪙 ${num(p.coins, 0)}
                </div>

              </div>
            `;
          }
        )
        .join("");
    }

    /* =====================================================
       CONNECT TIKTOK
       ===================================================== */

    function connectTikTok() {

      if (
        !usernameInput
      ) {

        console.error(
          "[TikTok] Input username tidak ditemukan."
        );

        return;
      }

      const username =
        String(
          usernameInput.value ||
          ""
        )
          .trim()
          .replace(
            /^@/,
            ""
          );

      if (
        !username
      ) {

        if (statusEl) {

          statusEl.textContent =
            "Masukkan username TikTok terlebih dahulu.";
        }

        return;
      }

      if (statusEl) {

        statusEl.textContent =
          `Menghubungkan ke @${username}...`;
      }

      console.log(
        `[TikTok] CONNECT @${username}`
      );

      socket.emit(
        "live:connect",
        {
          username
        }
      );
    }

    /* =====================================================
       SOCKET CONNECT
       ===================================================== */

    socket.on(
      "connect",
      () => {

        console.log(
          "[Socket] TERHUBUNG:",
          socket.id
        );

        updateButtons();
      }
    );

    /* =====================================================
       SOCKET DISCONNECT
       ===================================================== */

    socket.on(
      "disconnect",
      () => {

        console.warn(
          "[Socket] Terputus."
        );
      }
    );

    /* =====================================================
       TIKTOK STATUS
       ===================================================== */

    socket.on(
      "live:status",
      data => {

        console.log(
          "[TikTok STATUS]",
          data
        );

        if (
          statusEl &&
          data?.message
        ) {

          statusEl.textContent =
            data.message;
        }
      }
    );

    /* =====================================================
       TIKTOK ERROR
       ===================================================== */

    socket.on(
      "live:error",
      data => {

        console.error(
          "[TikTok ERROR]",
          data
        );

        if (
          statusEl &&
          data?.message
        ) {

          statusEl.textContent =
            data.message;
        }
      }
    );

    /* =====================================================
       AUCTION STATE FROM SERVER
       ===================================================== */

    socket.on(
      "auction:state",
      data => {

        const nextState =
          data?.state ||
          (
            data?.active
              ? "running"
              : "idle"
          );

        if (
          data?.version !==
            undefined &&
          Number(data.version) <
            Number(state.version)
        ) {

          return;
        }

        if (
          data?.version !==
          undefined
        ) {

          state.version =
            Number(data.version);
        }

        /*
         * Jika server mengirim snapshot
         * peserta, gunakan.
         */

        if (
          Array.isArray(
            data?.participants
          )
        ) {

          state.participants.clear();

          for (
            const participant of
            data.participants
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

        setLocalAuctionState(
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

        console.log(
          "[Auction STATE]",
          nextState
        );
      }
    );

    /* =====================================================
       PARTICIPANTS FROM SERVER
       ===================================================== */

    socket.on(
      "auction:participants",
      data => {

        if (
          data?.version !==
            undefined &&
          Number(data.version) <
            Number(state.version)
        ) {

          return;
        }

        if (
          data?.version !==
          undefined
        ) {

          state.version =
            Number(data.version);
        }

        state.participants.clear();

        for (
          const participant of
          data?.participants || []
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

    /* =====================================================
       GIFT
       ===================================================== */

    socket.on(
      "live:gift",
      gift => {

        /*
         * PENTING:
         *
         * Jangan menambah coin di sini.
         *
         * Server sudah mengubah
         * participant dan mengirim
         * auction:participants.
         *
         * Kalau ditambah lagi di sini,
         * coin bisa menjadi double.
         */

        if (
          state.auction !==
          "running"
        ) {

          return;
        }

        /*
         * Update hanya jika server
         * menyertakan participant.
         */

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

        /*
         * Hanya console.
         * Tidak ada popup/notifikasi
         * di layar.
         */

        console.log(
          `[GIFT] ${gift?.username || "Viewer"} +${gift?.coinValue || 0}`
        );
      }
    );

    /* =====================================================
       CLICK HANDLERS
       ===================================================== */

    if (
      btnConnect
    ) {

      btnConnect.addEventListener(
        "click",
        event => {

          event.preventDefault();
          event.stopPropagation();

          connectTikTok();
        }
      );
    }

    if (
      btnStart
    ) {

      btnStart.addEventListener(
        "click",
        event => {

          event.preventDefault();
          event.stopPropagation();

          startAuction();
        }
      );
    }

    if (
      btnPause
    ) {

      btnPause.addEventListener(
        "click",
        event => {

          event.preventDefault();
          event.stopPropagation();

          pauseAuction();
        }
      );
    }

    if (
      btnReset
    ) {

      btnReset.addEventListener(
        "click",
        event => {

          event.preventDefault();
          event.stopPropagation();

          resetAuction();
        }
      );
    }

    if (
      btnFinish
    ) {

      btnFinish.addEventListener(
        "click",
        event => {

          event.preventDefault();
          event.stopPropagation();

          finishAuction();
        }
      );
    }

    /* =====================================================
       INITIAL STATE
       ===================================================== */

    state.initialTimer =
      readInitialTimer();

    state.timer =
      state.initialTimer;

    state.extraTime =
      readExtraTime();

    state.extraUsed =
      0;

    state.auction =
      "idle";

    renderTimer();

    renderParticipants();

    updateButtons();

    /* =====================================================
       COMPATIBILITY API
       ===================================================== */

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

      getState:
        () => ({
          ...state,

          participants:
            Array.from(
              state.participants.values()
            )
        })
    };

    console.log(
      "[Auction] APP.JS siap."
    );
  }

  /* =======================================================
     DOM READY
     ======================================================= */

  if (
    document.readyState ===
    "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      initCoinAuction,
      {
        once: true
      }
    );

  } else {

    initCoinAuction();
  }

})();
