<#
================================================================
  extrair-apk.ps1  -  Extrai o APK de UM app instalado no celular
                      para a pasta .\apks (single -> .apk; split -> bundle)
================================================================
  Usado pelo painel (aba Avancado -> "Extrair APK") para puxar o APK
  de qualquer app instalado, util para reaproveitar noutro aparelho.
  Registra a versao extraida em apks\_versoes.json.

  USO:
    powershell -ExecutionPolicy Bypass -File .\extrair-apk.ps1 -Pkg com.instagram.android -Nome Instagram
================================================================
#>
param(
  [Parameter(Mandatory=$true)][string]$Pkg,
  [string]$Nome=''
)
$ErrorActionPreference='Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$apkDir = Join-Path $ScriptDir 'apks'
New-Item -ItemType Directory -Force -Path $apkDir | Out-Null

function Get-Adb {
  $c=@("$ScriptDir\platform-tools\adb.exe","$env:USERPROFILE\platform-tools\adb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if(-not $c){ throw "ADB nao encontrado." } ; return $c
}
$Adb = Get-Adb
if(-not (& $Adb devices | Select-String "\tdevice$")){ Write-Host "[!] Nenhum celular autorizado conectado." -ForegroundColor Red; exit 1 }

if($Pkg -notmatch '^[A-Za-z0-9_.]+$'){ Write-Host "[!] Pacote invalido." -ForegroundColor Red; exit 1 }
if(-not ((& $Adb shell pm list packages $Pkg) | Where-Object { $_.Trim() -eq "package:$Pkg" })){
  Write-Host ("[!] {0} nao esta instalado neste celular." -f $Pkg) -ForegroundColor Yellow; exit 1
}

# nome base do arquivo: -Nome sanitizado, ou o proprio pacote
$base = if($Nome){ ($Nome -replace '[\\/:*?"<>|]','').Trim() } else { '' }
if(-not $base){ $base = $Pkg }

$paths = @((& $Adb shell pm path $Pkg) | ForEach-Object { ($_ -replace 'package:','').Trim() } | Where-Object { $_ -like '*.apk' })
# versao instalada (para registrar)
$dump  = (& $Adb shell dumpsys package $Pkg | Out-String)
$vName = ([regex]::Match($dump,'versionName=(\S+)')).Groups[1].Value
$vCode = ([regex]::Match($dump,'versionCode=(\d+)')).Groups[1].Value

function PullOk($src,$dst){
  if(Test-Path $dst){ Remove-Item $dst -Force -ErrorAction SilentlyContinue }
  & $Adb pull $src $dst 2>$null | Out-Null
  return (Test-Path $dst) -and (([System.IO.File]::ReadAllBytes($dst)[0..1] -join ',') -eq '80,75')
}

Write-Host ("== Extrair {0}  ({1}) ==" -f $base,$Pkg) -ForegroundColor Cyan
$dest=''
if($paths.Count -eq 1){
  $arq="$base.apk"; $out=Join-Path $apkDir $arq; $tmp="$out.part"
  if(PullOk $paths[0] $tmp){ Move-Item $tmp $out -Force; $dest=$arq
    Write-Host ("  [ok] {0} ({1} MB)" -f $arq,[math]::Round((Get-Item $out).Length/1MB,1)) -ForegroundColor Green }
  else { Write-Host "  [erro] extracao falhou" -ForegroundColor Red; exit 1 }
} else {
  $bdir="$base-bundle"; $bp=Join-Path $apkDir $bdir
  New-Item -ItemType Directory -Force -Path $bp | Out-Null
  Get-ChildItem $bp -Filter *.apk -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $okc=0; foreach($p in $paths){ if(PullOk $p (Join-Path $bp (Split-Path $p -Leaf))){ $okc++ } }
  $dest=$bdir
  $mb=[math]::Round(((Get-ChildItem $bp -Filter *.apk | Measure-Object Length -Sum).Sum)/1MB,1)
  Write-Host ("  [ok] {0}/{1} arquivos (split) -> {2}\ ({3} MB)" -f $okc,$paths.Count,$bdir,$mb) -ForegroundColor Green
}

# registra a versao em _versoes.json (sem BOM, para o Node ler)
try{
  $vf = Join-Path $apkDir '_versoes.json'
  $j=@{}
  if(Test-Path $vf){ try{ (Get-Content $vf -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $j[$_.Name]=$_.Value } }catch{} }
  $j[$dest]=@{ pkg=$Pkg; versionName=$vName; versionCode=$vCode; data=(Get-Date -Format 's') }
  [System.IO.File]::WriteAllText($vf, ($j | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ("  versao registrada: {0} (code {1})" -f $vName,$vCode) -ForegroundColor DarkGray
}catch{ Write-Host ("  [aviso] nao registrou a versao: {0}" -f $_.Exception.Message) -ForegroundColor DarkGray }

Write-Host ">>> Concluido. <<<"
