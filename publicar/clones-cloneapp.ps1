<#
================================================================
  clones-cloneapp.ps1  -  Cria/remove clones no app "Clone App"
                          (com.pengyou.cloneapp) via automacao de UI
================================================================
  Usado pelo painel (secao "Clone App"). Acha os botoes por ID
  (uiautomator), nao por pixel - funciona em qualquer resolucao.

  USO:
    -Action create -AppLabel "WhatsApp" -Names "2,3,4,5,6"
    -Action delete -Names "TESTE,3"

  Obs.: cada clone criado fica VAZIO; o login (numero + SMS) e manual.
================================================================
#>
param(
  [ValidateSet('create','delete','list','rename')][string]$Action='create',
  [string]$AppLabel='WhatsApp',
  [string]$Names='',
  [string]$Old='',
  [string]$New='',
  [switch]$DryRun
)
$ErrorActionPreference='Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PKG = 'com.pengyou.cloneapp'

function Get-Adb {
  $c=@("$ScriptDir\platform-tools\adb.exe","$env:USERPROFILE\platform-tools\adb.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if(-not $c){ throw "ADB nao encontrado." } ; return $c
}
$Adb = Get-Adb
if(-not (& $Adb devices | Select-String "\tdevice$")){ Write-Host "[!] Nenhum celular autorizado conectado." -ForegroundColor Red; exit 1 }
if(-not ((& $Adb shell pm list packages $PKG) | Where-Object { $_.Trim() -eq "package:$PKG" })){
  Write-Host "[!] Clone App (com.pengyou.cloneapp) nao esta instalado neste celular." -ForegroundColor Red; exit 1
}
# a automacao de UI exige a tela LIGADA: acorda e mantem acesa
& $Adb shell input keyevent KEYCODE_WAKEUP 2>$null | Out-Null
& $Adb shell svc power stayon true 2>$null | Out-Null
& $Adb shell input keyevent KEYCODE_HOME 2>$null | Out-Null
Start-Sleep -Milliseconds 600

function Get-UI {
  & $Adb shell uiautomator dump /sdcard/ui.xml 2>$null | Out-Null
  & $Adb pull /sdcard/ui.xml "$env:TEMP\cloneui.xml" 2>$null | Out-Null
  try { return [System.IO.File]::ReadAllText("$env:TEMP\cloneui.xml",[System.Text.Encoding]::UTF8) } catch { return '' }
}
function Has-Id([string]$xml,[string]$id){ return ($xml -match ('resource-id="com\.pengyou\.cloneapp:id/'+[regex]::Escape($id)+'"')) }
function Wait-Id([string]$id,[int]$tries=12){ for($i=0;$i -lt $tries;$i++){ if(Has-Id (Get-UI) $id){ return $true }; Start-Sleep -Milliseconds 500 }; return $false }
function Tap-XY([int]$x,[int]$y){ & $Adb shell input tap $x $y | Out-Null }
function LongPress([int]$x,[int]$y){ & $Adb shell input swipe $x $y $x $y 700 | Out-Null }
function Center4($x1,$y1,$x2,$y2){ return @([int](([int]$x1+[int]$x2)/2), [int](([int]$y1+[int]$y2)/2)) }

function Tap-Id([string]$xml,[string]$id){
  $m=[regex]::Match($xml,'<node[^>]*resource-id="com\.pengyou\.cloneapp:id/'+[regex]::Escape($id)+'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if(-not $m.Success){ return $false }
  $c=Center4 $m.Groups[1].Value $m.Groups[2].Value $m.Groups[3].Value $m.Groups[4].Value
  Tap-XY $c[0] $c[1]; return $true
}
# na Choose APP, acha o "+" (iv_btn) na MESMA LINHA do app $label
function Tap-AppAdd([string]$xml,[string]$label){
  $mn=[regex]::Match($xml,'<node[^>]*text="'+[regex]::Escape($label)+'"[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if(-not $mn.Success){ $mn=[regex]::Match($xml,'<node[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"[^>]*text="'+[regex]::Escape($label)+'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') }
  if(-not $mn.Success){ return $false }
  $rowY=([int]$mn.Groups[2].Value+[int]$mn.Groups[4].Value)/2
  $best=$null; $bestDy=999999
  foreach($m in [regex]::Matches($xml,'<node[^>]*resource-id="com\.pengyou\.cloneapp:id/iv_btn"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')){
    $yc=([int]$m.Groups[2].Value+[int]$m.Groups[4].Value)/2
    $dy=[math]::Abs($yc-$rowY); if($dy -lt $bestDy){ $bestDy=$dy; $best=$m }
  }
  if(-not $best -or $bestDy -gt 130){ return $false }
  $c=Center4 $best.Groups[1].Value $best.Groups[2].Value $best.Groups[3].Value $best.Groups[4].Value
  Tap-XY $c[0] $c[1]; return $true
}
# acha a posicao do clone (icone) na grade principal pelo nome (label tv_name)
function Find-CloneXY([string]$xml,[string]$name){
  $m=[regex]::Match($xml,'<node[^>]*text="'+[regex]::Escape($name)+'"[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if(-not $m.Success){ $m=[regex]::Match($xml,'<node[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"[^>]*text="'+[regex]::Escape($name)+'"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') }
  if(-not $m.Success){ return $null }
  $cx=[int](([int]$m.Groups[1].Value+[int]$m.Groups[3].Value)/2)
  $h=([int]$m.Groups[4].Value-[int]$m.Groups[2].Value)
  $cy=[int]$m.Groups[2].Value - [int]($h*1.6)   # sobe do label para o icone
  if($cy -lt 1){ $cy = [int](([int]$m.Groups[2].Value+[int]$m.Groups[4].Value)/2) }
  return @($cx,$cy)
}
function Goto-Main(){
  for($i=0;$i -lt 4;$i++){ if(Has-Id (Get-UI) 'iv_btn_create'){ return $true }; & $Adb shell input keyevent 4 | Out-Null; Start-Sleep -Milliseconds 800 }
  return (Has-Id (Get-UI) 'iv_btn_create')
}

# ---------- abre o Clone App (force-stop antes, para comecar na tela principal) ----------
& $Adb shell am force-stop $PKG 2>$null | Out-Null
Start-Sleep -Milliseconds 600
& $Adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
Start-Sleep -Seconds 3
if(-not (Wait-Id 'iv_btn_create' 14)){ Write-Host "[!] A tela principal do Clone App nao apareceu." -ForegroundColor Red; exit 1 }

$list = @($Names -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if(($Action -eq 'create' -or $Action -eq 'delete') -and -not $list){ Write-Host "[!] Nenhum nome informado." -ForegroundColor Yellow; exit 1 }

if($Action -eq 'create'){
  Write-Host ("== Clone App: criar {0} clone(s) de '{1}'{2} ==" -f $list.Count,$AppLabel,$(if($DryRun){' (SIMULACAO)'}else{''})) -ForegroundColor Cyan
  $ok=0
  foreach($nm in $list){
    if(-not (Goto-Main)){ Write-Host "  [falhou] nao voltei para a tela principal" -ForegroundColor Yellow; break }
    if(-not (Tap-Id (Get-UI) 'iv_btn_create')){ Write-Host ("  {0,-8} [falhou] botao + (FAB)" -f $nm) -ForegroundColor Yellow; continue }
    if(-not (Wait-Id 'iv_btn' 10)){ Write-Host ("  {0,-8} [falhou] lista de apps nao abriu" -f $nm) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; continue }
    Start-Sleep -Milliseconds 400
    if(-not (Tap-AppAdd (Get-UI) $AppLabel)){ Write-Host ("  {0,-8} [falhou] app '{1}' nao encontrado na lista" -f $nm,$AppLabel) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; continue }
    if(-not (Wait-Id 'et_name' 10)){ Write-Host ("  {0,-8} [falhou] tela de nome nao abriu" -f $nm) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; continue }
    Start-Sleep -Milliseconds 400
    # limpa o nome e digita (sem tocar no campo, para o teclado NAO cobrir o botao Clone)
    Tap-Id (Get-UI) 'iv_btn_clear_name' | Out-Null; Start-Sleep -Milliseconds 400
    & $Adb shell input text ($nm -replace ' ','%s') | Out-Null; Start-Sleep -Milliseconds 400
    if($DryRun){ Write-Host ("  {0,-8} [simulado] (nao cliquei Clone)" -f $nm) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; Start-Sleep -Milliseconds 600; continue }
    if(-not (Tap-Id (Get-UI) 'tv_btn_ok')){ Write-Host ("  {0,-8} [falhou] botao Clone" -f $nm) -ForegroundColor Yellow; continue }
    Start-Sleep -Seconds 4
    $ok++; Write-Host ("  {0,-8} [criado]" -f $nm) -ForegroundColor Green
  }
  Write-Host (">>> Concluido: {0}/{1} clone(s) de '{2}'. <<<" -f $ok,$list.Count,$AppLabel)
}
elseif($Action -eq 'delete'){
  Write-Host ("== Clone App: remover {0} clone(s){1} ==" -f $list.Count,$(if($DryRun){' (SIMULACAO)'}else{''})) -ForegroundColor Cyan
  $ok=0
  foreach($nm in $list){
    if(-not (Goto-Main)){ Write-Host "  [falhou] nao voltei para a tela principal" -ForegroundColor Yellow; break }
    $xy = Find-CloneXY (Get-UI) $nm
    if(-not $xy){ Write-Host ("  {0,-8} [nao encontrado]" -f $nm) -ForegroundColor DarkGray; continue }
    if($DryRun){ Write-Host ("  {0,-8} [seria removido]" -f $nm) -ForegroundColor Yellow; continue }
    LongPress $xy[0] $xy[1]; Start-Sleep -Milliseconds 1500
    if(-not (Tap-Id (Get-UI) 'll_btn_delete')){ Write-Host ("  {0,-8} [falhou] menu Delete" -f $nm) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; continue }
    Start-Sleep -Milliseconds 1000
    if(-not (Tap-Id (Get-UI) 'tv_btn_del')){ Write-Host ("  {0,-8} [falhou] confirmar Delete" -f $nm) -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; continue }
    Start-Sleep -Seconds 2
    $ok++; Write-Host ("  {0,-8} [removido]" -f $nm) -ForegroundColor Green
  }
  Write-Host (">>> Concluido: {0}/{1} clone(s) removido(s). <<<" -f $ok,$list.Count)
}
elseif($Action -eq 'list'){
  if(-not (Goto-Main)){ Write-Host "[!] A tela principal nao apareceu." -ForegroundColor Red; exit 1 }
  Start-Sleep -Milliseconds 400
  $xml=Get-UI
  $found=@()
  foreach($m in [regex]::Matches($xml,'<node[^>]*text="([^"]*)"[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"')){ $found += $m.Groups[1].Value }
  foreach($m in [regex]::Matches($xml,'<node[^>]*resource-id="com\.pengyou\.cloneapp:id/tv_name"[^>]*text="([^"]*)"')){ $found += $m.Groups[1].Value }
  $clones=@($found | Where-Object { $_ -and $_ -ne 'Tools' } | Select-Object -Unique)
  foreach($n in $clones){ Write-Host ("CLONE:{0}" -f $n) }
  Write-Host (">>> {0} clone(s) na grade. <<<" -f $clones.Count)
}
elseif($Action -eq 'rename'){
  if(-not $Old -or -not $New){ Write-Host "[!] Informe -Old e -New." -ForegroundColor Yellow; exit 1 }
  Write-Host ("== Clone App: renomear '{0}' -> '{1}'{2} ==" -f $Old,$New,$(if($DryRun){' (SIMULACAO)'}else{''})) -ForegroundColor Cyan
  if(-not (Goto-Main)){ Write-Host "  [falhou] tela principal" -ForegroundColor Yellow; exit 1 }
  $xy=Find-CloneXY (Get-UI) $Old
  if(-not $xy){ Write-Host ("  [nao encontrado] {0}" -f $Old) -ForegroundColor DarkGray; exit 1 }
  if($DryRun){ Write-Host "  [seria renomeado]" -ForegroundColor Yellow; exit 0 }
  LongPress $xy[0] $xy[1]; Start-Sleep -Milliseconds 1500
  if(-not (Tap-Id (Get-UI) 'll_btn_edit')){ Write-Host "  [falhou] menu Editar" -ForegroundColor Yellow; & $Adb shell input keyevent 4 | Out-Null; exit 1 }
  if(-not (Wait-Id 'et_name' 10)){ Write-Host "  [falhou] tela de nome" -ForegroundColor Yellow; exit 1 }
  Start-Sleep -Milliseconds 400
  Tap-Id (Get-UI) 'iv_btn_clear_name' | Out-Null; Start-Sleep -Milliseconds 400
  & $Adb shell input text ($New -replace ' ','%s') | Out-Null; Start-Sleep -Milliseconds 400
  if(-not (Tap-Id (Get-UI) 'tv_btn_ok')){ Write-Host "  [falhou] botao OK" -ForegroundColor Yellow; exit 1 }
  Start-Sleep -Seconds 2
  Write-Host ("  {0} -> {1}   [renomeado]" -f $Old,$New) -ForegroundColor Green
}
