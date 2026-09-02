/* =========================================================
   LIVE COIN AUCTION - APP.JS FINAL
   Tombol:
   Hubungkan TikTok
   Mulai
   Pause
   Reset
   Selesai

   RULE:
   - MULAI   = gift masuk
   - PAUSE   = gift berhenti
   - SELESAI = gift berhenti, peserta tetap
   - RESET   = peserta dikosongkan
   ========================================================= */

(() => {
  "use strict";

  /* =======================================================
     DOM READY
     ======================================================= */

  function init() {

    console.log("[APP] Coin Auction starting...");

    /* =====================================================
       SOCKET.IO
       ===================================================== */

    if (typeof window.io !== "function") {
      console.error("[APP] Socket.IO tidak ditemukan.");
      return;
    }

    const socket = window.io({
      transports: ["websocket", "polling"]
    });

    /* =====================================================
       STATE
       ===================================================== */

    const state = {
      auction: "idle",
      participants: new Map(),

      timer: 300,
      initialTimer: 300,

      timerInterval: null,

      extraTime: 0,
      extraUsed: 0,

      version: 0
    };

    /* =====================================================
       SELECTOR
       ===================================================== */

    function $(selectors) {

      for (const selector of selectors) {

        const element =
          document.querySelector(selector);

        if (element) {
          return element;
        }
      }

      return null;
    }

    /* =====================================================
       FIND BUTTON BY TEXT
       ===================================================== */

    function findButton(words) {

      const elements =
        Array.from(
          document.querySelectorAll(
            "button, input[type='button'], input[type='submit'], [role='button']"
          )
        );

      for (const element of elements) {

        const text =
          String(
            element.textContent ||
            element.value ||
            ""
          )
            .trim()
            .toLowerCase();

        if (
          words.some(word =>
            text.includes(
              word.toLowerCase()
            )
          )
        ) {
          return element;
        }
      }

      return null;
    }

    /* =====================================================
       INPUT USERNAME
       ===================================================== */

    const usernameInput =
      $([
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
      $([
        "#connectTikTok",
        "#connectBtn",
        "#btnConnect",
        "#hubungkanTikTok",
        "#btnHubungkan",
        "[data-action='connect']"
      ]) ||
      findButton([
        "hubungkan tiktok",
        "hubungkan"
      ]);

    const btnStart =
      $([
        "#startAuction",
        "#startBtn",
        "#btnStart",
        "#btnMulai",
        "#mulaiAuction",
        "[data-action='start']"
      ]) ||
      findButton([
        "mulai"
      ]);

    const btnPause =
      $([
        "#pauseAuction",
        "#pauseBtn",
        "#btnPause",
        "#btnJeda",
        "[data-action='pause']"
      ]) ||
      findButton([
        "pause",
        "jeda"
      ]);

    const btnReset =
      $([
        "#resetAuction",
        "#resetBtn",
        "#btnReset",
        "[data-action='reset']"
      ]) ||
      findButton([
        "reset"
      ]);

    const btnFinish =
      $([
        "#finishAuction",
        "#finishBtn",
        "#btnFinish",
        "#btnSelesai",
        "[data-action='finish']"
      ]) ||
      findButton([
        "selesai",
        "finish"
      ]);

    /* =====================================================
       DISPLAY
       ===================================================== */

    const timerEl =
      $([
        "#timer",
        "#auctionTimer",
        "#countdown",
        "[data-role='timer']"
      ]);

    const participantCountEl =
      $([
        "#participantCount",
        "#participantsCount",
        "#participant-count",
        "[data-role='participant-count']"
      ]);

    const participantList =
      $([
        "#participants",
        "#participantList",
        "#participantsList",
        ".participants-list",
        "[data-role='participants']"
      ]);

    const statusEl =
      $([
        "#connectionStatus",
        "#liveStatus",
        "#status",
        "#tiktokStatus",
        "[data-role='live-status']"
      ]);

    const minutesInput =
      $([
        "#minutes",
        "#auctionMinutes",
        "#menit",
        "input[name='minutes']"
      ]);

    const secondsInput =
      $([
        "#seconds",
        "#auctionSeconds",
        "#detik",
        "input[name='seconds']"
      ]);

    const extraInput =
      $([
        "#extraSeconds",
        "#extraTimeSeconds",
        "#extraTimeInput",
        "input[name='extraTime']"
      ]);

    /* =====================================================
       FORCE BUTTON ACTIVE
       ===================================================== */

    const allButtons = [
      btnConnect,
      btnStart,
      btnPause,
      btnReset,
      btnFinish
    ].filter(Boolean);

    for (const button of allButtons) {

      /*
       * Jangan biarkan HTML/CSS sebelumnya
       * mematikan tombol.
       */

      button.disabled = false;

      button.removeAttribute("disabled");

      button.style.pointerEvents =
        "auto";

      button.style.touchAction =
        "manipulation";

      button.style.cursor =
        "pointer";

      /*
       * Animasi tekan.
       */

      button.style.transition =
        "transform 0.08s ease, opacity 0.08s ease";

      button.addEventListener(
        "pointerdown",
        () => {

          button.style.transform =
            "scale(0.96)";

          button.style.opacity =
            "0.78";
        }
      );

      button.addEventListener(
        "pointerup",
        () => {

          button.style.transform =
            "scale(1)";

          button.style.opacity =
            "1";
        }
      );

      button.addEventListener(
        "pointercancel",
        () => {

          button.style.transform =
            "scale(1)";

          button.style.opacity =
            "1";
        }
      );

      button.addEventListener(
        "pointerleave",
        () => {

          button.style.transform =
            "scale(1)";

          button.style.opacity =
            "1";
        }
      );
    }

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
       TIMER
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
        Math.floor(
          minutes * 60 +
          seconds
        );

      if (total > 0) {
        return total;
      }

      return 300;
    }

    function formatTime(total) {

      total =
        Math.max(
          0,
          Math.floor(total)
        );

      const minutes =
        Math.floor(
          total / 60
        );

      const seconds =
        total % 60;

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

    /* =====================================================
       TIMER RUNNING
       ===================================================== */

    function startTimer() {

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

            clearTimer();

            /*
             * TIMER HABIS
             *
             * Selesai otomatis.
             * Peserta TIDAK dihapus.
             */

            state.auction =
              "finished";

            socket.emit(
              "auction:state",
              {
                state: "finished"
              }
            );

            renderTimer();

            console.log(
              "[AUCTION] Waktu habis."
            );
          },
          1000
        );
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
       ESCAPE
       ===================================================== */

    function escapeHtml(value) {

      return String(
        value ?? ""
      ).replace(
        /[&<>'"]/g,
        char => {

          const map = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
          };

          return map[char];
        }
      );
    }

    /* =====================================================
       PARTICIPANTS
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
            Number(a.coins || 0)
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

            let avatarHtml =
              "";

            if (
              p.avatar
            ) {

              avatarHtml =
                `
                <img
                  class="participant-avatar"
                  src="${escapeHtml(p.avatar)}"
                  alt=""
                >
                `;

            } else {

              avatarHtml =
                `
                <div class="participant-avatar participant-initial">
                  ${escapeHtml(
                    (
                      p.nickname ||
                      p.username ||
                      "V"
                    )
                      .charAt(0)
                      .toUpperCase()
                  )}
                </div>
                `;
            }

            return `
              <div
                class="participant-row"
                data-user-id="${escapeHtml(
                  participantKey(p)
                )}"
              >

                <div class="participant-rank">
                  ${index + 1}
                </div>

                ${avatarHtml}

                <div class="participant-info">

                  <div class="participant-name">
                    ${nickname}
                  </div>

                  <div class="participant-username">
                    @${username}
                  </div>

                </div>

                <div class="participant-coins">
                  🪙 ${coins}
                </div>

              </div>
            `;
          }
        ).join("");
    }

    /* =====================================================
       CONNECT TIKTOK
       ===================================================== */

    function connectTikTok() {

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

      if (
        !username
      ) {

        if (statusEl) {

          statusEl.textContent =
            "Masukkan username TikTok terlebih dahulu.";
        }

        console.warn(
          "[TikTok] Username kosong."
        );

        return;
      }

      if (statusEl) {

        statusEl.textContent =
          `Menghubungkan ke @${username}...`;
      }

      socket.emit(
        "live:connect",
        {
          username
        }
      );

      console.log(
        `[TikTok] Connecting @${username}`
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
       * Kalau dari PAUSE,
       * lanjutkan waktu yang tersisa.
       *
       * Kalau IDLE / FINISHED,
       * mulai timer baru.
       */

      if (
        state.auction !==
          "paused" ||
        state.timer <= 0
      ) {

        state.initialTimer =
          readInitialTimer();

        state.timer =
          state.initialTimer;
      }

      state.auction =
        "running";

      renderTimer();

      socket.emit(
        "auction:state",
        {
          state: "running"
        }
      );

      startTimer();

      console.log(
        "[AUCTION] ▶ MULAI"
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

        console.log(
          "[AUCTION] Pause diabaikan karena belum running."
        );

        return;
      }

      clearTimer();

      state.auction =
        "paused";

      socket.emit(
        "auction:state",
        {
          state: "paused"
        }
      );

      console.log(
        "[AUCTION] || PAUSE"
      );
    }

    /* =====================================================
       RESET
       ===================================================== */

    function resetAuction() {

      clearTimer();

      /*
       * RESET = HAPUS PESERTA
       */

      state.participants.clear();

      state.initialTimer =
        readInitialTimer();

      state.timer =
        state.initialTimer;

      state.extraUsed =
        0;

      state.auction =
        "idle";

      renderTimer();

      renderParticipants();

      socket.emit(
        "auction:reset"
      );

      console.log(
        "[AUCTION] ↻ RESET - peserta dihapus"
      );
    }

    /* =====================================================
       SELESAI
       ===================================================== */

    function finishAuction() {

      clearTimer();

      /*
       * JANGAN clear participants.
       *
       * Peserta dan koin tetap.
       */

      state.auction =
        "finished";

      socket.emit(
        "auction:state",
        {
          state: "finished"
        }
      );

      renderParticipants();

      console.log(
        "[AUCTION] ■ SELESAI - peserta tetap"
      );
    }

    /* =====================================================
       SOCKET CONNECT
       ===================================================== */

    socket.on(
      "connect",
      () => {

        console.log(
          "[SOCKET] Terhubung:",
          socket.id
        );
      }
    );

    /* =====================================================
       SOCKET DISCONNECT
       ===================================================== */

    socket.on(
      "disconnect",
      () => {

        console.warn(
          "[SOCKET] Terputus."
        );
      }
    );

    /* =====================================================
       LIVE STATUS
       ===================================================== */

    socket.on(
      "live:status",
      data => {

        console.log(
          "[TIKTOK STATUS]",
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
       LIVE ERROR
       ===================================================== */

    socket.on(
      "live:error",
      data => {

        console.error(
          "[TIKTOK ERROR]",
          data
        );

        if (
          statusEl
        ) {

          statusEl.textContent =
            data?.message ||
            "Gagal menghubungkan TikTok.";
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

        state.auction =
          nextState;

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

        if (
          nextState ===
          "running"
        ) {

          startTimer();

        } else {

          clearTimer();
        }

        console.log(
          "[AUCTION STATE]",
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
      }
    );

    /* =====================================================
       GIFT
       ===================================================== */

    socket.on(
      "live:gift",
      gift => {

        /*
         * Jangan hitung coin di sini.
         *
         * Server sudah menghitung.
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

        console.log(
          `[GIFT] +${gift?.coinValue || 0} coin`
        );
      }
    );

    /* =====================================================
       BUTTON EVENTS
       ===================================================== */

    if (btnConnect) {

      btnConnect.onclick =
        null;

      btnConnect.addEventListener(
        "click",
        event => {

          event.preventDefault();

          connectTikTok();
        }
      );
    }

    if (btnStart) {

      btnStart.onclick =
        null;

      btnStart.addEventListener(
        "click",
        event => {

          event.preventDefault();

          startAuction();
        }
      );
    }

    if (btnPause) {

      btnPause.onclick =
        null;

      btnPause.addEventListener(
        "click",
        event => {

          event.preventDefault();

          pauseAuction();
        }
      );
    }

    if (btnReset) {

      btnReset.onclick =
        null;

      btnReset.addEventListener(
        "click",
        event => {

          event.preventDefault();

          resetAuction();
        }
      );
    }

    if (btnFinish) {

      btnFinish.onclick =
        null;

      btnFinish.addEventListener(
        "click",
        event => {

          event.preventDefault();

          finishAuction();
        }
      );
    }

    /* =====================================================
       INITIAL
       ===================================================== */

    state.initialTimer =
      readInitialTimer();

    state.timer =
      state.initialTimer;

    renderTimer();

    renderParticipants();

    console.log(
      "[APP] BUTTON STATUS:",
      {
        connect: !!btnConnect,
        start: !!btnStart,
        pause: !!btnPause,
        reset: !!btnReset,
        finish: !!btnFinish
      }
    );

    /* =====================================================
       COMPATIBILITY
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
          auction:
            state.auction,

          timer:
            state.timer,

          participants:
            Array.from(
              state.participants.values()
            )
        })
    };

    console.log(
      "[APP] READY."
    );
  }

  /* =======================================================
     WAIT FOR HTML
     ======================================================= */

  if (
    document.readyState ===
    "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      init,
      {
        once: true
      }
    );

  } else {

    init();
  }

})();
