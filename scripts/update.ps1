# Pull the latest Jarvis and rebuild.  Quit Jarvis from the tray first.
#   powershell -ExecutionPolicy Bypass -File scripts\update.ps1
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$before = (git rev-parse HEAD:package-lock.json 2>$null)
git pull
if ($LASTEXITCODE -ne 0) { Write-Host 'git pull failed'; exit 1 }
$after = (git rev-parse HEAD:package-lock.json 2>$null)
if ($before -ne $after -or -not (Test-Path 'node_modules\electron\dist\electron.exe')) { npm install }
npx electron-vite build
if ($LASTEXITCODE -ne 0) { Write-Host 'build failed'; exit 1 }
Write-Host 'Done. Start Jarvis from the desktop shortcut.'
