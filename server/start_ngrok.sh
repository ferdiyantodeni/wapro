#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock

echo "=========================================="
echo "    WaPro - WhatsApp Relay + Ngrok Fixed  "
echo "=========================================="

NGROK_TOKEN="cr_1rsoTFqUeEsIZDfz7kVe2J9zPjA"
NGROK_DOMAIN="proving-unfitting-tanning.ngrok-free.dev"

# 1. Pastikan ngrok terpasang
if ! command -v ngrok &> /dev/null; then
    echo "[INFO] Mengunduh ngrok untuk Termux..."
    curl -sL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz | tar -xz -C $PREFIX/bin
    chmod +x $PREFIX/bin/ngrok
fi

# 2. Pasang authtoken
ngrok config add-authtoken "$NGROK_TOKEN" > /dev/null 2>&1

# 3. Pastikan dependensi node
if [ ! -d "node_modules" ]; then
    echo "[INFO] Menginstal dependensi Node.js..."
    npm install
fi

# 4. Jalankan server WaPro
echo "[INFO] Menyalakan WaPro Server di port 8080..."
node index.js &
NODE_PID=$!

sleep 2

echo ""
echo "=========================================="
echo "  WAPRO LIVE ON NGROK STATIC DOMAIN!      "
echo "  Buka link tetap ini di laptop kantor:   "
echo "  ?? https://$NGROK_DOMAIN                "
echo "=========================================="
echo ""

ngrok http --domain="$NGROK_DOMAIN" 8080

kill $NODE_PID 2>/dev/null