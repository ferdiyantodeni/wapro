#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock

echo "=========================================="
echo "    WaPro - WhatsApp Relay + Cloudflare   "
echo "=========================================="

# 1. Pastikan cloudflared terpasang
if ! command -v cloudflared &> /dev/null; then
    echo "[INFO] Menginstal cloudflared di Termux..."
    pkg install cloudflared -y
    if ! command -v cloudflared &> /dev/null; then
        echo "[INFO] Mencoba download binary cloudflared langsung..."
        curl -L -o $PREFIX/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
        chmod +x $PREFIX/bin/cloudflared
    fi
fi

# 2. Pastikan node_modules terinstall
if [ ! -d "node_modules" ]; then
    echo "[INFO] Menginstal dependensi Node.js..."
    npm install
fi

# 3. Jalankan server WaPro
echo "[INFO] Menyalakan WaPro Server di port 8080..."
node index.js &
NODE_PID=$!

sleep 3

# 4. Aktifkan Cloudflare Tunnel
echo ""
echo "=========================================="
echo "  MEMBUAT LINK AKSES CLOUDFLARE TUNNEL... "
echo "  (Cari baris link https://...trycloudflare.com)"
echo "=========================================="
echo ""

cloudflared tunnel --url http://localhost:8080

kill $NODE_PID 2>/dev/null