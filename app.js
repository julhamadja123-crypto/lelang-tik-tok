/* =========================================================
   COIN AUCTION DASHBOARD V7
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

let extraTime = 30;
let extraRemaining = 0;
let extraActive = false;


/* =========================================================
   DOM
   ========================================================= */

const $ = (id) => document.getElementById(id);


/* =========================================================
   FORMAT TIME
   ========================================================= */

function formatTime(sec) {

    sec = Math.max(
        0,
        Math.floor(Number(sec) || 0)
    );

    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;

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

    return String(value ?? "").replace(
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
        String(name || "Viewer").trim();

    return text
        ? text.charAt(0).toUpperCase()
        : "?";
}


/* =========================================================
   NORMALIZE ID
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
   USER KEY
   ========================================================= */

function getUserKey(data = {}) {

    const id =
        normalizeUserId(
            data.userId ||
            data.user_id ||
            data.uid
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
        user?.nickname ||
        "Viewer";

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
                    onerror="
                        this.style.display='none';
                        if(this.nextElementSibling)
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
   TIE CHECK
   ========================================================= */

function leadersAreTied() {

    const sorted =
        sortedUsers();


    return (
        sorted.length >= 2 &&
        Number(sorted[0].coins || 0) > 0 &&
        Number(sorted[0].coins || 0) ===
        Number(sorted[1].coins || 0)
    );

}


/* =========================================================
   CLEAR WINNER
   ========================================================= */

function hasClearLeader() {

    const sorted =
        sortedUsers();


    return (
        sorted.length >= 1 &&
        Number(sorted[0].coins || 0) > 0 &&
        (
            sorted.length === 1 ||
            Number(sorted[0].coins || 0) >
            Number(sorted[1].coins || 0)
        )
    );

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


    el.classList.add("show");


    clearTimeout(
        window.__auctionToastTimer
    );


    window.__auctionToastTimer =
        setTimeout(
            () => {

                el.classList.remove("show");

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


    if (inDraw) {

        timer.classList.add(
            "draw-time-active"
        );

        timer.style.color =
            "#ffd43b";

        return;

    }


    if (extraActive) {

        timer.classList.add(
            "extra-active"
        );

        timer.style.color =
            "#ff3030";

        return;

    }


    timer.style.color =
        "#ffffff";

}


/* =========================================================
   READ MAIN TIME
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


    if (!Number.isFinite(minutes)) {
        minutes = 5;
    }


    if (!Number.isFinite(seconds)) {
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


    if (duration <= 0) {
        duration = 1;
    }


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
   READ EXTRA TIME
   ========================================================= */

function readExtraTime() {

    const input =
        $("extraTimeInput");


    if (!input) {
        return;
    }


    let value =
        Number(input.value);


    if (!Number.isFinite(value)) {
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

        extraRemaining =
            0;

    }

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
            Number(topInput.value);


        if (
            Number.isFinite(value) &&
            value > 0
        ) {

            topLimit =
                Math.floor(value);

        }

    }


    render();

}


/* =========================================================
   WRITE SETTINGS
   ========================================================= */

function writeSettings() {

    const minuteInput =
        $("minuteInput");


    const secondInput =
        $("secondInput");


    const extraInput =
        $("extraTimeInput");


    const titleInput =
        $("titleInput");


    const topInput =
        $("topInput");


    if (minuteInput) {

        minuteInput.value =
            Math.floor(
                duration / 60
            );

    }


    if (secondInput) {

        secondInput.value =
            duration % 60;

    }


    if (extraInput) {

        extraInput.value =
            extraTime;

    }


    if (titleInput) {

        titleInput.value =
            auctionTitle;

    }


    if (topInput) {

        topInput.value =
            String(topLimit);

    }

}


/* =========================================================
   SAVE SETTINGS
   ========================================================= */

function saveSettings() {

    const wasRunning =
        running;


    readSettings();

    writeSettings();


    if (!wasRunning) {

        remaining =
            duration;

        extraActive =
            false;

        extraRemaining =
            0;

        inDraw =
            false;

        drawRemaining =
            drawDuration;

        auctionFinished =
            false;

    }


    syncAuctionState();

    render();


    toast(
        "⚙️ Pengaturan berhasil disimpan"
    );

}


/* =========================================================
   START EXTRA TIME
   ========================================================= */

function startExtraTime() {

    readExtraTime();


    if (extraTime <= 0) {

        if (leadersAreTied()) {

            startDrawTime();

        } else {

            finishAuction(
                "Waktu selesai"
            );

        }

        return;

    }


    extraActive =
        true;


    extraRemaining =
        extraTime;


    auctionFinished =
        false;


    const note =
        $("timerNote");


    if (note) {

        note.textContent =
            "🔴 EXTRA TIME AKTIF";

    }


    toast(
        "🔴 Extra Time dimulai"
    );


    syncAuctionState();

    render();

}


/* =========================================================
   START DRAW
   ========================================================= */

function startDrawTime() {

    inDraw =
        true;


    drawRemaining =
        drawDuration;


    extraActive =
        false;


    extraRemaining =
        0;


    auctionFinished =
        false
