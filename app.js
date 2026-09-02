/* =========================================================
   COIN AUCTION - CLIENT / APP.JS
   Sinkron dengan server.js final
   ========================================================= */

(() => {
  "use strict";

  const socket =
    window.io();

  const state = {
    auction: "idle",
    participants: new Map(),

    timer: 0,
    initialTimer: 0,

    timerInterval:
      null,

    extraTime: 0,
    extraUsed: 0,

    version: 0
  };

  const $ =
    (selectors) => {
      for (
        const selector
        of selectors
      ) {
        const el =
          document.querySelector(
            selector
          );

        if (el) return el;
      }

      return null;
    };

  const $$ =
    (selectors) => {
      for (
        const selector
        of selectors
      ) {
        const els =
          document.querySelectorAll(
            selector
          );

        if (els.length) {
          return Array.from(
            els
          );
        }
      }

      return [];
    };

  const usernameInput =
    $([
      "#username",
      "#tiktokUsername",
      "#tiktok-username",
      "input[name='username']",
      "input[placeholder*='username' i]"
    ]);

  const connectButton =
    $([
      "#connectTikTok",
      "#connectBtn",
      "#btnConnect",
      "button[data-action='connect']"
    ]);

  const startButton =
    $([
      "#startAuction",
      "#startBtn",
      "#btnStart",
      "button[data-action='start']"
    ]);

  const pauseButton =
    $([
      "#pauseAuction",
      "#pauseBtn",
      "#btnPause",
      "button[data-action='pause']"
    ]);

  const resetButton =
    $([
      "#resetAuction",
      "#resetBtn",
      "#btnReset",
      "button[data-action='reset']"
    ]);

  const finishButton =
    $([
      "#finishAuction",
      "#finishBtn",
      "#btnFinish",
      "button[data-action='finish']"
    ]);

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

  const extraTimeEl =
    $([
      "#extraTime",
      "#extraTimeAvailable",
      "[data-role='extra-time']"
    ]);

  const titleInput =
    $([
      "#auctionTitle",
      "#titleAuction",
      "#judulLelang",
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
      "input[name='extraTime']"
    ]);

  function textButton(
    label
  ) {
    const wanted =
      label.toLowerCase();

    return $([
      "button",
      "[role='button']"
    ]).find(
      el =>
        (
          el.textContent ||
          ""
        )
          .trim()
          .toLowerCase()
          .includes(wanted)
    );
  }

  const btnStart =
    startButton ||
    textButton("mulai");

  const btnPause =
    pauseButton ||
    textButton("pause");

  const btnReset =
    resetButton ||
    textButton("reset");

  const btnFinish =
    finishButton ||
    textButton("selesai");

  const btnConnect =
    connectButton ||
    textButton(
      "hubungkan tiktok"
    );

  function num(
    v,
    fallback = 0
  ) {
    const n =
      Number(v);

    return Number.isFinite(n)
      ? n
      : fallback;
  }

  function readInitialTimer() {
    const m =
      num(
        minutesInput?.value,
        0
      );

    const s =
      num(
        secondsInput?.value,
        0
      );

    const total =
      Math.max(
        0,
        Math.floor(
          m * 60 + s
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
    const v =
      num(
        extraInput?.value,
        0
      );

    if (v > 0) {
      return Math.floor(v);
    }

    const text =
      extraTimeEl
        ?.textContent ||
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
        Number(match[1]) *
          60 +
        Number(match[2])
      );
    }

    return Number(
      match[1]
    );
  }

  function parseTimerText(
    text
  ) {
    const match =
      String(text).match(
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

  function formatTime(
    total
  ) {
    total =
      Math.max(
        0,
        Math.floor(total)
      );

    const h =
      Math.floor(
        total / 3600
      );

    const m =
      Math.floor(
        (total % 3600) /
        60
      );

    const s =
      total % 60;

    if (h > 0) {
      return (
        `${String(h).padStart(2, "0")}:` +
        `${String(m).padStart(2, "0")}:` +
        `${String(s).padStart(2, "0")}`
      );
    }

    return (
      `${String(m).padStart(2, "0")}:` +
      `${String(s).padStart(2, "0")}`
    );
  }

  function renderTimer() {
    if (timerEl) {
      timerEl.textContent =
        formatTime(
          state.timer
        );
    }
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

  function setAuctionState(
    next,
    options = {}
  ) {
    state.auction =
      next;

    if (
      typeof options.timer ===
      "number"
    ) {
      state.timer =
        Math.max(
          0,
          Math.floor(
            options.timer
          )
        );
    }

    renderTimer();
    updateButtons();
  }

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

            if (
              state.timer <=
              0
            ) {
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

              } else {
                clearTimer();

                setAuctionState(
                  "finished"
                );

                socket.emit(
                  "auction:state",
                  {
                    state:
                      "finished"
                  }
                );
              }
            }
          }
        },
        1000
      );
  }

  function sendAuctionState(
    next
  ) {
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
      readInitialTimer();

    state.timer =
      state.timer > 0 &&
      state.auction ===
        "paused"
        ? state.timer
        : state.initialTimer;

    state.extraTime =
      readExtraTime();

    state.extraUsed =
      0;

    state.auction =
      "running";

    renderTimer();

    startLocalTimer();

    sendAuctionState(
      "running"
    );

    updateButtons();
  }

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

    sendAuctionState(
      "paused"
    );

    updateButtons();
  }

  function resetAuction() {
    clearTimer();

    state.timer =
      readInitialTimer();

    state.initialTimer =
      state.timer;

    state.extraTime =
      readExtraTime();

    state.extraUsed =
      0;

    state.participants.clear();

    renderTimer();

    renderParticipants();

    state.auction =
      "idle";

    socket.emit(
      "auction:reset"
    );

    updateButtons();
  }

  function finishAuction() {
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

    updateButtons();
  }

  function updateButtons() {
    if (btnStart) {
      btnStart.disabled =
        state.auction ===
        "running";
    }

    if (btnPause) {
      btnPause.disabled =
        state.auction !==
        "running";
    }

    if (btnReset) {
      btnReset.disabled =
        false;
    }

    if (btnFinish) {
      btnFinish.disabled =
        state.auction ===
          "idle" ||
        state.auction ===
          "finished";
    }
  }

  function participantKey(
    p
  ) {
    return String(
      p.userId ||
      p.username ||
      p.nickname ||
      "unknown"
    );
  }

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
      Array
        .from(
          state.participants.values()
        )
        .sort(
          (a, b) =>
            b.coins -
              a.coins ||
            a.joinedAt -
              b.joinedAt
        );

    if (!list.length) {
      participantList.innerHTML =
        `<div class="empty-participants">Menunggu peserta</div>`;

      return;
    }

    participantList.innerHTML =
      list
        .map(
          (
            p,
            index
          ) => {
            const name =
              escapeHtml(
                p.nickname ||
                p.username ||
                "Viewer"
              );

            const user =
              escapeHtml(
                p.username ||
                "viewer"
              );

            const avatar =
              p.avatar
                ? `
                  <img
                    src="${escapeAttr(p.avatar)}"
                    alt=""
                    class="participant-avatar"
                    loading="lazy"
                  >
                `
                : `
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

            return `
              <div
                class="participant-row"
                data-user-id="${escapeAttr(
                  participantKey(p)
                )}"
              >
                <div class="participant-rank">
                  ${index + 1}
                </div>

                ${avatar}

                <div class="participant-info">
                  <div class="participant-name">
                    ${name}
                  </div>

                  <div class="participant-username">
                    @${user}
                  </div>
                </div>

                <div class="participant-coins">
                  🪙 ${num(
                    p.coins,
                    0
                  )}
                </div>
              </div>
            `;
          }
        )
        .join("");
  }

  function escapeHtml(v) {
    return String(
      v ?? ""
    ).replace(
      /[&<>'"]/g,
      c =>
        ({
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
        })[c]
    );
  }

  function escapeAttr(v) {
    return escapeHtml(v);
  }

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

    if (!username) {
      console.warn(
        "Username TikTok kosong."
      );

      return;
    }

    socket.emit(
      "live:connect",
      {
        username
      }
    );
  }

  socket.on(
    "connect",
    () => {
      console.log(
        "[Socket] terhubung",
        socket.id
      );

      updateButtons();
    }
  );

  socket.on(
    "live:status",
    data => {
      console.log(
        "[TikTok]",
        data?.message ||
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
    data =>
      console.error(
        "[TikTok]",
        data?.message ||
          data
      )
  );

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

      if (
        data?.version !==
          undefined &&
        data.version <
          state.version
      ) {
        return;
      }

      state.version =
        num(
          data?.version,
          state.version
        );

      setAuctionState(
        next
      );

      if (
        next ===
        "running"
      ) {
        startLocalTimer();
      } else {
        clearTimer();
      }
    }
  );

  socket.on(
    "auction:participants",
    data => {
      if (
        data?.version !==
          undefined &&
        data.version <
          state.version
      ) {
        return;
      }

      if (
        data?.version !==
        undefined
      ) {
        state.version =
          data.version;
      }

      state.participants.clear();

      for (
        const p of
        data?.participants ||
        []
      ) {
        state.participants.set(
          participantKey(p),
          p
        );
      }

      renderParticipants();
    }
  );

  socket.on(
    "live:gift",
    gift => {

      /*
       * Server hanya mengirim gift
       * yang sudah diterima ketika
       * timer sedang berjalan.
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

  if (btnConnect) {
    btnConnect.addEventListener(
      "click",
      connectTikTok
    );
  }

  if (btnStart) {
    btnStart.addEventListener(
      "click",
      startAuction
    );
  }

  if (btnPause) {
    btnPause.addEventListener(
      "click",
      pauseAuction
    );
  }

  if (btnReset) {
    btnReset.addEventListener(
      "click",
      resetAuction
    );
  }

  if (btnFinish) {
    btnFinish.addEventListener(
      "click",
      finishAuction
    );
  }

  state.initialTimer =
    readInitialTimer();

  state.timer =
    state.initialTimer;

  state.extraTime =
    readExtraTime();

  renderTimer();
  renderParticipants();
  updateButtons();

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

})();
