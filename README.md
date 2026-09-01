# TikTok LIVE Coin Auction V11 - Hosting Ready

Versi ini sudah disiapkan untuk deploy ke Railway atau Render.

## Railway (paling mudah)
1. Upload project ini ke repository GitHub.
2. Buka Railway dan login.
3. Pilih **New Project** -> **Deploy from GitHub Repo**.
4. Pilih repository project ini.
5. Railway akan otomatis menjalankan `npm install` dan `npm start`.
6. Setelah deployment selesai, buka **Settings / Networking** dan buat domain publik.
7. Buka domain tersebut dari HP atau komputer.

## Render
File `render.yaml` sudah disertakan.
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

## Penting
- Jangan gunakan `localhost` setelah deploy. Gunakan domain yang diberikan hosting.
- Server menggunakan `process.env.PORT`, sehingga kompatibel dengan Railway dan Render.
- TikTok LIVE connector adalah connector komunitas/unofficial. Jika TikTok mengubah sistem LIVE, koneksi dapat memerlukan update library.
- Pastikan username yang dimasukkan adalah `uniqueId` TikTok dan akun benar-benar sedang LIVE.

## Menjalankan lokal
```bash
npm install
npm start
```
Lalu buka `http://localhost:3000`.
