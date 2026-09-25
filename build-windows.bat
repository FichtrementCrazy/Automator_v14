@echo off
setlocal
cd /d %~dp0
where node >nul 2>nul || (echo Node.js est requis. & pause & exit /b 1)
where npm >nul 2>nul || (echo npm est requis. & pause & exit /b 1)
echo Installation des dependances...
npm install
if errorlevel 1 goto :error
echo Construction de BlockFlow Automator...
npx electron-builder --win --x64 --publish=never
if errorlevel 1 goto :error
echo.
echo Build termine. Les fichiers sont dans le dossier dist.
pause
exit /b 0
:error
echo.
echo ECHEC DU BUILD.
pause
exit /b 1
