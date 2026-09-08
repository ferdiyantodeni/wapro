# WaPro - WhatsApp Web Proxy / Relay via HP Android

Proyek ini dirancang untuk mengatasi pemblokiran WhatsApp Web di lingkungan kantor yang menggunakan **GlobalProtect / Palo Alto Firewall**, dengan memanfaatkan **HP Android pribadi sebagai Relay Server lokal via kabel USB (ADB)**.

---

## 🚀 Keunggulan Solusi Ini:
1. **100% Bebas Blokir**: Traffic antara laptop dan HP dialirkan langsung melalui kabel USB (`localhost:8080`), sehingga firewall GlobalProtect kantor tidak menyentuh atau memblokir koneksi.
2. **Biaya Rp 0**: Tidak memerlukan sewa server VPS atau cloud bulanan.
3. **Privasi & Keamanan**: End-to-end terenkripsi, data chat tersimpan lokal di HP Anda sendiri.
4. **Antarmuka Lengkap**: Tampilan WhatsApp Web modern (Dark Mode), dukungan pesan real-time, status terhubung, unread badge, dan mulai chat baru.

---

## 🛠️ Langkah Menghubungkan (Pertama Kali)

### 1. Aktifkan USB Debugging di HP Android
1. Buka **Pengaturan HP** > **Tentang Ponsel** (About Phone).
2. Ketuk **Nomor Bentukan (Build Number)** sebanyak 7 kali hingga muncul pesan "Anda sekarang adalah pengembang".
3. Kembali ke Pengaturan > **Opsi Pengembang (Developer Options)**.
4. Aktifkan **USB Debugging** (Debugging USB).
5. Colokkan HP ke Laptop dengan kabel USB. Jika muncul pop-up di layar HP *"Izinkan debugging USB?"*, centang *"Selalu izinkan dari komputer ini"* dan tekan **OK**.

---

### 2. Salin Project ke HP
Di laptop, klik dua kali file:
```
sync_to_hp.bat
```
*(File proyek akan otomatis dikirim ke folder `/sdcard/Download/WaPro` di HP Anda).*

---

### 3. Jalankan Server di Termux (HP)
Buka aplikasi **Termux** di HP Anda, lalu ketik perintah berikut:

```bash
termux-setup-storage
cp -r /sdcard/Download/WaPro ~/
cd ~/WaPro/server
npm install
node index.js
```
*(Tunggu hingga muncul pesan `WaPro Relay Server running on port 8080`).*

---

### 4. Buka WaPro di Laptop
Di laptop, cukup klik dua kali file:
```
start.bat
```
Browser akan otomatis terbuka ke `http://localhost:8080` dan menampilkan antarmuka chat WhatsApp Web!

---

## 🔑 Cara Menautkan Akun WhatsApp (Login)
Di antarmuka browser `http://localhost:8080`:
1. Masukkan nomor WhatsApp Anda (contoh: `08123456789`).
2. Klik **Dapatkan Kode**.
3. Di HP Anda, buka **WhatsApp** > **Titik Tiga (pojok kanan atas)** > **Perangkat Tertaut** > **Tautkan Perangkat** > **Tautkan dengan nomor telepon saja**.
4. Masukkan 8 digit kode yang tampil di layar laptop.
5. Selesai! Chat Anda akan otomatis sinkron ke antarmuka WaPro di laptop.

---

## 💡 Penggunaan Sehari-hari Berikutnya:
1. Colok kabel USB ke laptop.
2. Buka Termux di HP, ketik:
   ```bash
   cd ~/WaPro/server && node index.js
   ```
3. Di laptop, jalankan `start.bat`.