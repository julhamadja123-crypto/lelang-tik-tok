let users=[],duration=300,remaining=300,running=false,interval=null,liveConnected=false,topLimit=5,activities=[],auctionTitle="LIVE COIN AUCTION";
let drawDuration=20,drawRemaining=20,inDraw=false,auctionFinished=false;
const $=id=>document.getElementById(id);

function formatTime(sec){return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`}
function esc(t){return String(t).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function sortedUsers(){return [...users].sort((a,b)=>b.coins-a.coins)}
function leadersAreTied(){const s=sortedUsers();return s.length>=2&&s[0].coins>0&&s[0].coins===s[1].coins}
function hasClearLeader(){const s=sortedUsers();return s.length>=1&&(s.length===1||s[0].coins>s[1].coins)}

function syncAuctionState(){
  if(socket && socket.connected) socket.emit("auction:state", {active: running && !auctionFinished});
}
function render(){
  const displayTime=inDraw?drawRemaining:remaining;
  $("timer").textContent=formatTime(displayTime);
  $("auctionTitleDisplay").textContent=auctionTitle;
  $("progressBar").style.width=`${inDraw?(drawDuration?((drawDuration-drawRemaining)/drawDuration)*100:0):(duration?((duration-remaining)/duration)*100:0)}%`;
  if(inDraw)$("timerNote").innerHTML=`⚡ DRAW TIME aktif — tetap berjalan sampai ${drawDuration} detik habis`;
  const sorted=sortedUsers();$("participantCount").textContent=`${sorted.length} peserta`;
  const medals=["🥇","🥈","🥉"];
  const avatar=(u)=>u.avatar?`<img src="${esc(u.avatar)}" alt="Foto profil ${esc(u.name)}" referrerpolicy="no-referrer" onerror="this.parentNode.innerHTML='${esc(u.name[0]||"?")}'">`:esc(u.name[0]||"?");
  $("rankingList").innerHTML=sorted.length?sorted.slice(0,topLimit).map((u,i)=>`<article class="rank-card rank-box ${i===0?"top1":""} ${inDraw&&i<2?"draw-box":""}"><div class="box-top"><span class="rank-no">${medals[i]||"#"+(i+1)}</span><span class="box-rank">PESERTA ${i+1}</span></div><div class="user-avatar">${avatar(u)}</div><div class="rank-info"><strong>${esc(u.name)}</strong><span>${inDraw&&i<2?"⚡ DRAW TIME":"GIFT TIKTOK LIVE"}</span></div><div class="coin"><span class="coin-icon">🪙</span><strong>${u.coins.toLocaleString("id-ID")}</strong></div></article>`).join(""):`<div class="rank-card rank-box empty-box"><div class="rank-info"><strong>Menunggu peserta</strong><span>Gift TikTok LIVE akan muncul di sini.</span></div></div>`;
  $("activityList").innerHTML=activities.length?activities.slice(0,5).map(a=>`<div class="activity"><div class="user-avatar activity-avatar">${a.avatar?`<img src="${esc(a.avatar)}" alt="Foto profil ${esc(a.name)}" referrerpolicy="no-referrer">`:esc(a.name[0]||"?")}</div><div><strong>${esc(a.name)}</strong><span>${esc(a.gift)}</span></div><div class="event-coin"><span>🪙</span> +${a.coins.toLocaleString("id-ID")}</div></div>`).join(""):`<p class="empty">Belum ada gift masuk.</p>`;
}
function toast(m){const t=$("toast");t.textContent=m;t.classList.add("show");clearTimeout(window.tt);window.tt=setTimeout(()=>t.classList.remove("show"),2200)}
function finishAuction(message="Lelang selesai — pemenang ditentukan"){running=false;clearInterval(interval);auctionFinished=true;inDraw=false;syncAuctionState();$("timerNote").textContent=message;render();toast("🏆 "+message)}
function startDrawTime(){inDraw=true;drawRemaining=drawDuration;$("timerNote").textContent=`⚡ DRAW TIME aktif — ${drawDuration} detik`;toast(`⚡ DRAW TIME ${drawDuration} DETIK!`);render()}
function handleTimeEnd(){
  if(!inDraw){leadersAreTied()?startDrawTime():finishAuction();return}
  // Draw Time habis: bila masih seri, hasil seri. Bila ada unggulan, selesai.
  if(hasClearLeader())finishAuction("DRAW TIME selesai — pemenang ditentukan");
  else finishAuction("DRAW TIME selesai — hasil masih seri");
}
function setRunning(v){
  if(auctionFinished&&v)auctionFinished=false;
  running=v;syncAuctionState();clearInterval(interval);
  if(v){
    interval=setInterval(()=>{
      if(inDraw){
        // Draw Time WAJIB berjalan sampai 20 detik habis, meskipun sudah ada pemimpin.
        if(drawRemaining>0){drawRemaining--;render()}else handleTimeEnd();
      }else{
        if(remaining>0){remaining--;render()}else handleTimeEnd();
      }
    },1000);
  }else if(!auctionFinished)$("timerNote").textContent=inDraw?"DRAW TIME dijeda":"Lelang dijeda";
}
$("startBtn").onclick=()=>{if(auctionFinished||(remaining<=0&&!inDraw)){remaining=duration;drawRemaining=drawDuration;inDraw=false;auctionFinished=false;}setRunning(true);toast("Lelang dimulai")};
$("pauseBtn").onclick=()=>{setRunning(false);toast("Lelang dijeda")};
$("resetBtn").onclick=()=>{setRunning(false);remaining=duration;drawRemaining=drawDuration;inDraw=false;auctionFinished=false;users=[];activities=[];$("timerNote").textContent="Siap untuk memulai lelang";render();toast("Lelang direset")};
$("finishBtn").onclick=()=>{finishAuction();toast("Lelang diselesaikan")};
$("saveSettings").onclick=()=>{const min=Math.max(0,Math.min(120,Number($("minuteInput").value)||0));const sec=Math.max(0,Math.min(59,Number($("secondInput").value)||0));if(min===0&&sec===0){toast("Waktu minimal 1 detik");return}duration=min*60+sec;remaining=duration;topLimit=Number($("topInput").value);auctionTitle=$("titleInput").value.trim()||"LIVE COIN AUCTION";setRunning(false);$("timerNote").textContent=`Pengaturan disimpan • Draw Time ${drawDuration} detik`;render();toast("Pengaturan disimpan")};
$("connectBtn").onclick=()=>{liveConnected=!liveConnected;$("liveName").textContent=liveConnected?"@TikTokLiveDemo":"@Belum Terhubung";$("connectBtn").textContent=liveConnected?"TikTok LIVE Terhubung ✓":"Hubungkan TikTok LIVE";$("statusBadge").textContent=liveConnected?"ONLINE":"OFFLINE";$("statusBadge").className="status-badge "+(liveConnected?"online":"offline");toast(liveConnected?"Mode demo LIVE aktif":"TikTok LIVE diputus")};

window.addGift=(name,gift,coins,avatar="")=>{
  // Gift hanya dihitung saat tombol Mulai Lelang aktif.
  if(!running || auctionFinished)return;
  coins=Number(coins)||0;let u=users.find(x=>x.name.toLowerCase()===String(name).toLowerCase());
  if(!u){u={name:String(name),coins:0,avatar:String(avatar||"")};users.push(u)}
  else if(avatar) u.avatar=String(avatar);
  u.coins+=coins;activities.unshift({name:String(name),gift:String(gift),coins,avatar:String(avatar||u.avatar||"")});render();
  // Saat Draw Time, skor tetap diperbarui tetapi timer harus tetap berjalan sampai 20 detik habis.
};
render();
// ===== TikTok LIVE realtime bridge =====
let socket=null, liveEventCount=0;
function updateConnectionLog(msg,type=""){
  const el=$("connectionLog"); if(!el)return;
  el.textContent="Status: "+msg;
  el.className="connection-log "+type;
}
function setLiveUi(connected, username=""){
  liveConnected=connected;
  $("liveName").textContent=connected?"@"+username:"@Belum Terhubung";
  $("connectBtn").textContent=connected?"TikTok LIVE Terhubung ✓":"Hubungkan TikTok LIVE";
  $("statusBadge").textContent=connected?"ONLINE":"OFFLINE";
  $("statusBadge").className="status-badge "+(connected?"online":"offline");
  const disconnectBtn=$("disconnectBtn");
  if(disconnectBtn) disconnectBtn.style.display=connected?"block":"none";
}
function setupSocket(){
  if(socket) return socket;
  if(typeof io==="undefined"){
    updateConnectionLog("Socket TikTok belum termuat. Refresh halaman dari server Node.js.","error");
    return null;
  }
  socket=io({transports:["websocket","polling"]});
  socket.on("connect",()=>{ updateConnectionLog("server terhubung ✓","ok"); syncAuctionState(); });
  socket.on("connect_error",err=>updateConnectionLog("server gagal: "+(err?.message||"tidak dapat terhubung"),"error"));
  socket.on("live:status",d=>{
    const msg=d.message||"status LIVE diperbarui";
    updateConnectionLog(msg,d.ok?"ok":"error");
    if(d.ok){
      const m=msg.match(/@([^\s•]+)/);
      setLiveUi(true,m?m[1]:"TikTokLive");
    } else if(/diputus|belum terhubung|gagal/i.test(msg)) {
      setLiveUi(false);
    }
  });
  socket.on("live:gift",d=>{
    if(!running || auctionFinished) return;
    const username=d.username||d.nickname||"Viewer";
    const gift=d.giftName||"TikTok Gift";
    const coin=Number(d.coinValue)||0;
    window.addGift(username,gift,coin,d.avatar||d.profilePictureUrl||d.profilePicture||"");
    liveEventCount++;
    const hv=$("heroViewer"); if(hv) hv.textContent=liveEventCount;
  });
  socket.on("live:error",d=>{
    const msg=d.message||"koneksi gagal";
    updateConnectionLog(msg,"error"); toast(msg);
    setLiveUi(false);
  });
  return socket;
}
$("connectBtn").onclick=()=>{
  const username=($("tiktokUsername").value||"").trim();
  if(!username){toast("Masukkan username TikTok yang sedang LIVE");return}
  const s=setupSocket(); if(!s)return;
  updateConnectionLog("menghubungkan ke "+username+" ...");
  s.emit("live:connect",{username});
};
$("disconnectBtn").onclick=()=>{
  if(socket) socket.emit("live:disconnect");
  setLiveUi(false);
  updateConnectionLog("koneksi diputus");
};
setLiveUi(false);
setupSocket();
