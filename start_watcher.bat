@echo off
REM ============================================================
REM Meeting Processor - inicia o watcher (monitora a pasta do OBS)
REM ============================================================

title Meeting Processor - Watcher

REM Diretório do script (raiz do projeto)
cd /d "%~dp0"

REM ffmpeg do PATH (instalado via `winget install Gyan.FFmpeg`)
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [ERRO] ffmpeg nao encontrado no PATH.
    echo Instale com:  winget install Gyan.FFmpeg
    pause
    exit /b 1
)

python -m meeting_processor watch
pause
