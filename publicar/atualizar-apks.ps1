<#
  atualizar-apks.ps1 — baixa os APKs OFICIAIS mais recentes para a pasta .\apks
   - WhatsApp   : whatsapp.com (oficial)
   - Telegram   : telegram.org (oficial)
   - Island     : github.com/oasisfeng/island (release mais recente)
  Uso:  powershell -ExecutionPolicy Bypass -File .\atualizar-apks.ps1
#>
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$apkDir = Join-Path $ScriptDir "apks"
New-Item -ItemType Directory -Force -Path $apkDir | Out-Null
# ADB (embutido ou no USERPROFILE) - usado para extrair apps sem URL oficial
$adb = @("$ScriptDir\platform-tools\adb.exe","$env:USERPROFILE\platform-tools\adb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

function Baixar([string]$nome,[string]$url,[string]$arquivo){
  $out = Join-Path $apkDir $arquivo
  $tmp = "$out.part"   # baixa no .part e so substitui no fim (atomico): se interromper, nao corrompe o APK bom
  Write-Host ("== {0} ==" -f $nome) -ForegroundColor Cyan
  Write-Host ("  baixando: {0}" -f $url)
  try {
    if(Test-Path $tmp){ Remove-Item $tmp -Force }
    Invoke-WebRequest -Uri $url -OutFile $tmp -UserAgent "Mozilla/5.0 (Android)" -MaximumRedirection 6 -ErrorAction Stop
    $hdr = [System.IO.File]::ReadAllBytes($tmp)[0..1] -join ','
    if($hdr -ne '80,75'){ Write-Host "  [FALHOU] nao parece um APK valido (header=$hdr) - mantido o anterior" -ForegroundColor Red; Remove-Item $tmp -Force -ErrorAction SilentlyContinue; return }
    Move-Item -Path $tmp -Destination $out -Force
    $mb = [math]::Round((Get-Item $out).Length/1MB,1)
    Write-Host ("  [ok] {0} ({1} MB)" -f $arquivo, $mb) -ForegroundColor Green
  } catch {
    Write-Host ("  [erro] {0} - mantido o APK anterior" -f $_.Exception.Message) -ForegroundColor Red
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

# Extrai um app JA INSTALADO no celular (apps sem URL oficial: Facebook/Meta, WA Business...).
# 1 APK -> salva como <arquivo>.apk;  varios (split) -> pasta <bundleDir>\ com base+splits.
function ExtrairDoCelular([string]$nome,[string]$pkg,[string]$arquivo,[string]$bundleDir){
  Write-Host ("== {0} (extrair do celular) ==" -f $nome) -ForegroundColor Cyan
  if(-not $adb){ Write-Host "  [pulado] adb nao encontrado" -ForegroundColor DarkGray; return }
  if(-not (& $adb devices | Select-String "\tdevice$")){ Write-Host "  [pulado] nenhum celular autorizado conectado" -ForegroundColor DarkGray; return }
  $paths = @((& $adb shell pm path $pkg) | ForEach-Object { ($_ -replace 'package:','').Trim() } | Where-Object { $_ -like '*.apk' })
  if(-not $paths){ Write-Host ("  [pulado] {0} nao esta instalado neste celular" -f $pkg) -ForegroundColor DarkGray; return }
  function PullOk($src,$dst){
    if(Test-Path $dst){ Remove-Item $dst -Force -ErrorAction SilentlyContinue }
    & $adb pull $src $dst 2>$null | Out-Null
    return (Test-Path $dst) -and (([System.IO.File]::ReadAllBytes($dst)[0..1] -join ',') -eq '80,75')
  }
  if($paths.Count -eq 1){
    $out = Join-Path $apkDir $arquivo; $tmp = "$out.part"
    if(PullOk $paths[0] $tmp){ Move-Item $tmp $out -Force; Write-Host ("  [ok] {0} ({1} MB)" -f $arquivo,[math]::Round((Get-Item $out).Length/1MB,1)) -ForegroundColor Green }
    else { Write-Host "  [erro] extracao falhou - mantido o anterior" -ForegroundColor Red; Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  } else {
    $bdir = Join-Path $apkDir $bundleDir
    New-Item -ItemType Directory -Force -Path $bdir | Out-Null
    Get-ChildItem $bdir -Filter *.apk -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $okc = 0
    foreach($p in $paths){
      $dst = Join-Path $bdir (Split-Path $p -Leaf)
      if(PullOk $p $dst){ $okc++ } else { Write-Host ("  [erro] split {0}" -f (Split-Path $p -Leaf)) -ForegroundColor Red }
    }
    Write-Host ("  [ok] {0}/{1} arquivos (split) -> {2}\" -f $okc,$paths.Count,$bundleDir) -ForegroundColor Green
  }
}

# WhatsApp e Telegram: URLs oficiais diretas
Baixar "WhatsApp" "https://www.whatsapp.com/android/current/WhatsApp.apk" "WhatsApp.apk"
Baixar "Telegram" "https://telegram.org/dl/android/apk" "Telegram.apk"

# Island: descobre o asset .apk do release mais recente via API do GitHub
Write-Host "== Island ==" -ForegroundColor Cyan
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/oasisfeng/island/releases/latest" -Headers @{ "User-Agent"="ps" } -ErrorAction Stop
  $asset = $rel.assets | Where-Object { $_.name -like "*.apk" } | Select-Object -First 1
  if($asset){
    Write-Host ("  versao: {0}" -f $rel.tag_name)
    Baixar "Island" $asset.browser_download_url "Island.apk"
  } else { Write-Host "  [erro] nenhum APK no release" -ForegroundColor Red }
} catch { Write-Host ("  [erro] {0}" -f $_.Exception.Message) -ForegroundColor Red }

# WhatsApp Business: nao tem URL oficial avulsa -> re-extrai de um celular conectado que o tenha
Write-Host "== WhatsApp Business ==" -ForegroundColor Cyan
$adb = @("$ScriptDir\platform-tools\adb.exe","$env:USERPROFILE\platform-tools\adb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if(-not $adb){ Write-Host "  [pulado] adb nao encontrado" -ForegroundColor DarkGray }
else {
  $dev = (& $adb devices | Select-String "\tdevice$")
  if(-not $dev){ Write-Host "  [pulado] nenhum celular conectado (mantido o APK atual)" -ForegroundColor DarkGray }
  else {
    $path = ((& $adb shell pm path com.whatsapp.w4b) -join "`n" | Select-String 'package:(\S+base\.apk)' | ForEach-Object { $_.Matches[0].Groups[1].Value }) | Select-Object -First 1
    if(-not $path){ Write-Host "  [pulado] WA Business nao instalado no celular conectado" -ForegroundColor DarkGray }
    else {
      $out = Join-Path $apkDir "WhatsAppBusiness.apk"; $tmp = "$out.part"
      Write-Host "  extraindo do celular: $path"
      & $adb pull $path $tmp 2>$null | Out-Null
      if((Test-Path $tmp) -and (([System.IO.File]::ReadAllBytes($tmp)[0..1] -join ',') -eq '80,75')){
        Move-Item $tmp $out -Force
        Write-Host ("  [ok] WhatsAppBusiness.apk ({0} MB)" -f [math]::Round((Get-Item $out).Length/1MB,1)) -ForegroundColor Green
      } else { Write-Host "  [erro] extracao falhou - mantido o APK anterior" -ForegroundColor Red; Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    }
  }
}

# Apps Meta: sem URL oficial -> extrai do celular conectado que os tenha instalados (Play Store)
ExtrairDoCelular "Facebook"            "com.facebook.katana"     "Facebook.apk"          "facebook-bundle"
ExtrairDoCelular "Facebook Lite"       "com.facebook.lite"       "FacebookLite.apk"      "facebook-lite-bundle"
ExtrairDoCelular "Anuncios da Meta"    "com.facebook.adsmanager" "MetaAds.apk"           "metaads-bundle"
ExtrairDoCelular "Meta Business Suite" "com.facebook.pages.app"  "MetaBusinessSuite.apk" "metabusiness-bundle"

Write-Host "`n>>> APKs atualizados em $apkDir <<<" -ForegroundColor Magenta
