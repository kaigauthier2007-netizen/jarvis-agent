# Creates Desktop\Jarvis.lnk that starts the BUILT app directly (no npm, no Vite dev server, no console window).
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { Write-Host 'electron.exe not found - run "npm install" first'; exit 1 }
if (-not (Test-Path (Join-Path $repo 'out\main\index.js'))) { Write-Host 'No build yet - run "npx electron-vite build" first'; exit 1 }
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Jarvis.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.Arguments = '.'
$s.WorkingDirectory = $repo
$s.IconLocation = (Join-Path $repo 'build\icon.ico')
$s.Description = 'Jarvis'
$s.Save()
Write-Host "Shortcut updated: $lnk -> $exe ."
