@echo off
title WaPro - Kirim File ke HP via USB
color 0B
cls
echo ========================================================
echo        WaPro - Copy Project Server ke HP (Termux)
echo ========================================================
echo.

set ADB_EXE=%~dp0tools\platform-tools\adb.exe

echo [1/3] Memeriksa koneksi HP...
"%ADB_EXE%" devices > "%temp%\adb_dev.txt"
findstr /R "device$" "%temp%\adb_dev.txt" > nul
if %errorlevel% neq 0 (
    echo [ERROR] HP belum terdeteksi. Hubungkan HP via USB dan aktifkan USB Debugging.
    type "%temp%\adb_dev.txt"
    pause
    exit /b
)

echo [OK] HP terhubung!
echo.
echo [2/3] Mengirim file server ke memori HP (/sdcard/Download/WaPro)...
"%ADB_EXE%" shell "mkdir -p /sdcard/Download/WaPro"
"%ADB_EXE%" push "%~dp0server" "/sdcard/Download/WaPro/"
"%ADB_EXE%" push "%~dp0termux_setup.sh" "/sdcard/Download/WaPro/"

echo.
echo [3/3] Selesai! File berhasil dikirim ke HP.
echo.
echo ========================================================
echo  LANGKAH SELANJUTNYA DI TERMUX (HP):
echo ========================================================
echo  Buka Termux di HP Anda, lalu ketik perintah ini:
echo.
echo    termux-setup-storage
echo    cp -r /sdcard/Download/WaPro ~/
echo    cd ~/WaPro/server
echo    npm install
echo    node index.js
echo.
echo ========================================================
pause