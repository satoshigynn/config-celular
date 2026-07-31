<#
================================================================
  gerenciar-app.ps1  -  Desinstala / instala / reinstala / limpa
                        dados de UM app especifico (WhatsApp etc.)
================================================================
  Usado pelo painel (secao "Resetar apps") para ZERAR os dados/logs
  de um WhatsApp/Telegram (volta como recem-instalado).

  USO:
    powershell -ExecutionPolicy Bypass -File .\gerenciar-app.ps1 -Action reinstall -App whatsapp
    powershell -ExecutionPolicy Bypass -File .\gerenciar-app.ps1 -Action clear -App whatsapp -User 10

  Acoes: uninstall | install | reinstall | clear
    uninstall  remove o app (e os dados) do perfil indicado
    install    perfil principal: instala o APK de .\apks (fallback p/ bundle)
               perfil de trabalho (-User != 0): recria o clone (install-existing)
    reinstall  uninstall + install  -> zera todos os dados/logs do app
    clear      'pm clear': apaga dados/logs sem remover o app

  Apps:  whatsapp | wabusiness | telegram | island

  -User   '0' (padrao) = perfil principal.
          '10' (ou outro) = perfil de TRABALHO do Island (o clone).
          As acoes afetam SOMENTE o perfil indicado.
================================================================
#>
param(
  [Parameter(Mandatory=$true)][ValidateSet('uninstall','install','reinstall','clear')][string]$Action,
  [Parameter(Mandatory=$true)][string]$App,
  [string]$User = '0',
  [switch]$DryRun
)

# Continue: o adb.exe escreve no stderr em situacoes normais; o script faz sua propria checagem.
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if(-not ($User -match '^\d+$')){ $User = '0' }
$IsClone = ($User -ne '0')
$Where   = if($IsClone){ "clone (user $User)" } else { "principal" }

# ---------- localizar ADB (embutido na pasta, ou no USERPROFILE) ----------
function Get-Adb {
  $cands = @("$ScriptDir\platform-tools\adb.exe", "$env:USERPROFILE\platform-tools\adb.exe")
  foreach($c in $cands){ if(Test-Path $c){ return $c } }
  throw "ADB nao encontrado (esperado em .\platform-tools\adb.exe)."
}
$Adb = Get-Adb

# ---------- exige 1 aparelho conectado e AUTORIZADO ----------
$dev = (& $Adb devices) | Select-String "\tdevice$"
if(-not $dev){
  Write-Host "[!] Nenhum celular autorizado conectado (ligue a Depuracao USB e toque em PERMITIR)." -ForegroundColor Red
  exit 1
}

# ---------- catalogo dos apps gerenciaveis ----------
$APPS = @{
  whatsapp   = @{ name='WhatsApp';          apk='WhatsApp.apk';         pkgs=@('com.whatsapp') }
  wabusiness = @{ name='WhatsApp Business'; apk='WhatsAppBusiness.apk'; bundle='wa-business-bundle'; pkgs=@('com.whatsapp.w4b') }
  telegram   = @{ name='Telegram';          apk='Telegram.apk';         pkgs=@('org.telegram.messenger','org.telegram.messenger.web') }
  island     = @{ name='Island';            apk='Island.apk';           pkgs=@('com.oasisfeng.island') }
  cloneapp   = @{ name='Clone App';         apk='CloneApp.apk';         pkgs=@('com.pengyou.cloneapp') }
  facebook     = @{ name='Facebook';            apk='Facebook.apk';          bundle='facebook-bundle';       pkgs=@('com.facebook.katana') }
  facebooklite = @{ name='Facebook Lite';       apk='FacebookLite.apk';      bundle='facebook-lite-bundle';  pkgs=@('com.facebook.lite') }
  metaads      = @{ name='Anuncios da Meta';    apk='MetaAds.apk';           bundle='metaads-bundle';        pkgs=@('com.facebook.adsmanager') }
  metabusiness = @{ name='Meta Business Suite'; apk='MetaBusinessSuite.apk'; bundle='metabusiness-bundle';    pkgs=@('com.facebook.pages.app') }
}
# merge dos apps PERSONALIZADOS (apps-catalog.json, adicionados pelo painel)
$catPath = Join-Path $ScriptDir 'apps-catalog.json'
if(Test-Path $catPath){
  try{
    $cat = Get-Content $catPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($e in @($cat.custom)){
      if($e -and $e.id){
        $APPS[[string]$e.id] = @{ name=[string]$e.name; apk=[string]$e.apk; bundle=[string]$e.bundle; pkgs=@($e.pkgs) }
      }
    }
  }catch{ Write-Host "apps-catalog.json invalido - ignorado" -ForegroundColor Yellow }
}
if(-not $APPS.ContainsKey($App)){ Write-Host ("[!] App desconhecido: {0}" -f $App) -ForegroundColor Red; exit 1 }
$info   = $APPS[$App]
$apkDir = Join-Path $ScriptDir "apks"

# 'pm list packages <filtro>' casa por SUBSTRING (ex: 'org.telegram.messenger'
# tambem retornaria '...messenger.web'); por isso comparamos a LINHA EXATA.
function Has-ExactPkg($lines,[string]$pkg){ return [bool](@($lines) | Where-Object { $_ -and $_.Trim() -eq "package:$pkg" }) }
# pacote instalado para um user especifico?
function Pkg-OnUser([string]$pkg){ return (Has-ExactPkg (& $Adb shell pm list packages --user $User $pkg) $pkg) }
# pacote conhecido pelo sistema (qualquer user) - usado para o install-existing do clone
function Pkg-OnSystem([string]$pkg){ return (Has-ExactPkg (& $Adb shell pm list packages $pkg) $pkg) }
function Installed-Here(){ @($info.pkgs | Where-Object { Pkg-OnUser $_ }) }

# le as ABIs (pastas lib/<abi>/) de dentro de um APK; vazio = sem libs nativas (instala em qualquer um)
function Get-ApkAbis([string]$path){
  try{
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $z=[System.IO.Compression.ZipFile]::OpenRead($path)
    $a=@($z.Entries | Where-Object { $_.FullName -match '^lib/[^/]+/' } | ForEach-Object { ($_.FullName -split '/')[1] } | Sort-Object -Unique)
    $z.Dispose(); return $a
  } catch { return @() }
}

# ---------- acoes ----------
function Do-Uninstall(){
  $inst = Installed-Here
  if(-not $inst){ Write-Host ("  {0,-30} [nao instalado no perfil $Where]" -f $info.name) -ForegroundColor DarkGray; return }
  foreach($p in $inst){
    if($DryRun){ Write-Host ("  [seria desinstalado] {0} (user $User)" -f $p) -ForegroundColor Yellow; continue }
    # --user $User: remove so do perfil indicado (preserva os outros perfis)
    $r = (& $Adb shell pm uninstall --user $User $p 2>&1 | Out-String)
    $ok = $r -match 'Success'
    Write-Host ("  {0,-30} {1}" -f $p, $(if($ok){"[desinstalado]"}else{"[FALHOU] "+(($r -replace '\s+',' ').Trim())})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
  }
}

function Do-Clear(){
  $inst = Installed-Here
  if(-not $inst){ Write-Host ("  {0,-30} [nao instalado no perfil $Where]" -f $info.name) -ForegroundColor DarkGray; return }
  foreach($p in $inst){
    if($DryRun){ Write-Host ("  [seria limpo] {0} (user $User)" -f $p) -ForegroundColor Yellow; continue }
    $r = (& $Adb shell pm clear --user $User $p 2>&1 | Out-String)
    $ok = $r -match 'Success'
    Write-Host ("  {0,-30} {1}" -f $p, $(if($ok){"[dados limpos]"}else{"[FALHOU] "+(($r -replace '\s+',' ').Trim())})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
  }
}

# instala no PERFIL PRINCIPAL a partir do APK (com fallback p/ bundle por arquitetura)
function Do-Install-Main(){
  if($DryRun){ Write-Host ("  [seria instalado] {0}" -f $info.name) -ForegroundColor Yellow; return }
  $devAbiList = @(((& $Adb shell getprop ro.product.cpu.abilist) -join '').Trim() -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if(-not $devAbiList){ $devAbiList = @(((& $Adb shell getprop ro.product.cpu.abi) -join '').Trim()) }
  $installed = $false

  # 1) APK unico (com checagem de arquitetura)
  $apkPath = Join-Path $apkDir $info.apk
  if(Test-Path $apkPath){
    $abis  = Get-ApkAbis $apkPath
    $abiOk = ($abis.Count -eq 0) -or (@($abis | Where-Object { $devAbiList -contains $_ }).Count -gt 0)
    if($abiOk){
      $r = (& $Adb install -r -d $apkPath 2>&1 | Out-String)
      if($r -match 'Success'){ Write-Host ("  {0,-30} [instalado]" -f $info.apk) -ForegroundColor Green; $installed=$true }
      elseif($r -notmatch 'NO_MATCHING_ABIS'){ Write-Host ("  {0,-30} [FALHOU] {1}" -f $info.apk, (($r -replace '\s+',' ').Trim())) -ForegroundColor Yellow }
    } else {
      Write-Host ("  {0,-30} [ignorado] build {1} (aparelho e' {2})" -f $info.apk, ($abis -join '/'), $devAbiList[0]) -ForegroundColor DarkGray
    }
  } elseif(-not $info.bundle) {
    Write-Host ("  {0,-30} [ausente na pasta apks]" -f $info.apk) -ForegroundColor Yellow
  }

  # 2) Fallback: bundle (base + splits) p/ a arquitetura do aparelho (ex: WA Business 32-bit)
  if(-not $installed -and $info.bundle){
    $bDir = Join-Path $apkDir $info.bundle
    if(Test-Path $bDir){
      $devAbi = ((& $Adb shell getprop ro.product.cpu.abi) -join '').Trim() -replace '-','_'
      $abiPat = 'config\.(arm64_v8a|armeabi_v7a|armeabi|x86_64|x86|mips)\.'
      $apks   = @(Get-ChildItem $bDir -Filter *.apk)
      # splits de ARQUITETURA (config.<abi>). Se existirem mas nenhum casar com o aparelho, pula.
      # Se NAO houver nenhum split de abi (so feature splits, ex: Facebook), instala tudo normalmente.
      $abiSplits = @($apks | Where-Object { $_.Name -match $abiPat })
      $hasAbi    = @($abiSplits | Where-Object { $_.Name -match ("config\.$([regex]::Escape($devAbi))\.") })
      if($abiSplits.Count -gt 0 -and $hasAbi.Count -eq 0){
        Write-Host ("  {0,-30} [pulado] bundle sem split p/ {1}" -f $info.bundle, $devAbi) -ForegroundColor DarkGray
      } else {
        # base + splits nao-abi (dpi/idioma) + o split do abi DESTE aparelho
        $sel = @($apks | Where-Object { ($_.Name -notmatch $abiPat) -or ($_.Name -match ("config\.$([regex]::Escape($devAbi))\.")) })
        $r   = (& $Adb install-multiple -r -d @($sel.FullName) 2>&1 | Out-String)
        $ok  = $r -match 'Success'
        Write-Host ("  {0,-30} {1}" -f $info.bundle, $(if($ok){"[instalado (bundle $devAbi)]"}else{"[FALHOU] "+(($r -replace '\s+',' ').Trim())})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
        if($ok){ $installed=$true }
      }
    }
  }

  if(-not $installed){ Write-Host "  (nada foi instalado)" -ForegroundColor DarkGray }
}

# instala no PERFIL DE TRABALHO (clone): habilita p/ o user o pacote ja presente no sistema
function Do-Install-Clone(){
  $any = $false
  foreach($p in $info.pkgs){
    if(-not (Pkg-OnSystem $p)){ continue }   # so da p/ clonar o que ja existe no aparelho
    if($DryRun){ Write-Host ("  [seria clonado] {0} (user $User)" -f $p) -ForegroundColor Yellow; $any=$true; continue }
    $r  = (& $Adb shell pm install-existing --user $User $p 2>&1 | Out-String)
    $ok = $r -match 'installed for user|Success'
    Write-Host ("  {0,-30} {1}" -f $p, $(if($ok){"[clonado no user $User]"}else{"[FALHOU] "+(($r -replace '\s+',' ').Trim())})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
    if($ok){ $any=$true }
  }
  if(-not $any){ Write-Host "  (nada para clonar - o app precisa existir no perfil principal)" -ForegroundColor DarkGray }
}

function Do-Install(){ if($IsClone){ Do-Install-Clone } else { Do-Install-Main } }

# ---------- executar ----------
Write-Host ("== {0} [{1}]: {2}{3} ==" -f $info.name, $Where, $Action, $(if($DryRun){" (SIMULACAO)"}else{""})) -ForegroundColor Cyan
switch($Action){
  'uninstall' { Do-Uninstall }
  'clear'     { Do-Clear }
  'install'   { Do-Install }
  'reinstall' { Do-Uninstall; Do-Install }
}
Write-Host ">>> Concluido. <<<"
