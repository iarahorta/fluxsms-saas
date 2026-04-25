@echo off
title Iniciador GSM Codder
color 0A
echo.
echo ========================================================
echo        Iniciando o GSM Codder Automatizado...
echo ========================================================
echo.

:: Verifica se o Python está presente
python --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERRO] Python nao encontrado!
    echo Por favor, instale o Python marcando a opcao "Add Python to PATH"
    pause
    exit /b
)

:: Instala as dependencias silenciosamente
echo [i] Instalando bibliotecas em background (aguarde uns segundos)...
pip install -r requirements.txt >nul 2>&1

:: Inicia o robo principal
cls
python main.py
pause
