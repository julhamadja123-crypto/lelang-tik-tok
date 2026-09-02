/* =========================================================
   LIVE COIN AUCTION - APP.JS FINAL
   =========================================================

   FITUR:

   HUBUNGKAN TIKTOK
   MULAI
   PAUSE
   RESET
   SELESAI
   SIMPAN PENGATURAN

   ATURAN LELANG:

   IDLE
      Gift tidak masuk

   RUNNING
      Gift masuk

   PAUSED
      Gift tidak masuk

   FINISHED
      Gift tidak masuk
      Peserta tetap
      Koin tetap

   RESET
      Peserta dihapus
      Koin dihapus
      Timer kembali ke pengaturan

   ========================================================= */

(() => {

  "use strict";


  /* =======================================================
     START APP SETELAH HTML SIAP
     ======================================================= */

  function init() {

    console.log(
      "[APP] Coin Auction App dimulai..."
    );


    /* =====================================================
       SOCKET.IO
       ===================================================== */

    if (
      typeof window.io !== "function"
    ) {

      console.error(
        "[APP] Socket.IO tidak ditemukan."
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
        0,

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

    function $(selectors) {

      for (
        const selector
        of selectors
      ) {

        const element =
          document.querySelector(
            selector
          );

        if (element) {

          return element;
        }
      }

      return null;
    }


    /* =====================================================
       SELECT MANY
       ===================================================== */

    function $$(selectors) {

      for (
        const selector
        of selectors
      ) {

        const elements =
          document.querySelectorAll(
            selector
          );

        if (
          elements.length
        ) {

          return Array.from(
            elements
          );
        }
      }

      return [];
    }


    /* =====================================================
       CARI BUTTON BERDASARKAN TEKS
       ===================================================== */

    function findButton(
      words
    ) {

      const elements =
        Array.from(
          document.querySelectorAll(
            "button, [role='button'], input[type='button'], input[type='submit']"
          )
        );

      for (
        const element
        of elements
      ) {

        const text =
          String(
            element.textContent ||
            element.value ||
            ""
          )
            .trim()
            .toLowerCase();

        for (
          const word
          of words
        ) {

          if (
            text.includes(
              word.toLowerCase()
            )
          ) {

            return element;
          }
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
       INPUT PENGATURAN
       ===================================================== */

    const titleInput =
      $([
        "#auctionTitle",
        "#titleAuction",
        "#judulLelang",
        "textarea[name='auctionTitle']",
        "textarea[name='title']",
        "input[name='auctionTitle']",
        "input[name='title']"
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
        "#extraTime",
        "input[name='extraTime']"
      ]);


    /* =====================================================
       BUTTON UTAMA
       ===================================================== */

    const connectButton =
      $([
        "#connectTikTok",
        "#connectBtn",
        "#btnConnect",
        "#btnHubungkan",
        "#hubungkanTikTok",
        "button[data-action='connect']"
      ]) ||
      findButton([
        "hubungkan tiktok",
        "hubungkan"
      ]);


    const startButton =
      $([
        "#startAuction",
        "#startBtn",
        "#btnStart",
        "#btnMulai",
        "#mulaiAuction",
        "button[data-action='start']"
      ]) ||
      findButton([
        "mulai"
      ]);


    const pauseButton =
      $([
        "#pauseAuction",
        "#pauseBtn",
        "#btnPause",
        "#btnJeda",
        "button[data-action='pause']"
      ]) ||
      findButton([
        "pause",
        "jeda"
      ]);


    const resetButton =
      $([
        "#resetAuction",
        "#resetBtn",
        "#btnReset",
        "button[data-action='reset']"
      ]) ||
      findButton([
        "reset"
      ]);


    const finishButton =
      $([
        "#finishAuction",
        "#finishBtn",
        "#btnFinish",
        "#btnSelesai",
        "button[data-action='finish']"
      ]) ||
      findButton([
        "selesai",
        "finish"
      ]);


    /* =====================================================
       SIMPAN PENGATURAN
       ===================================================== */

    const saveSettingsButton =
      $([
        "#saveSettings",
        "#saveSettingsBtn",
        "#btnSaveSettings",
        "#simpanPengaturan",
        "#btnSimpanPengaturan",
        "button[data-action='save-settings']"
      ]) ||
      findButton([
        "simpan pengaturan",
        "simpan"
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


    const extraTimeEl =
      $([
        "#extraTimeAvailable",
        "#extraTimeDisplay",
        "[data-role='extra-time']"
      ]);


    /* =====================================================
       JUDUL YANG DITAMPILKAN
       ===================================================== */

    const titleDisplay =
      $([
        "#auctionTitleDisplay",
        "#displayAuctionTitle",
        "#auctionTitleText",
        "#displayTitle",
        "#judulLelangDisplay",
        "[data-role='auction-title']"
      ]);


    /* =====================================================
       SEMUA BUTTON
       ===================================================== */

    const buttons = [

      connectButton,
      startButton,
      pauseButton,
      resetButton,
      finishButton,
      saveSettingsButton

    ].filter(Boolean);


    /* =====================================================
       FORCE BUTTON ACTIVE
       ===================================================== */

    buttons.forEach(
      button => {

        /*
         * JANGAN biarkan HTML lama
         * mematikan tombol.
         */

        button.disabled =
          false;

        button.removeAttribute(
          "disabled"
        );

        button.removeAttribute(
          "aria-disabled"
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

        button.style.transition =
          "transform 0.08s ease, opacity 0.08s ease";


        /* =================================================
           ANIMASI TEKAN
           ================================================= */

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
    );


    /* =====================================================
       ANGKA
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
       PARSE TIMER
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
        Number(match[1]) *
          60 +
        Number(match[2])
      );
    }


    /* =====================================================
       BACA DURASI
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


      if (
        total > 0
      ) {

        return total;
      }


      const current =
        parseTimerText(
          timerEl?.textContent ||
          ""
        );


      if (
        current > 0
      ) {

        return current;
      }


      return 300;
    }


    /* =====================================================
       BACA EXTRA TIME
       ===================================================== */

    function readExtraTime() {

      const value =
        num(
          extraInput?.value,
          0
        );


      if (
        value > 0
      ) {

        return Math.floor(
          value
        );
      }


      if (
        extraTimeEl
      ) {

        const text =
          extraTimeEl.textContent ||
          "";

        const match =
          text.match(
            /(\d+)\s*:?\s*(\d+)?/
          );


        if (
          match
        ) {

          if (
            match[2]
          ) {

            return (
              Number(match[1]) *
                60 +
              Number(match[2])
            );
          }


          return Number(
            match[1]
          );
        }
      }


      return 0;
    }


    /* =====================================================
       FORMAT WAKTU
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
          (total % 3600) /
          60
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

      if (
        timerEl
      ) {

        timerEl.textContent =
          formatTime(
            state.timer
          );
      }
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
       START TIMER LOCAL
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

            /*
             * Kalau Pause / Selesai,
             * timer berhenti.
             */

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


              /* =========================================
                 WAKTU UTAMA HABIS
                 ========================================= */

              if (
                state.timer <= 0
              ) {

                /*
                 * Jika Extra Time tersedia,
                 * jalankan otomatis.
                 */

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


                  console.log(
                    `[AUCTION] Extra Time +${available} detik`
                  );

                } else {

                  /*
                   * Waktu benar-benar selesai.
                   *
                   * PESERTA TIDAK DIHAPUS.
                   */

                  clearTimer();


                  state.auction =
                    "finished";


                  socket.emit(
                    "auction:state",
                    {
                      state:
                        "finished"
                    }
                  );


                  console.log(
                    "[AUCTION] Waktu habis - selesai."
                  );
                }
              }

            }

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

        participant.uniqueId ||

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
        char => {

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
            char
          ];
        }
      );
    }


    function escapeAttr(
      value
    ) {

      return escapeHtml(
        value
      );
    }


    /* =====================================================
       RENDER PESERTA
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
          (a, b) => {

            const coinA =
              num(
                a.coins,
                0
              );

            const coinB =
              num(
                b.coins,
                0
              );


            if (
              coinB !==
              coinA
            ) {

              return (
                coinB -
                coinA
              );
            }


            return (
              num(
                a.joinedAt,
                0
              ) -
              num(
                b.joinedAt,
                0
              )
            );
          }
        );


      /* ===================================================
         KOSONG
         =================================================== */

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


      /* ===================================================
         PESERTA
         =================================================== */

      participantList.innerHTML =
        list
          .map(
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


              const coins =
                num(
                  participant.coins,
                  0
                );


              let avatar =
                "";


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

                avatar =
                  `
                  <div
                    class="participant-avatar participant-initial"
                  >
                    ${escapeHtml(
                      (
                        participant.nickname ||
                        participant.username ||
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
                  data-user-id="${escapeAttr(
                    participantKey(
                      participant
                    )
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
                    🪙 ${coins}
                  </div>

                </div>
              `;
            }
          )
          .join("");
    }


    /* =====================================================
       UPDATE JUDUL
       ===================================================== */

    function renderTitle() {

      if (
        !titleDisplay
      ) {

        return;
      }


      const title =
        String(
          titleInput?.value ||
          ""
        ).trim();


      if (
        title
      ) {

        titleDisplay.textContent =
          title;
      }
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

        if (
          statusEl
        ) {

          statusEl.textContent =
            "Masukkan username TikTok terlebih dahulu.";
        }


        console.warn(
          "[TikTok] Username kosong."
        );


        return;
      }


      if (
        statusEl
      ) {

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
        `[TikTok] Menghubungkan @${username}`
      );
    }


    /* =====================================================
       MULAI
       ===================================================== */

    function startAuction() {

      /*
       * Kalau sudah running,
       * jangan membuat timer kedua.
       */

      if (
        state.auction ===
        "running"
      ) {

        return;
      }


      /*
       * Kalau dari PAUSE,
       * lanjutkan timer.
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


        state.extraTime =
          readExtraTime();


        state.extraUsed =
          0;
      }


      /*
       * Kalau dari pause,
       * tetap gunakan Extra Time
       * yang sudah ada.
       */

      if (
        state.extraTime <= 0
      ) {

        state.extraTime =
          readExtraTime();
      }


      state.auction =
        "running";


      renderTimer();


      startLocalTimer();


      socket.emit(
        "auction:state",
        {
          state:
            "running"
        }
      );


      console.log(
        "[AUCTION] ▶ MULAI"
      );
    }


    /* =====================================================
       PAUSE
       ===================================================== */

    function pauseAuction() {

      /*
       * Tombol tetap bisa ditekan.
       *
       * Tetapi kalau belum running,
       * tidak melakukan apa-apa.
       */

      if (
        state.auction !==
        "running"
      ) {

        console.log(
          "[AUCTION] Pause diabaikan - belum running."
        );

        return;
      }


      clearTimer();


      state.auction =
        "paused";


      socket.emit(
        "auction:state",
        {
          state:
            "paused"
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
       * RESET:
       *
       * HAPUS SEMUA PESERTA
       * HAPUS SEMUA KOIN
       */

      state.participants.clear();


      /*
       * Timer kembali ke
       * pengaturan.
       */

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
       * Beritahu server.
       */

      socket.emit(
        "auction:reset"
      );


      console.log(
        "[AUCTION] ↻ RESET - peserta dikosongkan"
      );
    }


    /* =====================================================
       SELESAI
       ===================================================== */

    function finishAuction() {

      clearTimer();


      /*
       * PENTING:
       *
       * JANGAN:
       *
       * state.participants.clear()
       *
       * Karena peserta harus tetap
       * terlihat setelah selesai.
       */

      state.auction =
        "finished";


      socket.emit(
        "auction:state",
        {
          state:
            "finished"
        }
      );


      renderParticipants();


      console.log(
        "[AUCTION] ■ SELESAI - peserta tetap"
      );
    }


    /* =====================================================
       SIMPAN PENGATURAN
       ===================================================== */

    const SETTINGS_KEY =
      "coinAuctionSettings";


    function saveSettings() {

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


      /* =================================================
         SIMPAN KE LOCAL STORAGE
         ================================================= */

      try {

        localStorage.setItem(
          SETTINGS_KEY,
          JSON.stringify(
            settings
          )
        );

      } catch (
        error
      ) {

        console.error(
          "[SETTINGS] Gagal menyimpan:",
          error
        );
      }


      /* =================================================
         UPDATE STATE
         ================================================= */

      state.initialTimer =
        Math.max(
          0,
          minutes * 60 +
          seconds
        );


      state.extraTime =
        extraTime;


      state.extraUsed =
        0;


      /*
       * Jangan mengubah timer
       * ketika lelang sedang berjalan.
       *
       * Pengaturan baru akan
       * dipakai pada lelang berikutnya.
       */

      if (
        state.auction ===
          "idle" ||
        state.auction ===
          "finished"
      ) {

        state.timer =
          state.initialTimer;
      }


      renderTimer();


      renderTitle();


      /* =================================================
         FEEDBACK TOMBOL
         ================================================= */

      if (
        saveSettingsButton
      ) {

        const originalText =
          saveSettingsButton.textContent;


        saveSettingsButton.style.transform =
          "scale(0.96)";


        saveSettingsButton.style.opacity =
          "0.78";


        setTimeout(
          () => {

            saveSettingsButton.style.transform =
              "scale(1)";

            saveSettingsButton.style.opacity =
              "1";

          },
          100
        );


        saveSettingsButton.textContent =
          "✓ Pengaturan Tersimpan";


        setTimeout(
          () => {

            saveSettingsButton.textContent =
              originalText ||
              "Simpan Pengaturan";

          },
          1500
        );
      }


      console.log(
        "[SETTINGS] Pengaturan tersimpan:",
        settings
      );
    }


    /* =====================================================
       LOAD PENGATURAN
       ===================================================== */

    function loadSettings() {

      try {

        const raw =
          localStorage.getItem(
            SETTINGS_KEY
          );


        if (
          !raw
        ) {

          return;
        }


        const settings =
          JSON.parse(
            raw
          );


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


        console.log(
          "[SETTINGS] Pengaturan dimuat."
        );

      } catch (
        error
      ) {

        console.warn(
          "[SETTINGS] Gagal membaca:",
          error
        );
      }
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
      reason => {

        console.warn(
          "[SOCKET] Terputus:",
          reason
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
       TIKTOK ERROR
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
       AUCTION STATE DARI SERVER
       ===================================================== */

    socket.on(
      "auction:state",
      data => {

        console.log(
          "[SERVER AUCTION STATE]",
          data
        );


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
          num(
            data.version,
            0
          ) <
            state.version
        ) {

          return;
        }


        if (
          data?.version !==
            undefined
        ) {

          state.version =
            num(
              data.version,
              state.version
            );
        }


        state.auction =
          nextState;


        /*
         * Kalau server mengirim
         * participant snapshot.
         */

        if (
          Array.isArray(
            data?.participants
          )
        ) {

          state.participants.clear();


          for (
            const participant
            of data.participants
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


        /*
         * RUNNING = timer jalan.
         */

        if (
          nextState ===
          "running"
        ) {

          startLocalTimer();

        } else {

          /*
           * PAUSED / FINISHED / IDLE
           */

          clearTimer();
        }
      }
    );


    /* =====================================================
       PARTICIPANTS DARI SERVER
       ===================================================== */

    socket.on(
      "auction:participants",
      data => {

        if (
          data?.version !==
            undefined &&
          num(
            data.version,
            0
          ) <
            state.version
        ) {

          return;
        }


        if (
          data?.version !==
            undefined
        ) {

          state.version =
            num(
              data.version,
              state.version
            );
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


    /* =====================================================
       LIVE GIFT
       ===================================================== */

    socket.on(
      "live:gift",
      gift => {

        /*
         * Server sudah memastikan
         * gift hanya diterima ketika
         * auction = running.
         *
         * Frontend TIDAK menghitung
         * coin lagi.
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
          `[GIFT] ${
            gift?.username ||
            "Viewer"
          } +${
            gift?.coinValue ||
            0
          } coin`
        );
      }
    );


    /* =====================================================
       BUTTON: HUBUNGKAN TIKTOK
       ===================================================== */

    if (
      connectButton
    ) {

      connectButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          connectTikTok();
        }
      );
    }


    /* =====================================================
       BUTTON: MULAI
       ===================================================== */

    if (
      startButton
    ) {

      startButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          startAuction();
        }
      );
    }


    /* =====================================================
       BUTTON: PAUSE
       ===================================================== */

    if (
      pauseButton
    ) {

      pauseButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          pauseAuction();
        }
      );
    }


    /* =====================================================
       BUTTON: RESET
       ===================================================== */

    if (
      resetButton
    ) {

      resetButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          resetAuction();
        }
      );
    }


    /* =====================================================
       BUTTON: SELESAI
       ===================================================== */

    if (
      finishButton
    ) {

      finishButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          finishAuction();
        }
      );
    }


    /* =====================================================
       BUTTON: SIMPAN PENGATURAN
       ===================================================== */

    if (
      saveSettingsButton
    ) {

      saveSettingsButton.disabled =
        false;


      saveSettingsButton.removeAttribute(
        "disabled"
      );


      saveSettingsButton.style.pointerEvents =
        "auto";


      saveSettingsButton.style.touchAction =
        "manipulation";


      saveSettingsButton.style.cursor =
        "pointer";


      saveSettingsButton.addEventListener(
        "click",
        event => {

          event.preventDefault();

          event.stopPropagation();

          saveSettings();
        }
      );

    } else {

      console.warn(
        "[SETTINGS] Tombol Simpan Pengaturan tidak ditemukan."
      );
    }


    /* =====================================================
       LOAD SETTINGS AWAL
       ===================================================== */

    loadSettings();


    /* =====================================================
       INITIAL TIMER
       ===================================================== */

    state.initialTimer =
      readInitialTimer();


    state.timer =
      state.initialTimer;


    state.extraTime =
      readExtraTime();


    state.extraUsed =
      0;


    renderTimer();


    renderTitle();


    renderParticipants();


    /* =====================================================
       DEBUG BUTTON
       ===================================================== */

    console.log(
      "[APP] Tombol ditemukan:",
      {
        connect:
          !!connectButton,

        start:
          !!startButton,

        pause:
          !!pauseButton,

        reset:
          !!resetButton,

        finish:
          !!finishButton,

        saveSettings:
          !!saveSettingsButton
      }
    );


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

      saveSettings:
        saveSettings,

      getState:
        () => ({

          auction:
            state.auction,

          timer:
            state.timer,

          initialTimer:
            state.initialTimer,

          extraTime:
            state.extraTime,

          participants:
            Array.from(
              state.participants.values()
            )
        })
    };


    console.log(
      "[APP] Coin Auction READY."
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
      init,
      {
        once: true
      }
    );

  } else {

    init();
  }

})();
