<#
  restaurar.ps1 — restaura os apps removidos pelo debloat NESTE aparelho.
  Le logs\<serial>-removidos.txt e reinstala cada pacote (install-existing).
  (Funciona porque o debloat usou 'pm uninstall -k --user 0', mantendo o app no firmware.)
#>
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$adb = @("$ScriptDir\platform-tools\adb.exe","$env:USERPROFILE\platform-tools\adb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if(-not $adb){ Write-Host "ADB nao encontrado." -ForegroundColor Red; exit 1 }
if(-not ((& $adb devices | Select-String "\tdevice$"))){ Write-Host "Nenhum celular conectado/autorizado." -ForegroundColor Red; exit 1 }

$serial = ((& $adb get-serialno) -join '').Trim() -replace '[^A-Za-z0-9_.-]','_'
$remFile = Join-Path $ScriptDir ("logs\{0}-removidos.txt" -f $serial)
Write-Host ("Aparelho: {0}" -f $serial) -ForegroundColor Cyan
if(-not (Test-Path $remFile)){ Write-Host "Nenhum registro de remocao para este aparelho ($remFile). Nada a restaurar." -ForegroundColor Yellow; exit 0 }

$pkgs = Get-Content $remFile | Where-Object { $_ -and $_.Trim() } | Sort-Object -Unique
Write-Host ("Restaurando {0} app(s)..." -f $pkgs.Count) -ForegroundColor Cyan
foreach($p in $pkgs){
  $r = (& $adb shell cmd package install-existing --user 0 $p) 2>&1
  $ok = ($r -match "installed|Success")
  Write-Host ("  {0,-45} {1}" -f $p, $(if($ok){"[restaurado]"}else{"[falhou] $r"})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
}
Write-Host "`n>>> Restauracao concluida. <<<" -ForegroundColor Magenta
