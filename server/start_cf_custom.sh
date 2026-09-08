#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock

echo "=========================================="
echo "    WaPro - https://wa.gridiyans.my.id    "
echo "=========================================="

TOKEN_FILE="$HOME/wapro/server/.cf_token"
if [ ! -f "$TOKEN_FILE" ]; then
    echo ""
    echo "Masukkan Cloudflare Tunnel Token Anda (dimulai dari eyJh...):"
    read -p "Token: " CF_TOKEN
    echo "$CF_TOKEN" > "$TOKEN_FILE"
else
    CF_TOKEN=$(cat "$TOKEN_FILE")
fi

# 1. Pastikan cloudflared terpasang
if ! command -v cloudflared &> /dev/null; then
    echo "[INFO] Menginstal cloudflared di Termux..."
    pkg install cloudflared -y
fi

# 2. Pastikan dependensi node
if [ ! -d "node_modules" ]; then
    echo "[INFO] Menginstal dependensi Node.js..."
    npm install
fi

# 3. Jalankan server WaPro
echo "[INFO] Menyalakan WaPro Server di port 8080..."
node index.js &
NODE_PID=$!

sleep 2

echo ""
echo "=========================================="
echo "  WAPRO LIVE ON: https://wa.gridiyans.my.id"
echo "=========================================="
echo ""

cloudflared tunnel run --token "$CF_TOKEN"

kill $NODE_PID 2>/dev/null