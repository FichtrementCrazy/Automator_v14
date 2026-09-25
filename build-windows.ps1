$ErrorActionPreference='Stop'
Write-Host '== BlockFlow Automator / Build Windows ==' -ForegroundColor Cyan
if(-not (Get-Command node -ErrorAction SilentlyContinue)){ throw 'Node.js est requis.' }
if(-not (Get-Command npm -ErrorAction SilentlyContinue)){ throw 'npm est requis.' }
npm install
npx electron-builder --win --x64 --publish=never
Write-Host 'Build terminé. Voir le dossier dist.' -ForegroundColor Green
