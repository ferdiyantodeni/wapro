@echo off
title WaPro - WhatsApp Web Relay Launcher
color 0A
cls
echo ========================================================
echo         WaPro - WhatsApp Web Proxy / Relay Launcher
echo ========================================================
echo.

set ADB_EXE=%~dp0tools\platform-tools\adb.exe

if not exist "%ADB_EXE%" (
    echo [ERROR] ADB tidak ditemukan di %ADB_EXE%
    pause
    exit /b
)

echo [1/3] Memeriksa koneksi HP via USB...
"%ADB_EXE%" devices > "%temp%\adb_dev.txt"
findstr /R "device$" "%temp%\adb_dev.txt" > nul
if %errorlevel% neq 0 (
    echo.
    echo [PERHATIAN] HP belum terdeteksi via USB ADB!
    echo.
    echo Pastikan:
    echo  1. Kabel USB HP sudah terhubung ke Laptop.
    echo  2. "USB Debugging" sudah AKTIF di HP (Pengaturan ^> Opsi Pengembang ^> USB Debugging).
    echo  3. Jika muncul pop-up "Izinkan USB Debugging" di layar HP, pilih "Selalu Izinkan".
    echo.
    echo Daftar perangkat ADB saat ini:
    type "%temp%\adb_dev.txt"
    echo.
    echo --------------------------------------------------------
    echo Tekan tombol apa saja untuk mencoba mendeteksi ulang...
    pause > nul
    goto :check_again
)

:device_ok
echo [OK] HP terdeteksi via USB!
echo.
echo [2/3] Mengaktifkan jalur USB Port Forwarding (Port 8080)...
"%ADB_EXE%" reverse tcp:8080 tcp:8080
if %errorlevel% equ 0 (
    echo [OK] Port 8080 berhasil diteruskan melalui kabel USB!
) else (
    echo [WARNING] Gagal reverse port, mencoba lanjut...
)

echo.
echo [3/3] Membuka WaPro di Browser...
start http://localhost:8080

echo.
echo ========================================================
echo  WaPro Client aktif di: http://localhost:8080
echo  Jalur koneksi: Kabel USB (Bypass total GlobalProtect)
echo ========================================================
echo.
echo Catatan: Pastikan server di Termux HP sudah berjalan:
echo   cd ~/WaPro/server
echo   npm start
echo.
pause
exit /b

:check_again
cls
echo ========================================================
echo         WaPro - WhatsApp Web Proxy / Relay Launcher
echo ========================================================
echo.
"%ADB_EXE%" devices > "%temp%\adb_dev.txt"
findstr /R "device$" "%temp%\adb_dev.txt" > nul
if %errorlevel% neq 0 (
    echo HP masih belum terdeteksi. Silakan periksa kabel dan izin USB debugging.
    echo.
    type "%temp%\adb_dev.txt"
    echo.
    pause
    exit /b
)
goto :device_ok