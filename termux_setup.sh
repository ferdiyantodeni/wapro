#!/data/data/com.termux/files/usr/bin/bash

echo "========================================="
echo "   WaPro - Setup & Start WhatsApp Relay"
echo "========================================="

# Wake lock to prevent Android from sleeping
termux-wake-lock

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$DIR/server"

if [ ! -d "$SERVER_DIR" ]; then
    SERVER_DIR="$HOME/WaPro/server"
fi

if [ ! -d "$SERVER_DIR" ]; then
    echo "[ERROR] Folder server tidak ditemukan!"
    exit 1
fi

cd "$SERVER_DIR"

if [ ! -d "node_modules" ]; then
    echo "[INFO] Menginstal dependensi (hanya di awal)..."
    npm install
fi

echo "[INFO] Menjalankan WaPro Relay Server..."
node index.js