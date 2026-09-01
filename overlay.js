let title="TOP 1-3 SAMAKAN TIGA GAMBAR (NOMINIM COIN) WAJIB LOVE OREN DI AWAL 🧡 GA LOVE OREN GA SAH",duration=300,remaining=300,running=true;
let drawDuration=20,drawRemaining=20,inDraw=false,finished=false;
let users=[{name:"ANDI STORE",coins:1250},{name:"BUDI OFFICIAL",coins:980},{name:"RUDI LIVE",coins:750},{name:"SINTA SHOP",coins:620},{name:"JOKO ID",coins:510}];
const $=id=>document.getElementById(id);
const fmt=s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const leadersTie=()=>{let a=[...users].sort((x,y)=>y.coins-x.coins);return a.length>=2&&a[0].coins>0&&a[0].coins===a[1].coins};
const hasClearLeader=()=>{let a=[...users].sort((x,y)=>y.coins-x.coins);return a.length>=1&&(a.length===1||a[0].coins>a[1].coins)};

function render(){
 let a=[...users].sort((x,y)=>y.coins-x.coins),m=["🥇","🥈","🥉"];
 $("timer").textContent=fmt(inDraw?drawRemaining:remaining);
 $("auctionTitle").textContent=inDraw?"⚡ DRAW TIME ⚡":title;
 $("progressBar").style.width=`${inDraw?((drawDuration-drawRemaining)/drawDuration)*100:((duration-remaining)/duration)*100}%`;
 $("totalCoins").textContent=a.reduce((s,x)=>s+x.coins,0).toLocaleString("id-ID");
 $("rankingList").innerHTML=a.slice(0,5).map((u,i)=>`<div class="rank ${i===0?"first":""} ${inDraw&&i<2?"draw":""}"><div class="box-head"><div class="place">${m[i]||"#"+(i+1)}</div><span>TOP ${i+1}</span></div><div class="user"><div class="avatar">${u.name[0]}</div><div><div class="name">${u.name}</div><div class="sub">${inDraw&&i<2?"⚡ TAMBAH COIN UNTUK MENANG":"PESERTA LIVE"}</div></div></div><div class="coins">${u.coins.toLocaleString("id-ID")}<small>COIN</small></div></div>`).join("");
}
function finish(){running=false;finished=true;inDraw=false;let w=[...users].sort((a,b)=>b.coins-a.coins)[0];if(w){$("winnerName").textContent=w.name;$("winnerCoins").textContent=w.coins.toLocaleString("id-ID")+" COIN";$("winnerPopup").classList.add("show")}}
function endTime(){if(!inDraw){leadersTie()?(inDraw=true,drawRemaining=drawDuration,render()):finish()}else{finish()}}

window.setAuctionTitle=t=>{title=String(t)||title;render()};
window.setAuctionTime=(min,sec)=>{duration=(Number(min)||0)*60+(Number(sec)||0);remaining=duration;render()};
window.setDrawTime=s=>{drawDuration=Math.max(1,Number(s)||20);drawRemaining=drawDuration;render()};
window.addGift=(name,coins)=>{
 if(finished)return;
 let u=users.find(x=>x.name===String(name).toUpperCase());if(!u){u={name:String(name).toUpperCase(),coins:0};users.push(u)}
 u.coins+=Number(coins)||0;render();
 // Saat Draw Time skor boleh berubah, tetapi pemenang baru ditentukan setelah 20 detik habis.
};
window.finishAuction=finish;
setInterval(()=>{
 if(!running||finished)return;
 if(inDraw){
   // Draw Time wajib berjalan penuh sampai 20 detik habis.
   if(drawRemaining>0){drawRemaining--;render()}else finish();
 }else{
   if(remaining>0){remaining--;render()}else endTime()
 }
},1000);
render();
if(typeof io!=="undefined"){
 const socket=io();
 socket.on("live:gift",d=>window.addGift(d.username||d.nickname||"Viewer",Number(d.coinValue)||0));
 socket.on("live:status",()=>{});
}
