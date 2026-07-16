<#
================================================================
  setup-celular.ps1  -  Automacao de limpeza + apps (Realme/ColorOS)
================================================================
  O que faz, na ordem:
   1. Localiza o ADB (baixa o oficial do Google se nao existir)
   2. Espera um celular conectado e AUTORIZADO
   3. Remove (debloat) apps de fabrica / lixo  -- AUTO-DETECTADO por modelo
   4. Congela servicos de push/ads em segundo plano
   5. Instala os APKs da pasta .\apks (WhatsApp, Telegram, Island...)
   6. WhatsApp Business: instala pela App Market (busca + Instalar)
   7. Island: cria o Perfil de Trabalho e CLONA os apps nele

  DEBLOAT AUTO: nao usa lista fixa. Remove (a) TODOS os apps de terceiros
  (pm -3) fora da whitelist $KeepThirdParty, e (b) apps de sistema que casam
  $BloatPatterns. A lista $Protect e' rede de seguranca: o que casar nela
  NUNCA e' removido (telefone, contatos, launcher, Play, App Market, etc.).
  Ajuste esses 3 arrays no topo da secao 3 conforme necessario.

  USO:
     Plugue o celular (Depuracao USB ligada + PC autorizado) e rode:
        powershell -ExecutionPolicy Bypass -File .\setup-celular.ps1
     Num modelo NOVO, rode antes com -DryRun para revisar o que sera removido:
        powershell -ExecutionPolicy Bypass -File .\setup-celular.ps1 -DryRun

  Parametros opcionais:
     -DryRun          nao altera nada; so mostra o que faria (RECOMENDADO 1a vez)
     -SkipDebloat     nao remove bloatware (nem a telemetria)
     -SkipApks        nao instala os APKs locais
     -SkipBusiness    nao instala o WhatsApp Business pela App Market
     -SkipIsland      nao cria perfil de trabalho nem clona apps
     -SkipTheme       nao ativa o tema escuro
     -SkipNativeClone nao usa o clonador nativo do realme (WhatsApp/WA Business)
     -SkipSuggestions nao desliga "Mostrar aplicativos sugeridos" na gaveta
================================================================
#>
param(
  [switch]$SkipDebloat,
  [switch]$SkipApks,
  [switch]$SkipBusiness,
  [switch]$SkipIsland,
  [switch]$SkipTheme,
  [switch]$SkipDisplay,
  [switch]$SkipNativeClone,
  [switch]$SkipSuggestions,
  [switch]$SkipPerms,
  [switch]$SkipSpeed,             # desativar animacoes (mais rapido)
  [switch]$SkipBattery,           # ignorar economia de bateria (apps nao param)
  [int]$Brightness = -1,          # 0..255 (-1 = padrao: maximo 255)
  [int]$AdaptiveBrightness = -1,  # 0=off, 1=on (-1 = padrao: off)
  [int]$ScreenTimeout = -1,       # apagar tela em ms (-1 = padrao: 300000 = 5 min)
  [switch]$DryRun
)

# Continue (nao Stop): o adb.exe escreve no stderr em varias situacoes normais; com Stop
# + '2>&1' o PowerShell abortaria o script. O script faz sua propria checagem de sucesso.
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- config.json (listas editaveis); fallback = padroes internos ----------
$cfg = $null
$cfgPath = Join-Path $ScriptDir "config.json"
if(Test-Path $cfgPath){
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { Write-Host "config.json invalido - usando padroes internos" -ForegroundColor Yellow }
}
function Cfg([string]$key,$default){ if($cfg -and $null -ne $cfg.$key){ return $cfg.$key } else { return $default } }

# ---------- 1. Localizar / baixar ADB ----------
function Get-Adb {
  $cands = @(
    "$ScriptDir\platform-tools\adb.exe",
    "$env:USERPROFILE\platform-tools\adb.exe"
  )
  foreach($c in $cands){ if(Test-Path $c){ return $c } }
  Write-Host "ADB nao encontrado. Baixando o oficial do Google..." -ForegroundColor Yellow
  $zip = "$env:TEMP\platform-tools.zip"
  Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip -ErrorAction Stop
  Expand-Archive -Path $zip -DestinationPath $env:USERPROFILE -Force -ErrorAction Stop
  return "$env:USERPROFILE\platform-tools\adb.exe"
}
$Adb = Get-Adb
function adbx { & $Adb @args }

# ---------- 2. Esperar celular autorizado ----------
# Respeita o alvo fixado em $env:ANDROID_SERIAL (o painel passa o aparelho escolhido).
# Se HA um alvo fixado, ESPERA por ele e NUNCA troca por outro celular (evita configurar
# o aparelho errado se o alvo piscar). Sem alvo, pega o 1o online e o fixa (evita o erro
# "more than one device" quando ha 2+ conectados).
function Wait-Device {
  Write-Host "Aguardando celular (Depuracao USB + autorizar este PC)..." -ForegroundColor Cyan
  $want = $env:ANDROID_SERIAL
  for($i=0; $i -lt 120; $i++){
    $online = @((& $Adb devices) | Select-String "\tdevice$" | ForEach-Object { ($_ -split "\t")[0].Trim() } | Where-Object { $_ })
    if($want){
      if($online -contains $want){ Write-Host "Celular conectado: $want" -ForegroundColor Green; return }
      if(($i % 5) -eq 0){ Write-Host ("  Aguardando o aparelho fixado ({0}) reconectar..." -f $want) -ForegroundColor Yellow }
    }
    elseif($online.Count -gt 0){
      $env:ANDROID_SERIAL = $online[0]
      if($online.Count -gt 1){ Write-Host ("  ({0} celulares conectados; configurando SO {1}. Escolha no painel ou desconecte os outros.)" -f $online.Count, $online[0]) -ForegroundColor Yellow }
      Write-Host ("Celular conectado: {0}" -f $online[0]) -ForegroundColor Green
      return
    }
    if((& $Adb devices) -match "unauthorized"){
      Write-Host "  -> No celular, toque em PERMITIR (marque 'sempre permitir')." -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 2
  }
  if($want){ throw ("O aparelho fixado ($want) nao reconectou a tempo.") } else { throw "Nenhum celular autorizado apareceu." }
}
Wait-Device
# mantem a tela ligada durante a automacao (evita central travada quando a tela dorme)
if(-not $DryRun){ & $Adb shell svc power stayon true 2>$null | Out-Null }
# Detecta se e' realme/ColorOS (App Market, OTA Oppo). As etapas 6/9/10 sao exclusivas dele.
$pkgsAll = (& $Adb shell pm list packages) 2>$null
$IsRealme = ($pkgsAll -match 'com\.oppo\.ota') -or ($pkgsAll -match 'com\.heytap\.market') -or ($pkgsAll -match 'com\.oplus\.')
# Xiaomi/MIUI/HyperOS: clonador proprio "Apps duplos" (XSpace) via com.miui.securitycore
$IsXiaomi = ($pkgsAll -match 'com\.miui\.securitycore')
# Samsung/One UI: clonador "Mensageiro Duplo" (Dual Messenger) via com.samsung.android.da.daagent
$IsSamsung = ($pkgsAll -match 'com\.samsung\.android\.da\.daagent')
$HasClone = $IsRealme -or $IsXiaomi -or $IsSamsung
if(-not $HasClone){ Write-Host "  (Sem clonador nativo suportado: essa etapa e ajustes de launcher serao pulados)" -ForegroundColor DarkGray }
elseif($IsXiaomi){ Write-Host "  (Xiaomi/MIUI detectado: clonador nativo usara 'Apps duplos')" -ForegroundColor DarkGray }
elseif($IsSamsung){ Write-Host "  (Samsung/One UI detectado: clonador nativo usara 'Mensageiro Duplo')" -ForegroundColor DarkGray }

# ---------- helpers de UI (uiautomator) ----------
function Get-UI {
  # o 'uiautomator dump' falha de forma intermitente no ColorOS ("null root node
  # returned by UiTestAutomationBridge"), geralmente durante animacoes/transicoes.
  # Nesse caso o /sdcard/ui.xml NAO e criado. Sem tratar, o codigo antigo lia um XML
  # velho do cache (decisao errada). Aqui: limpa o cache, detecta a falha e re-tenta.
  $local = Join-Path $env:TEMP "ui.xml"
  for($try=0; $try -lt 5; $try++){
    Remove-Item $local -Force -ErrorAction SilentlyContinue
    & $Adb shell rm -f /sdcard/ui.xml 2>$null | Out-Null
    $dump = (& $Adb shell uiautomator dump /sdcard/ui.xml 2>&1 | Out-String)
    if($dump -match 'null root node|ERROR:|could not get idle|Killed'){ Start-Sleep -Milliseconds 800; continue }
    & $Adb pull /sdcard/ui.xml $local 2>$null | Out-Null
    & $Adb shell rm -f /sdcard/ui.xml 2>$null | Out-Null
    if(Test-Path $local){
      $xml = ''
      try { $xml = [System.IO.File]::ReadAllText($local,[System.Text.Encoding]::UTF8) } catch { $xml = '' }
      if($xml.Length -gt 100){ return $xml }
    }
    Start-Sleep -Milliseconds 600
  }
  return ''
}
# acha o centro do node cujo $attr = $val (e tem bounds) e clica
function Tap-By([string]$xml,[string]$attr,[string]$val,[switch]$contains){
  $needle = if($contains){ '[^"]*' + [regex]::Escape($val) + '[^"]*' } else { [regex]::Escape($val) }
  $b = '\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]'
  $p1 = '<node[^>]*\b' + $attr + '="' + $needle + '"[^>]*bounds="' + $b + '"'
  $p2 = '<node[^>]*bounds="' + $b + '"[^>]*\b' + $attr + '="' + $needle + '"'
  $m = [regex]::Match($xml,$p1); if(-not $m.Success){ $m = [regex]::Match($xml,$p2) }
  if($m.Success){
    $cx=[int](([int]$m.Groups[1].Value+[int]$m.Groups[3].Value)/2)
    $cy=[int](([int]$m.Groups[2].Value+[int]$m.Groups[4].Value)/2)
    & $Adb shell input tap $cx $cy | Out-Null
    return $true
  }
  return $false
}

# ================= 3. DEBLOAT (auto-deteccao) =================
# (a) PROTEGIDOS: nunca remover - rede de seguranca para qualquer modelo.
#     Mesmo que algo caia nas regras abaixo, se casar aqui e' poupado.
$Protect = Cfg 'protect' @(
  '^com\.android\.',                 # componentes do Android (telefone, contatos, mms, etc.)
  '^com\.google\.android\.(gms|gsf|googlequicksearchbox|packageinstaller|webview|tts|networkstack)',
  'android$', '^android\b',
  'launcher','systemui','settings','telephony','telecom','dialer','contacts','mms','messaging',
  'inputmethod','keyboard','providers','permission','wifi','bluetooth','nfc','camera2?$','soundrecorder',
  'com\.heytap\.market',             # App Market (atualizacoes) - manter!
  'com\.coloros\.(phonemanager|safecenter|securitypermission|filemanager)',
  'com\.coloros\.gallery3d','com\.realme\.backuprestore','com\.oplus\.','com\.oppo\.ota'
)
# (b) PADROES de bloatware de SISTEMA conhecido (vendor/parceiros).
$BloatPatterns = Cfg 'bloatPatterns' @(
  '^com\.facebook\.',                # stubs do Facebook
  '^com\.booking$',
  'com\.heytap\.(browser|pictorial|reader|music|cloud|health|themestore)',
  'com\.coloros\.(video|weather2|weather\.service|childrenspace|operationManual|backuprestore\.romupdate)',
  'com\.oppo\.quicksearchbox','com\.realme\.(as\.music|smartdrive|moviestudio)',
  'com\.opos\.','com\.coloros\.assistantscreen'
)
# (c) Apps de TERCEIROS (pm -3) a PRESERVAR (whitelist). Vazio = remover todos.
$KeepThirdParty = Cfg 'keepThirdParty' @(
  'com\.whatsapp','org\.telegram','com\.oasisfeng\.island'   # nossos apps + island
)
# (d) REMOCAO FORCADA: apps de sistema Google/OEM que voce quer fora MESMO sendo
#     "protegidos". Sao nomes EXATOS de pacote (nao regex). Para um celular "cru".
$ForceRemove = Cfg 'forceRemove' @(
  "com.google.android.apps.tachyon",          # Meet
  "com.oplus.gamespace",                       # Jogos / Game Space
  "com.google.android.youtube",                # YouTube
  "com.google.android.apps.youtube.music",     # YT Music
  "com.google.android.videos",                 # Google TV
  "com.google.android.apps.subscriptions.red", # Google One
  "com.linkedin.android",                      # LinkedIn
  "com.fitbit.FitbitMobile"                    # Fitbit
)
function Match-Any([string]$s,[string[]]$pats){ foreach($p in $pats){ if($s -match $p){ return $true } }; return $false }

if(-not $SkipDebloat){
  Write-Host "`n== Debloat (auto) ==" -ForegroundColor Cyan
  if($DryRun){ Write-Host "  [DRY-RUN] nada sera removido, apenas listado." -ForegroundColor Yellow }
  $all = (& $Adb shell pm list packages)    | ForEach-Object { $_ -replace 'package:','' }
  $tp  = (& $Adb shell pm list packages -3) | ForEach-Object { $_ -replace 'package:','' }
  # alvos = (terceiros nao-whitelist) + (sistema que casa BloatPatterns), menos PROTEGIDOS
  $targets = New-Object System.Collections.Generic.List[string]
  foreach($p in $tp){ if(-not (Match-Any $p $KeepThirdParty) -and -not (Match-Any $p $Protect)){ [void]$targets.Add($p) } }
  foreach($p in $all){ if((Match-Any $p $BloatPatterns) -and -not (Match-Any $p $Protect)){ [void]$targets.Add($p) } }
  # remocao forcada (ignora $Protect): so adiciona os que existem no aparelho
  foreach($p in $ForceRemove){ if($all -contains $p){ [void]$targets.Add($p) } }
  $targets = $targets | Sort-Object -Unique
  if(-not $targets){ Write-Host "  Nada para remover." -ForegroundColor DarkGray }
  # arquivo de backup por aparelho (pra poder restaurar depois)
  $serial = ((& $Adb get-serialno) -join '').Trim()
  $logDir = Join-Path $ScriptDir "logs"; if(-not $DryRun){ New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  $remFile = Join-Path $logDir ("{0}-removidos.txt" -f ($serial -replace '[^A-Za-z0-9_.-]','_'))
  foreach($p in $targets){
    if($DryRun){ Write-Host ("  [seria removido] {0}" -f $p) -ForegroundColor Yellow; continue }
    $r = (& $Adb shell pm uninstall -k --user 0 $p) 2>&1
    $ok = ($r -match "Success")
    if($ok){ Add-Content -Path $remFile -Value $p -ErrorAction SilentlyContinue }
    Write-Host ("  {0,-45} {1}" -f $p, $(if($ok){"[removido]"}else{"[falhou/ausente]"})) -ForegroundColor $(if($ok){"Green"}else{"DarkGray"})
  }
}

# ============ 4. TELEMETRIA (removida junto com o debloat) ============
# Roda como parte do "Remover bloatware" (-SkipDebloat) - nao e mais uma etapa separada.
# ATENCAO: NAO mexer no com.heytap.mcs. Tanto DESABILITAR quanto REMOVER (mesmo com
# uninstall -k) esse servico de push causa o realme/ColorOS REINICIAR no meio do
# setup - o que derruba a conexao e PENDURA o 'adb install' seguinte. Por isso o mcs
# foi TIRADO da lista. Mantemos apenas a telemetria (com.nearme.statistics.rom).
$Disable = Cfg 'disableServices' @("com.nearme.statistics.rom")
if(-not $SkipDebloat){
  Write-Host "`n== Removendo telemetria (parte da limpeza) ==" -ForegroundColor Cyan
  $serialSvc  = ((& $Adb get-serialno) -join '').Trim()
  $logDirSvc  = Join-Path $ScriptDir "logs"
  if(-not $DryRun){ New-Item -ItemType Directory -Force -Path $logDirSvc | Out-Null }
  $remFileSvc = Join-Path $logDirSvc ("{0}-removidos.txt" -f ($serialSvc -replace '[^A-Za-z0-9_.-]','_'))
  $usersOut   = (& $Adb shell pm list users 2>$null) -join "`n"
  $usersSvc   = @([regex]::Matches($usersOut,'UserInfo\{(\d+)') | ForEach-Object { $_.Groups[1].Value })
  if(-not $usersSvc){ $usersSvc = @('0') }
  foreach($p in $Disable){
    if($DryRun){ Write-Host ("  [seria removido] {0}" -f $p) -ForegroundColor Yellow; continue }
    $any = $false
    foreach($u in $usersSvc){
      & $Adb shell pm enable --user $u $p 2>$null | Out-Null      # sai do estado desabilitado (evita o loop)
      $r = (& $Adb shell pm uninstall -k --user $u $p) 2>&1       # remove por perfil (mantem no firmware p/ restaurar)
      if($r -match 'Success'){ $any = $true }
    }
    if($any){ Add-Content -Path $remFileSvc -Value $p -ErrorAction SilentlyContinue }
    Write-Host ("  {0,-32} {1}" -f $p, $(if($any){"[removido]"}else{"[--/ausente]"})) -ForegroundColor $(if($any){"Green"}else{"DarkGray"})
  }
}

# ================= 5. INSTALAR APKS LOCAIS =================
# le as ABIs (pastas lib/<abi>/) de dentro de um APK; vazio = sem libs nativas (instala em qualquer um)
function Get-ApkAbis([string]$path){
  try{
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $z=[System.IO.Compression.ZipFile]::OpenRead($path)
    $a=@($z.Entries | Where-Object { $_.FullName -match '^lib/[^/]+/' } | ForEach-Object { ($_.FullName -split '/')[1] } | Sort-Object -Unique)
    $z.Dispose(); return $a
  } catch { return @() }
}
if(-not $SkipApks){
  $apkDir = Join-Path $ScriptDir "apks"
  if(Test-Path $apkDir){
    Write-Host "`n== Instalando APKs de .\apks ==" -ForegroundColor Cyan
    $devAbiList = @(((& $Adb shell getprop ro.product.cpu.abilist) -join '').Trim() -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if(-not $devAbiList){ $devAbiList = @(((& $Adb shell getprop ro.product.cpu.abi) -join '').Trim()) }
    Get-ChildItem $apkDir -Filter *.apk | ForEach-Object {
      if($DryRun){ Write-Host ("  [seria instalado] {0}" -f $_.Name) -ForegroundColor Yellow; return }
      # pula APKs de OUTRA arquitetura silenciosamente (ex: APK arm64 num aparelho 32-bit) - o bundle/loja cobre
      $abis = Get-ApkAbis $_.FullName
      if($abis.Count -gt 0 -and (@($abis | Where-Object { $devAbiList -contains $_ }).Count -eq 0)){
        Write-Host ("  {0,-28} [ignorado] build {1} (aparelho e' {2})" -f $_.Name, ($abis -join '/'), $devAbiList[0]) -ForegroundColor DarkGray
        return
      }
      # -r reinstala mantendo dados; -d permite "downgrade" (quando ja ha versao mais nova no aparelho)
      $r = (& $Adb install -r -d $_.FullName 2>&1 | Out-String)
      if($r -match "Success"){
        Write-Host ("  {0,-28} [instalado]" -f $_.Name) -ForegroundColor Green
      } else {
        $reason = if($r -match "NO_MATCHING_ABIS"){ "APK incompativel com a arquitetura deste celular (ex: APK arm64 num aparelho 32-bit)" }
                  elseif($r -match "already installed|newer version|VERSION_DOWNGRADE"){ "ja instalado (versao igual/mais nova)" }
                  elseif($r -match "INSTALL_FAILED_\w+"){ $Matches[0] }
                  else { ($r -replace '\s+',' ').Trim() }
        Write-Host ("  {0,-28} [pulado] {1}" -f $_.Name, $reason) -ForegroundColor Yellow
      }
    }
    # ---- BUNDLES (subpastas com base.apk + splits por arquitetura) -> install-multiple ----
    $devAbi = ((& $Adb shell getprop ro.product.cpu.abi) -join '').Trim() -replace '-','_'
    $abiPat = 'config\.(arm64_v8a|armeabi_v7a|armeabi|x86_64|x86|mips)\.'
    Get-ChildItem $apkDir -Directory | ForEach-Object {
      $bn=$_.Name; $apks=@(Get-ChildItem $_.FullName -Filter *.apk)
      if(-not $apks){ return }
      if($DryRun){ Write-Host ("  [seria instalado-multiplo] {0} ({1} arquivos)" -f $bn,$apks.Count) -ForegroundColor Yellow; return }
      # so pula se houver splits de arquitetura E nenhum casar; bundle so com feature splits (ex: Facebook) instala tudo
      $abiSplits = @($apks | Where-Object { $_.Name -match $abiPat })
      $hasAbi    = @($abiSplits | Where-Object { $_.Name -match ("config\.$([regex]::Escape($devAbi))\.") })
      if($abiSplits.Count -gt 0 -and $hasAbi.Count -eq 0){ Write-Host ("  {0,-28} [pulado] bundle sem split p/ {1}" -f $bn,$devAbi) -ForegroundColor DarkGray; return }
      # base + splits nao-abi (dpi/idioma) + o split do abi DESTE aparelho
      $sel = @($apks | Where-Object { ($_.Name -notmatch $abiPat) -or ($_.Name -match ("config\.$([regex]::Escape($devAbi))\.")) })
      $r = (& $Adb install-multiple -r -d @($sel.FullName) 2>&1 | Out-String)
      $ok = ($r -match "Success")
      Write-Host ("  {0,-28} {1}" -f $bn, $(if($ok){"[instalado (bundle $devAbi)]"}else{"[FALHOU] "+(($r -replace '\s+',' ').Trim())})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
    }
  } else {
    Write-Host "`n(Pasta .\apks nao existe - pulei instalacao de APKs)" -ForegroundColor DarkGray
  }
}

# ================= 6. WHATSAPP BUSINESS via APP MARKET =================
function Is-Installed([string]$pkg){
  return [bool]((& $Adb shell pm list packages $pkg) -match [regex]::Escape($pkg))
}
# dispensa dialogos conhecidos (promo "adicionar atalho", aviso de dados moveis)
function Dismiss-Dialogs(){
  $xml = Get-UI
  # aviso de dados moveis -> Continuar instalacao
  if(Tap-By $xml "resource-id" "com.heytap.market:id/continue_download_btn"){ Start-Sleep -Seconds 1; return $true }
  if(Tap-By $xml "text" "Continuar instalação"){ Start-Sleep -Seconds 1; return $true }
  # promo "adicionar icone de pesquisa a tela inicial" -> Cancelar
  if($xml -match "tela inicial" -and (Tap-By $xml "text" "Cancelar")){ Start-Sleep -Seconds 1; return $true }
  return $false
}
# Acha a linha do resultado cujo NOME == $name e toca no botao "Instalar" DAQUELA linha.
# Evita tocar em anuncios/patrocinados no topo (ex: Instagram) que tem o 1o "Instalar".
function Tap-InstallForRow([string]$xml,[string]$name){
  $rx = ($name -split '\s+' | ForEach-Object { [regex]::Escape($_) }) -join '\s+'
  $mt=[regex]::Match($xml,'text="'+$rx+'"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')
  if(-not $mt.Success){ return $false }
  $rowY=[int](([int]$mt.Groups[2].Value+[int]$mt.Groups[4].Value)/2)
  # content-desc varia: "Instalar" ou "Instalar Botão" (com espaco U+00A0). [^"]* cobre tudo.
  foreach($mb in [regex]::Matches($xml,'content-desc="Instalar[^"]*"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')){
    $by=[int](([int]$mb.Groups[2].Value+[int]$mb.Groups[4].Value)/2)
    if([math]::Abs($by-$rowY) -le 80){
      $bx=[int](([int]$mb.Groups[1].Value+[int]$mb.Groups[3].Value)/2)
      & $Adb shell input tap $bx $by | Out-Null
      return $true
    }
  }
  return $false
}
function Install-FromMarket([string]$pkg,[string]$query){
  if(Is-Installed $pkg){ Write-Host "  $pkg ja instalado." -ForegroundColor Green; return }
  Write-Host "  Abrindo App Market e buscando '$query'..." -ForegroundColor Cyan
  & $Adb shell am start -n com.heytap.market/.activity.MainActivity | Out-Null
  Start-Sleep -Seconds 3
  Dismiss-Dialogs | Out-Null
  # abre a tela de busca (a barra clicavel e' o actionbar_content)
  $xml = Get-UI
  if(-not (Tap-By $xml "resource-id" "com.heytap.market:id/actionbar_content")){
    Tap-By $xml "resource-id" "com.heytap.market:id/menu_actionbar_search_view" | Out-Null
  }
  Start-Sleep -Seconds 2
  Dismiss-Dialogs | Out-Null   # fecha a promo de atalho se aparecer
  # o EditText da busca ja vem focado; digita e confirma
  & $Adb shell input text ($query -replace ' ','%s') | Out-Null
  Start-Sleep -Milliseconds 800
  & $Adb shell input keyevent 66 | Out-Null
  Start-Sleep -Seconds 4
  # toca no "Instalar" DA LINHA cujo nome == $query (nao no 1o, que pode ser anuncio)
  $xml = Get-UI
  $tapped = Tap-InstallForRow $xml $query
  if($tapped){
    Write-Host "  Toquei em Instalar (resultado '$query')." -ForegroundColor Green
    Start-Sleep -Seconds 2
    Dismiss-Dialogs | Out-Null   # confirma aviso de dados moveis (se no 4G)
    Write-Host "  Aguardando download..." -ForegroundColor Cyan
    for($i=0;$i -lt 90;$i++){ if(Is-Installed $pkg){ Write-Host "  $pkg INSTALADO!" -ForegroundColor Green; return }; Start-Sleep -Seconds 3 }
    Write-Host "  (Ainda baixando ou falhou - confira o celular)" -ForegroundColor Yellow
  } else {
    Write-Host "  Resultado '$query' nao encontrado (so anuncios?). Pulei para NAO instalar errado." -ForegroundColor Yellow
  }
}
if(-not $SkipBusiness){
  Write-Host "`n== WhatsApp Business (loja) ==" -ForegroundColor Cyan
  if(Is-Installed "com.whatsapp.w4b"){ Write-Host "  [ja instalado]" -ForegroundColor Green }
  elseif($DryRun){ Write-Host "  [garantiria via loja] com.whatsapp.w4b" -ForegroundColor Yellow }
  elseif($IsRealme){ Install-FromMarket "com.whatsapp.w4b" "WhatsApp Business" }
  else { Write-Host "  [pulado] sem loja (por opcao). Coloque um APK UNIVERSAL do WA Business em .\apks (a etapa 5 instala)." -ForegroundColor Yellow }
}

# ================= 7. ISLAND: perfil de trabalho + clones =================
# apps a clonar: cada item lista os nomes de pacote candidatos (usa o 1o instalado)
$CloneApps = Cfg 'cloneApps' @(
  @{ name="WhatsApp";          pkgs=@("com.whatsapp") },
  @{ name="WhatsApp Business"; pkgs=@("com.whatsapp.w4b") },
  @{ name="Telegram";          pkgs=@("org.telegram.messenger.web","org.telegram.messenger") }
)
# devolve o id do usuario do Perfil de Trabalho do Island, ou -1 se nao existir
function Get-WorkProfileId {
  $dp = (& $Adb shell dumpsys device_policy) -join "`n"
  $m = [regex]::Match($dp,'Profile Owner \(User (\d+)\)[\s\S]{0,300}?com\.oasisfeng\.island')
  if($m.Success){ return [int]$m.Groups[1].Value }
  $u = (& $Adb shell pm list users) -join "`n"
  $mm = [regex]::Match($u,'UserInfo\{(\d+):\s*Island')
  if($mm.Success){ return [int]$mm.Groups[1].Value }
  return -1
}
function Get-Foreground { return ((& $Adb shell dumpsys activity activities | Select-String "topResumedActivity" | Select-Object -First 1) -join ' ') }
# dirige o assistente do Island + provisionamento do sistema ate o perfil EXISTIR e FINALIZAR.
# IMPORTANTE: nao pare assim que o perfil aparece - e' preciso seguir clicando ("Proximo"/
# "Avancar") ate o Island chegar na MainActivity, senao o perfil fica PELA METADE (gera o
# erro "Nao e' possivel adicionar um perfil de trabalho" e some dos launchers).
function Setup-Island {
  $wp = Get-WorkProfileId
  if($wp -ge 0){ Write-Host "  Perfil de trabalho ja existe (user $wp)." -ForegroundColor Green; return $wp }
  Write-Host "  Abrindo Island e criando o perfil de trabalho..." -ForegroundColor Cyan
  Write-Host "  (Vou avancar os avisos na tela automaticamente. NAO mexa no celular.)" -ForegroundColor DarkGray
  # garante setup limpo
  & $Adb shell pm clear com.oasisfeng.island 2>$null | Out-Null
  & $Adb shell am start -n com.oasisfeng.island/.MainActivity 2>$null | Out-Null
  Start-Sleep -Seconds 4
  # botoes que AVANCAM o assistente (Island welcome -> dialogo do sistema -> provisionamento
  # -> finalizacao). Ordem = prioridade. Cobre PT e EN e variacoes do ColorOS.
  $advance = @(
    'Aceitar e continuar','Aceitar e Continuar','Aceito','Concordo','Concordar','Continuar','Avançar','Próximo','Próxima',
    'Concluir','Concluído','Finalizar','Instalar','Definir','Ativar','Permitir','Começar','Iniciar','Aceitar','OK','Entendi',
    'Accept & continue','Accept and continue','Accept','Agree','Continue','Next','Done','Finish','Install','Allow','Start','Set up','Got it'
  )
  $navIds = @('suw_navbar_next','sud_navbar_next','suw_navbar_more','button_next','next_button','btn_next')
  $lastLabel = ''
  for($i=0; $i -lt 90; $i++){
    $fg = Get-Foreground
    # finalizou de verdade quando o Island chega na tela principal
    if($fg -match "oasisfeng.island/.MainActivity"){
      $wp = Get-WorkProfileId
      if($wp -ge 0){ Write-Host "  Perfil de trabalho criado e FINALIZADO (user $wp)." -ForegroundColor Green; return $wp }
    }
    $xml = Get-UI
    $clicked = $false
    # 1) tenta os botoes por TEXTO (na ordem de prioridade)
    foreach($t in $advance){
      if(Tap-By $xml "text" $t){
        if($t -ne $lastLabel){ Write-Host ("    -> avancei: `"{0}`"" -f $t) -ForegroundColor DarkGray; $lastLabel = $t }
        $clicked = $true; Start-Sleep -Seconds 3; break
      }
    }
    if($clicked){ continue }
    # 2) senao, botoes de "proximo" por resource-id (telas do assistente do sistema)
    foreach($id in $navIds){
      if(Tap-By $xml "resource-id" ("com.oasisfeng.island:id/" + $id)){ $clicked = $true; Start-Sleep -Seconds 3; break }
    }
    if($clicked){ continue }
    if(($i % 5) -eq 4){ Write-Host "    (aguardando a proxima tela / provisionamento...)" -ForegroundColor DarkGray }
    Start-Sleep -Seconds 3   # provavelmente provisionando: so espera
  }
  Write-Host "  Nao consegui confirmar sozinho - finalize o Island na tela do celular (toque em Continuar/Avancar)." -ForegroundColor Yellow
  return (Get-WorkProfileId)
}
# clona (install-existing) os apps no perfil de trabalho
function Clone-Apps([int]$wp){
  foreach($app in $CloneApps){
    $src = $null
    foreach($cand in $app.pkgs){ if(Is-Installed $cand){ $src = $cand; break } }
    if(-not $src){ Write-Host ("  {0,-20} [pulado: nao instalado no perfil pessoal]" -f $app.name) -ForegroundColor DarkGray; continue }
    if(((& $Adb shell pm list packages --user $wp $src) 2>$null) -match [regex]::Escape($src)){
      Write-Host ("  {0,-20} [ja clonado]" -f $app.name) -ForegroundColor Green; continue
    }
    $r = (& $Adb shell pm install-existing --user $wp $src 2>&1)
    $ok = ($r -match "installed|Success")
    if(-not $ok -and ($r -match "permission to access user")){ $r = "Android bloqueou o adb de clonar no perfil (faca pelo app Island)" }
    Write-Host ("  {0,-20} {1}" -f $app.name, $(if($ok){"[clonado]"}else{"[FALHOU] $r"})) -ForegroundColor $(if($ok){"Green"}else{"Red"})
  }
}
if(-not $SkipIsland){
  Write-Host "`n== Island: perfil de trabalho + clones ==" -ForegroundColor Cyan
  if($DryRun){
    Write-Host "  [DRY-RUN] criaria o perfil de trabalho e clonaria:" -ForegroundColor Yellow
    foreach($app in $CloneApps){ Write-Host ("    - {0}" -f $app.name) -ForegroundColor Yellow }
  } elseif(-not (Is-Installed "com.oasisfeng.island")){
    Write-Host "  Island nao esta instalado (coloque o APK em .\apks). Pulando." -ForegroundColor Yellow
  } else {
    $wp = Setup-Island
    if($wp -ge 0){ Clone-Apps $wp } else { Write-Host "  Sem perfil de trabalho - clones nao feitos." -ForegroundColor Yellow }
    & $Adb shell input keyevent KEYCODE_HOME 2>$null | Out-Null
  }
}

# ================= 8. TEMA ESCURO =================
if(-not $SkipTheme){
  Write-Host "`n== Tema escuro ==" -ForegroundColor Cyan
  if($DryRun){ Write-Host "  [seria ativado] modo noturno" -ForegroundColor Yellow }
  else {
    & $Adb shell cmd uimode night yes 2>&1 | Out-Null
    $st = (& $Adb shell cmd uimode night) -join ' '
    Write-Host ("  Modo noturno: {0}" -f $(if($st -match 'yes'){'[ativado]'}else{$st})) -ForegroundColor Green
  }
}

# ================= 8a. VELOCIDADE (desativar animacoes) =================
# Zera as 3 escalas de animacao (Opcoes do desenvolvedor). A interface responde na
# hora, dando sensacao de aparelho mais rapido. Reversivel (voltar p/ 1).
if(-not $SkipSpeed){
  Write-Host "`n== Deixar o celular mais rapido ==" -ForegroundColor Cyan
  if($DryRun){ Write-Host "  [seria feito] desativar as animacoes do sistema" -ForegroundColor Yellow }
  else {
    & $Adb shell settings put global window_animation_scale 0 2>$null | Out-Null
    & $Adb shell settings put global transition_animation_scale 0 2>$null | Out-Null
    & $Adb shell settings put global animator_duration_scale 0 2>$null | Out-Null
    Write-Host "  Animacoes: [desativadas]" -ForegroundColor Green
  }
}

# ================= 8b. BRILHO E APAGAMENTO DA TELA =================
# Configuravel pelo painel (ou pelos parametros -Brightness/-AdaptiveBrightness/-ScreenTimeout).
# Padroes (quando nao informado): adaptativo OFF, brilho maximo (255), apagar em 5 min.
# (escala padrao do Android p/ screen_brightness = 0..255; timeout em milissegundos)
if(-not $SkipDisplay){
  $adapt = if($AdaptiveBrightness -ge 0){ $AdaptiveBrightness } else { 0 }
  $bri   = if($Brightness -ge 0){ [math]::Max(0,[math]::Min(255,$Brightness)) } else { 255 }
  $to    = if($ScreenTimeout -gt 0){ $ScreenTimeout } else { 300000 }
  $toMin = [math]::Round($to/60000,1)
  Write-Host "`n== Brilho e tela ==" -ForegroundColor Cyan
  if($DryRun){
    Write-Host ("  [seria feito] adaptativo={0}, brilho={1}/255, apagar em {2} min" -f $(if($adapt -eq 1){'ON'}else{'OFF'}), $bri, $toMin) -ForegroundColor Yellow
  } else {
    & $Adb shell settings put system screen_brightness_mode $adapt 2>$null | Out-Null   # 0=manual, 1=adaptativo
    if($adapt -ne 1){ & $Adb shell settings put system screen_brightness $bri 2>$null | Out-Null }  # so faz sentido no modo manual
    & $Adb shell settings put system screen_off_timeout $to 2>$null | Out-Null
    $rMode = ((& $Adb shell settings get system screen_brightness_mode) -join '').Trim()
    $rBri  = ((& $Adb shell settings get system screen_brightness) -join '').Trim()
    $rTo   = ((& $Adb shell settings get system screen_off_timeout) -join '').Trim()
    $rToMin = if($rTo -match '^\d+$'){ [string]([math]::Round([int]$rTo/60000,1)) } else { '?' }
    Write-Host ("  Brilho adaptativo: {0}" -f $(if($rMode -eq '1'){'[ativado]'}else{'[desativado]'})) -ForegroundColor Green
    if($adapt -ne 1){ Write-Host ("  Brilho: {0}/255" -f $rBri) -ForegroundColor Green }
    Write-Host ("  Apagar tela: {0} min" -f $rToMin) -ForegroundColor Green
  }
}

# ================= 9. CLONADOR NATIVO (realme ou Xiaomi) =================
# realme: "Clonador de aplicativo" (Android MANAGE_CLONED_APPS_SETTINGS) - limite de 2 apps,
#   so com o launcher do realme.
# Xiaomi/MIUI: "Apps duplos" (XSpace, com.miui.securitycore) - sem limite de 2.
# Nos dois a tela e uma lista de apps com um Switch por linha, entao a automacao e a mesma.
# nome = texto EXATO na tela; pkg = pacote (pra checar se ja foi clonado no perfil clone)
$NativeCloneApps = Cfg 'nativeCloneApps' @(
  @{ name="WhatsApp";          pkg="com.whatsapp" },
  @{ name="WhatsApp Business"; pkg="com.whatsapp.w4b" }
)
function Get-CloneUserId {
  $u = (& $Adb shell pm list users) -join "`n"
  # realme = "cloneUser"; Xiaomi = "XSpace" (user 999); Samsung = "DUAL_APP" (user 95)
  $m = [regex]::Match($u,'UserInfo\{(\d+):\s*(cloneUser|XSpace|DUAL_APP)')
  if($m.Success){ return [int]$m.Groups[1].Value }
  return -1
}
# acha, na linha cujo TEXTO = $name, o Switch e devolve "@{y=..;checked=..}" (ou $null)
function Find-CloneToggle([string]$xml,[string]$name){
  # espaco pode vir como U+00A0 (nao-quebravel) na UI: casa qualquer whitespace entre palavras
  $rx = ($name -split '\s+' | ForEach-Object { [regex]::Escape($_) }) -join '\s+'
  $mt = [regex]::Match($xml,'text="'+$rx+'"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')
  if(-not $mt.Success){ return $null }
  $rowY = [int](([int]$mt.Groups[2].Value+[int]$mt.Groups[4].Value)/2)
  # procura um Switch com centro Y proximo a essa linha
  foreach($ms in [regex]::Matches($xml,'class="android.widget.Switch"[^>]*?checked="(true|false)"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')){
    $sy=[int](([int]$ms.Groups[3].Value+[int]$ms.Groups[5].Value)/2)
    if([math]::Abs($sy-$rowY) -le 60){
      $sx=[int](([int]$ms.Groups[2].Value+[int]$ms.Groups[4].Value)/2)
      return @{ x=$sx; y=$sy; checked=($ms.Groups[1].Value -eq 'true') }
    }
  }
  return @{ x=-1; y=$rowY; checked=$false }   # achou a linha mas nao o switch: tenta lado direito
}
function Is-NativeCloned([string]$pkg){
  $cu = Get-CloneUserId
  if($cu -lt 0){ return $false }
  return (((& $Adb shell pm list packages --user $cu $pkg) 2>$null) -match [regex]::Escape($pkg))
}
if(-not $SkipNativeClone){
  Write-Host "`n== Clonador nativo ==" -ForegroundColor Cyan
  if(-not $HasClone){ Write-Host "  [pulado] sem clonador nativo suportado (realme / Xiaomi / Samsung)." -ForegroundColor DarkGray }
  elseif($DryRun){
    $via = if($IsXiaomi){ "Apps duplos (Xiaomi)" } elseif($IsSamsung){ "Mensageiro Duplo (Samsung)" } else { "Clonador (realme)" }
    foreach($a in $NativeCloneApps){ Write-Host ("  [seria clonado via {0}] {1}" -f $via, $a.name) -ForegroundColor Yellow }
  } else {
    # quais ainda faltam clonar?
    $todo = @($NativeCloneApps | Where-Object { -not (Is-NativeCloned $_.pkg) })
    foreach($a in ($NativeCloneApps | Where-Object { Is-NativeCloned $_.pkg })){
      Write-Host ("  {0,-20} [ja clonado]" -f $a.name) -ForegroundColor Green
    }
    if($todo.Count -gt 0){
      $w = ((& $Adb shell wm size) -join ' ') -replace '.*?(\d+)x(\d+).*','$1'; if(-not ($w -as [int])){ $w = 720 }
      if($IsXiaomi){
        # Xiaomi: abre "Apps duplos" (XSpace). Sem limite de 2 apps.
        & $Adb shell am start -n com.miui.securitycore/com.miui.xspace.ui.activity.XSpaceSettingActivity 2>$null | Out-Null
      } elseif($IsSamsung){
        # Samsung: "Mensageiro Duplo" (Dual Messenger). Suporta menos apps (ex.: WhatsApp,
        # Facebook) - WA Business/Telegram podem nao aparecer -> caem em "[nao listado]".
        & $Adb shell am start -n com.samsung.android.da.daagent/.activity.DualAppActivity 2>$null | Out-Null
      } else {
        # realme: precisa do launcher do realme (nao funciona com terceiros)
        $homeAct = (& $Adb shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME) -join ' '
        if($homeAct -notmatch "com.android.launcher3"){
          Write-Host "  AVISO: launcher atual nao e' o do realme - o clonador pode nao mostrar os icones." -ForegroundColor Yellow
        }
        & $Adb shell am start -a android.settings.MANAGE_CLONED_APPS_SETTINGS 2>$null | Out-Null
      }
      Start-Sleep -Seconds 5
      foreach($a in $todo){
        # a lista "Recomendados" carrega de forma assincrona: tenta ate 6x (re-dump)
        $tg = $null
        for($try=0; $try -lt 6; $try++){
          $tg = Find-CloneToggle (Get-UI) $a.name
          if($null -ne $tg){ break }
          Start-Sleep -Seconds 2
        }
        if($null -eq $tg){ Write-Host ("  {0,-20} [nao listado no clonador]" -f $a.name) -ForegroundColor DarkGray; continue }
        if($tg.checked){ Write-Host ("  {0,-20} [ja clonado]" -f $a.name) -ForegroundColor Green; continue }
        $tapX = if($tg.x -ge 0){ $tg.x } else { [int]$w - 70 }
        & $Adb shell input tap $tapX $tg.y | Out-Null
        # "Ativando..." pode demorar; confirma por ate ~16s em vez de uma espera fixa
        $ok = $false
        for($k=0; $k -lt 8; $k++){ Start-Sleep -Seconds 2; if(Is-NativeCloned $a.pkg){ $ok = $true; break } }
        Write-Host ("  {0,-20} {1}" -f $a.name, $(if($ok){"[clonado]"}else{"[verifique na tela]"})) -ForegroundColor $(if($ok){"Green"}else{"Yellow"})
      }
      & $Adb shell input keyevent KEYCODE_HOME 2>$null | Out-Null
    }
    $cu = Get-CloneUserId
    if($cu -ge 0){ Write-Host ("  (clones nativos no perfil clone = user $cu)") -ForegroundColor DarkGray }
  }
}

# ================= 10. DESLIGAR "MOSTRAR APLICATIVOS SUGERIDOS" =================
# Config do launcher do realme: Configuracoes da tela inicial -> Gaveta -> Mostrar
# aplicativos sugeridos. Detecta o estado pelo texto "Ativado"/"Desativado" na linha.
function Get-RowStatus([string]$xml,[string]$title){
  # acha o titulo e devolve @{rowY=..; state="on"/"off"/"unknown"}
  $rx = ($title -split '\s+' | ForEach-Object { [regex]::Escape($_) }) -join '\s+'
  $mt=[regex]::Match($xml,'text="'+$rx+'"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')
  if(-not $mt.Success){ return $null }
  $titleY=[int](([int]$mt.Groups[2].Value+[int]$mt.Groups[4].Value)/2)
  # 1) Switch com estado, na mesma linha
  foreach($ms in [regex]::Matches($xml,'class="android.widget.Switch"[^>]*?checked="(true|false)"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')){
    $sy=[int](([int]$ms.Groups[3].Value+[int]$ms.Groups[5].Value)/2)
    if([math]::Abs($sy-$titleY) -le 60){ return @{ rowY=$sy; x=[int](([int]$ms.Groups[2].Value+[int]$ms.Groups[4].Value)/2); state=$(if($ms.Groups[1].Value -eq 'true'){'on'}else{'off'}) } }
  }
  # 2) texto de status logo abaixo do titulo
  foreach($t in @(@{w='Desativado';s='off'},@{w='Ativado';s='on'})){
    foreach($ms in [regex]::Matches($xml,'text="'+$t.w+'"[^>]*?bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"')){
      $sy=[int](([int]$ms.Groups[2].Value+[int]$ms.Groups[4].Value)/2)
      if($sy -ge $titleY -and ($sy-$titleY) -le 70){ return @{ rowY=$titleY; x=-1; state=$t.s } }
    }
  }
  return @{ rowY=$titleY; x=-1; state='unknown' }
}
if(-not $SkipSuggestions){
  Write-Host "`n== Desligar 'Mostrar aplicativos sugeridos' ==" -ForegroundColor Cyan
  if(-not $IsRealme){ Write-Host "  [pulado] config da gaveta e' exclusiva do launcher realme." -ForegroundColor DarkGray }
  elseif($DryRun){ Write-Host "  [seria desligado] Mostrar aplicativos sugeridos" -ForegroundColor Yellow }
  else {
    $w = ((& $Adb shell wm size) -join ' ') -replace '.*?(\d+)x(\d+).*','$1'; if(-not ($w -as [int])){ $w = 720 }
    & $Adb shell am start -n com.android.launcher3/.settings.SettingsActivity 2>$null | Out-Null
    Start-Sleep -Seconds 2
    $xml = Get-UI
    if(Tap-By $xml "text" "Configurações da gaveta de aplicativos"){ Start-Sleep -Seconds 2 }
    $xml = Get-UI
    $rs = Get-RowStatus $xml "Mostrar aplicativos sugeridos"
    if($null -eq $rs){ Write-Host "  Opcao nao encontrada (launcher diferente?)." -ForegroundColor DarkGray }
    elseif($rs.state -eq 'off'){ Write-Host "  Ja esta desligado." -ForegroundColor Green }
    else {
      $tapX = if($rs.x -ge 0){ $rs.x } else { [int]$w - 70 }
      & $Adb shell input tap $tapX $rs.rowY | Out-Null
      Start-Sleep -Seconds 1
      $rs2 = Get-RowStatus (Get-UI) "Mostrar aplicativos sugeridos"
      Write-Host ("  {0}" -f $(if($rs2 -and $rs2.state -eq 'off'){"[desligado]"}else{"[toquei - verifique na tela]"})) -ForegroundColor Green
    }
    & $Adb shell input keyevent KEYCODE_HOME 2>$null | Out-Null
  }
}

# ================= 11. PERMISSOES DOS APPS =================
# Concede as permissoes comuns (que geram popup) a TODOS os apps de terceiros, em
# TODOS os perfis (principal + clones do Island + clone nativo). Assim os apps nao
# ficam pedindo depois. So vale p/ as permissoes que cada app declara.
$PermsList = @('CAMERA','RECORD_AUDIO','READ_CONTACTS','WRITE_CONTACTS','ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','ACCESS_MEDIA_LOCATION','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE','READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO','READ_PHONE_STATE','READ_PHONE_NUMBERS','CALL_PHONE','READ_CALL_LOG','SEND_SMS','READ_SMS','RECEIVE_SMS','POST_NOTIFICATIONS','NEARBY_WIFI_DEVICES','BLUETOOTH_CONNECT','BLUETOOTH_SCAN','GET_ACCOUNTS','ACTIVITY_RECOGNITION','BODY_SENSORS')
if(-not $SkipPerms){
  Write-Host "`n== Permissoes dos apps ==" -ForegroundColor Cyan
  if($DryRun){
    Write-Host "  [seria feito] conceder permissoes comuns a todos os apps (principal + clones)" -ForegroundColor Yellow
  } else {
    # perfis: 0 = principal; >0 = clones (Island, clone nativo)
    $usersOut = (& $Adb shell pm list users) -join "`n"
    $users = @([regex]::Matches($usersOut,'UserInfo\{(\d+)') | ForEach-Object { $_.Groups[1].Value })
    if(-not $users){ $users = @('0') }
    # probe: alguns realme/ColorOS bloqueiam pm grant via ADB sem "Depuracao USB (Config. de seguranca)"
    $first = (((& $Adb shell pm list packages -3) | Select-Object -First 1) -replace 'package:','').Trim()
    $probe = if($first){ (& $Adb shell pm grant $first android.permission.CAMERA) 2>&1 | Out-String } else { '' }
    if($probe -match 'RUNTIME_PERMISSIONS'){
      Write-Host "  [!] O aparelho bloqueou a alteracao de permissoes via ADB." -ForegroundColor Yellow
      Write-Host "      realme/ColorOS: ligue 'Depuracao USB (Config. de seguranca)' nas Opcoes do desenvolvedor e rode de novo." -ForegroundColor Yellow
    } else {
      foreach($u in $users){
        $pkgs = @((& $Adb shell pm list packages -3 --user $u) | ForEach-Object { ($_ -replace 'package:','').Trim() } | Where-Object { $_ })
        foreach($pk in $pkgs){
          # concede todas as permissoes deste app numa unica chamada adb (o device ignora as nao declaradas)
          $loop = ($PermsList | ForEach-Object { "pm grant --user $u $pk android.permission.$_ >/dev/null 2>&1" }) -join '; '
          & $Adb shell $loop 2>$null | Out-Null
          $tag = if($u -eq '0'){ '' } else { " (clone user $u)" }
          Write-Host ("  [ok]{0} {1}" -f $tag, $pk) -ForegroundColor Green
        }
      }
    }
  }
}

# ================= 12. MANTER APPS ATIVOS (bateria / segundo plano) =================
# Tira todos os apps de terceiros da economia de bateria (Doze/whitelist) e libera
# rodar em segundo plano. Evita que o ColorOS/realme "mate" o WhatsApp e os clones,
# fazendo eles pararem de receber mensagens quando a tela apaga.
if(-not $SkipBattery){
  Write-Host "`n== Manter apps ativos (bateria) ==" -ForegroundColor Cyan
  if($DryRun){ Write-Host "  [seria feito] ignorar economia de bateria + rodar em 2o plano p/ todos os apps" -ForegroundColor Yellow }
  else {
    # perfis (0 = principal; >0 = clones): o appops de 2o plano e por-perfil
    $usersOut = (& $Adb shell pm list users) -join "`n"
    $users = @([regex]::Matches($usersOut,'UserInfo\{(\d+)') | ForEach-Object { $_.Groups[1].Value })
    if(-not $users){ $users = @('0') }
    $pkgs = @((& $Adb shell pm list packages -3) | ForEach-Object { ($_ -replace 'package:','').Trim() } | Where-Object { $_ })
    foreach($pk in $pkgs){
      & $Adb shell dumpsys deviceidle whitelist +$pk 2>$null | Out-Null   # ignora otimizacao de bateria (Doze) - global, cobre todos os perfis
      foreach($u in $users){
        & $Adb shell cmd appops set --user $u $pk RUN_IN_BACKGROUND allow 2>$null | Out-Null      # libera 2o plano (por perfil; clones inclusos)
        & $Adb shell cmd appops set --user $u $pk RUN_ANY_IN_BACKGROUND allow 2>$null | Out-Null
      }
      Write-Host ("  [ok] {0}" -f $pk) -ForegroundColor Green
    }
    Write-Host "  (Dica: no realme, confira tambem 'Iniciar automaticamente' de cada app se ainda parar.)" -ForegroundColor DarkGray
  }
}

# ================= RELATORIO FINAL =================
if(-not $DryRun){
  Write-Host "`n== Resumo final ==" -ForegroundColor Cyan
  function Yn([bool]$b){ if($b){"sim"}else{"nao"} }
  $night = ((& $Adb shell cmd uimode night) -join ' ') -match 'yes'
  Write-Host ("  Tema escuro:            {0}" -f (Yn $night))
  foreach($m in @(@{n='WhatsApp';p='com.whatsapp'},@{n='WhatsApp Business';p='com.whatsapp.w4b'},@{n='Telegram';p='org.telegram.messenger.web'})){
    Write-Host ("  {0,-22} {1}" -f ($m.n+':'), (Yn (Is-Installed $m.p)))
  }
  $wp = Get-WorkProfileId
  if($wp -ge 0){
    $isl = ((& $Adb shell pm list packages --user $wp 2>$null) | Select-String 'whatsapp|telegram' | ForEach-Object { ($_ -replace 'package:','').Trim() }) -join ', '
    Write-Host ("  Perfil Island (user {0}): {1}" -f $wp, $(if($isl){$isl}else{'(vazio)'}))
  } else { Write-Host "  Perfil Island:          nao criado" }
  $cu = Get-CloneUserId
  if($cu -ge 0){
    $nat = ((& $Adb shell pm list packages --user $cu 2>$null) | Select-String 'whatsapp' | ForEach-Object { ($_ -replace 'package:','').Trim() }) -join ', '
    Write-Host ("  Clones nativos (user {0}): {1}" -f $cu, $(if($nat){$nat}else{'(vazio)'}))
  } else { Write-Host "  Clones nativos:         nenhum" }
  # reverte o stayon
  & $Adb shell svc power stayon false 2>$null | Out-Null
}

Write-Host "`n>>> Concluido! Reinicie o celular para finalizar a limpeza. <<<`n" -ForegroundColor Magenta
