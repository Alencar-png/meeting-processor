@echo off
REM ============================================================
REM Meeting Processor - abre o aplicativo
REM
REM Clique duas vezes neste arquivo. Na primeira execucao ele
REM instala as dependencias do app (leva alguns minutos).
REM ============================================================
title Meeting Processor
cd /d "%~dp0desktop"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERRO] Node.js nao encontrado no PATH.
    echo  Instale com:  winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo.
    echo  Primeira execucao: instalando as dependencias do app...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao instalar as dependencias.
        pause
        exit /b 1
    )
)

echo.
echo  Abrindo o Meeting Processor...
call npm start

REM Se o app fechar por erro, a janela fica aberta para mostrar a mensagem.
if errorlevel 1 pause
