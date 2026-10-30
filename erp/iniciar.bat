@echo off
rem Inicia o Potato ERP e abre o navegador. Requer Node.js 22.5 ou mais novo (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000/"
node --no-warnings server.js
pause
