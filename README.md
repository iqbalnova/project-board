# Project Board — Kanban + Timeline Phase

Aplikasi ringan untuk dua hal:

1. **Kanban**: manajemen task/ticket per phase (To Do → In Progress → Review → Done), drag & drop.
2. **Timeline phase**: tiap phase punya tanggal, scope yang disetujui, dan bisa **dikunci**. Setelah dikunci, permintaan baru dari stakeholder harus lewat **Change Request** yang diputuskan: *wajib masuk phase sekarang* / *geser ke phase berikutnya* / *tolak*.

Tanpa framework, tanpa dependency (hanya modul bawaan Node). Data disimpan di satu file JSON.

## Alur kerja

1. Buat phase (nama, tanggal mulai/selesai, tujuan).
2. Isi scope phase (item = task yang muncul juga di Kanban).
3. Klik **Kunci scope** saat stakeholder sudah menyetujui. Item saat itu menjadi *baseline*.
4. Kalau ada permintaan baru, klik **Ajukan perubahan** (catat siapa yang minta dan alasannya). Lalu putuskan:
   - **Wajib: Phase X**: wajib isi alasan. Bisa sekaligus memperpanjang tanggal selesai phase (+N hari) dan menggeser phase berikutnya. Task baru masuk Phase X dengan label **CR**.
   - **Geser ke Phase berikutnya**: task baru masuk phase berikutnya (label **CR**), phase sekarang tidak terganggu.
   - **Tolak**: tercatat sebagai ditolak.
5. Semua perubahan scope dan timeline tercatat di tombol **Riwayat** sebagai jejak audit.

Phase yang terkunci menolak penambahan task langsung (API mengembalikan 409), jadi scope tidak bisa "bocor" tanpa keputusan.

## Jalankan lokal

```bash
node server.js            # butuh Node 18+
# buka http://localhost:3000
```

## Jalankan dengan Docker

```bash
cp .env.example .env      # atau buat .env berisi APP_PASSWORD=passwordkamu
docker compose up -d --build
```

Atau tanpa compose:

```bash
docker build -t project-board .
docker run -d --name project-board -p 3000:3000 \
  -e APP_PASSWORD=passwordkamu \
  -v board-data:/data \
  --memory 256m --cpus 0.5 \
  project-board
```

Data ada di volume `board-data` (file `/data/db.json`). **Pastikan `/data` dipasang sebagai volume** supaya data tidak hilang saat container dibuat ulang.
Kalau memakai bind mount (`-v /path/di/host:/data`), pastikan foldernya bisa ditulis user `node` (uid 1000): `chown 1000:1000 /path/di/host`.

## Konfigurasi (environment variable)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` (di Docker: `/data`) | Folder penyimpanan `db.json` |
| `APP_USERS` | *(kosong)* | Multi-user login dengan format `user1:pass1,user2:pass2` (misal: `iqbal:rahasia123,budi:dev123`). Nama user dipakai otomatis pada komentar & riwayat. |
| `APP_PASSWORD` | *(kosong)* | Opsional (fallback single-user jika `APP_USERS` tidak diisi). |
| `APP_USER` | `admin` | Username single-user untuk `APP_PASSWORD`. |

Pasang reverse proxy dengan HTTPS (Caddy/Nginx/Traefik) di depan aplikasi ini, karena Basic Auth mengirim password tanpa enkripsi lewat HTTP biasa.

## Penggunaan resource

Proses Node berjalan di sekitar 40–60 MB RAM, jadi aman untuk batas 256 MB / 0.5 core. Heap dibatasi `--max-old-space-size=96` di Dockerfile. File statis di-gzip sekali saat start; API hanya membaca/menulis data di memori.

## Backup & pemulihan

- Tombol **Export** mengunduh seluruh data sebagai JSON; **Import** memulihkannya.
- Server menyimpan secara atomik (tulis file sementara lalu rename) dan membuat `db.json.bak` paling sering sekali per jam.
- Cara paling sederhana: backup folder `/data` secara berkala.

## API singkat

Semua request non-GET wajib `Content-Type: application/json`. Setiap perubahan mengembalikan state terbaru.

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/state` | Seluruh data |
| POST/PATCH/DELETE | `/api/phases[/:id]` | Kelola phase (`cascade: true` untuk menggeser phase berikutnya) |
| POST | `/api/phases/:id/lock` | `{locked: true/false}` |
| POST/PATCH/DELETE | `/api/tasks[/:id]` | Kelola task |
| POST | `/api/tasks/:id/move` | `{status, index}` (Kanban) |
| POST | `/api/changes` | Ajukan change request |
| POST | `/api/changes/:id/decide` | `{decision: current\|next\|reject, note, extendDays, cascade, priority}` |
| GET / POST | `/api/export` / `/api/import` | Backup / restore |
| GET | `/healthz` | Health check |

## Batasan

- Satu instance, data di satu file JSON: cocok untuk tim kecil. Dua orang mengedit bersamaan aman (server tunggal), dan tampilan menyegarkan diri tiap 15 detik jika ada perubahan dari orang lain.
- Belum ada akun per-user; hanya satu password bersama.
- Drag & drop memakai HTML5; di layar sentuh gunakan tombol ← → pada kartu.
