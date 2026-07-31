# ============================================================================
#  publicar-apks.ps1 - gera o publicar\apks.json (catalogo da nuvem)
# ----------------------------------------------------------------------------
#  O painel usa esse catalogo em "Atualizar APKs pela nuvem"
#  (/api/update-apks-cloud): baixa cada url, confere o sha256 e so entao grava
#  na pasta apks\. Os arquivos ficam como assets da tag "apks" no GitHub.
#
#  DUAS REGRAS QUE O CANAL IMPOE:
#    * so ARQUIVO UNICO .apk - o nome tem que casar com ^[A-Za-z0-9_.-]+\.apk$.
#      Bundles (.apks/.xapk, que aqui viram pastas com base.apk + splits) NAO
#      passam por aqui: seria preciso um install-multiple do outro lado.
#    * o sha256 e' verificado depois do download. Catalogo com hash errado nao
#      instala nada - so falha.
#
#  ENTRADAS ORFAS: se o catalogo atual lista um .apk que nao esta mais na
#  pasta local, a entrada e MANTIDA como estava. O asset continua no GitHub e
#  funcionando; apagar a linha tiraria o app do alcance de quem usa a nuvem
#  sem ganho nenhum. E o caso do WhatsAppBusiness.apk, que localmente virou
#  bundle mas segue publicado como arquivo unico.
#
#  Nenhum APK entra no catalogo sem passar pelo cert-apk.ps1.
# ============================================================================

[CmdletBinding()]
param(
  [string] $Tag = 'apks',
  [switch] $Simular
)

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$pastaApks = Join-Path $base 'apks'
$cert = Join-Path $base 'painel\server\cert-apk.ps1'
$destino = Join-Path $base 'publicar\apks.json'
$urlBase = "https://github.com/satoshigynn/config-celular/releases/download/$Tag"

function Nota($t) { Write-Host $t }
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t){ Write-Host "  [!] $t" -ForegroundColor Yellow }

# aapt2 do Android SDK, quando existir - so para registrar a versao no catalogo.
function Achar-Aapt {
  $bases = @(
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\build-tools'),
    'C:\Android\Sdk\build-tools',
    (Join-Path $env:ProgramFiles 'Android\Sdk\build-tools')
  )
  foreach ($b in $bases) {
    if (-not (Test-Path -LiteralPath $b)) { continue }
    foreach ($d in (Get-ChildItem -LiteralPath $b -Directory -EA SilentlyContinue | Sort-Object Name -Descending)) {
      foreach ($n in @('aapt2.exe', 'aapt.exe')) {
        $p = Join-Path $d.FullName $n
        if (Test-Path -LiteralPath $p) { return $p }
      }
    }
  }
  return $null
}
$aapt = Achar-Aapt
if ($aapt) { Ok "aapt: $aapt" } else { Aviso 'aapt nao encontrado - versionName ficara vazio nos APKs novos' }

# ------------------------------------------------------- catalogo anterior --
$anterior = @{}
if (Test-Path -LiteralPath $destino) {
  try {
    $j = Get-Content -LiteralPath $destino -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($e in $j.apks) { $anterior[$e.arquivo] = $e }
  } catch { Aviso "catalogo atual ilegivel, comecando do zero: $($_.Exception.Message)" }
}

# ------------------------------------------------------------ APKs locais ---
$itens = @()
$vistos = @{}
$reprovados = 0

foreach ($a in (Get-ChildItem -LiteralPath $pastaApks -File -Filter *.apk -EA SilentlyContinue | Sort-Object Name)) {
  if ($a.Name -notmatch '^[A-Za-z0-9_.-]+\.apk$') {
    Aviso "fora do catalogo (o painel rejeitaria o nome): $($a.Name)"
    continue
  }

  # Portao de seguranca: assinatura invalida nao entra, ponto.
  & powershell -NoProfile -ExecutionPolicy Bypass -File $cert -Apk $a.FullName > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Aviso "REPROVADO na verificacao de assinatura (codigo $LASTEXITCODE): $($a.Name)"
    $reprovados++
    continue
  }

  $vn = ''
  if ($aapt) {
    $dump = & $aapt dump badging $a.FullName 2>$null | Select-Object -First 1
    $m = [regex]::Match(($dump | Out-String), "versionName='([^']*)'")
    if ($m.Success) { $vn = $m.Groups[1].Value }
  }
  if (-not $vn -and $anterior.ContainsKey($a.Name)) { $vn = $anterior[$a.Name].versionName }

  $sha = (Get-FileHash -LiteralPath $a.FullName -Algorithm SHA256).Hash.ToLower()
  $mudou = (-not $anterior.ContainsKey($a.Name)) -or ($anterior[$a.Name].sha256 -ne $sha)

  $itens += [ordered]@{
    arquivo     = $a.Name
    versionName = $vn
    sha256      = $sha
    url         = "$urlBase/$($a.Name)"
  }
  $vistos[$a.Name] = $true
  $marca = if ($mudou) { 'PRECISA SUBIR' } else { 'ja publicado, igual' }
  '  {0,-24} {1,-16} {2}' -f $a.Name, $vn, $marca | Write-Host
}

if ($reprovados) { throw "$reprovados APK(s) reprovados na assinatura - catalogo nao gerado" }

# ------------------------------------------------------ entradas preservadas -
foreach ($nome in $anterior.Keys) {
  if ($vistos.ContainsKey($nome)) { continue }
  $itens += [ordered]@{
    arquivo     = $anterior[$nome].arquivo
    versionName = $anterior[$nome].versionName
    sha256      = $anterior[$nome].sha256
    url         = $anterior[$nome].url
  }
  Aviso "preservada (nao esta na pasta local, mas segue publicada): $nome"
}

$itens = $itens | Sort-Object { $_.arquivo }

if ($Simular) {
  Nota ''
  Nota "SIMULACAO - nada gravado. $($itens.Count) entrada(s)."
  return
}

$man = [ordered]@{ geradoEm = (Get-Date -Format 'yyyy-MM-dd'); apks = $itens }
$json = $man | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($destino, $json, (New-Object System.Text.UTF8Encoding($false)))
Nota ''
Ok "publicar\apks.json com $($itens.Count) entrada(s)"
Nota ''
Nota 'Suba para a tag "apks" os arquivos marcados PRECISA SUBIR, depois commit do apks.json.'
