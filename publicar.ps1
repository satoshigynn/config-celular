# ============================================================================
#  publicar.ps1 - monta a pasta publicar\ que o atualizador online consome
# ----------------------------------------------------------------------------
#  COMO O ATUALIZADOR FUNCIONA (painel/server/routes/system.cjs):
#    1. le update.json -> baseUrl (o RAW do GitHub apontando para publicar/)
#    2. baixa baseUrl/versao.json  = { versao, notas, arquivos:[{caminho,sha256}] }
#    3. para cada item, compara o sha256 com o arquivo LOCAL de mesmo caminho
#    4. baixa so os diferentes de baseUrl/<caminho>, confere o hash de novo e grava
#    5. no fim grava versao-local.txt
#
#  CONSEQUENCIA PRATICA: publicar/<caminho> vira <pasta do programa>/<caminho>.
#  Se um arquivo entrar nessa lista, ele SOBRESCREVE o do usuario. Por isso
#  arquivos que o usuario edita (config.json, apps-catalog.json,
#  painel-settings.json, apks-fontes.json, update.json) NAO entram - eles vem
#  so no instalador, como padrao de fabrica.
#
#  LIMITE DO CANAL: caminhoSeguro() so aceita ps1|cjs|js|mjs|html|css|json|txt|
#  bat|md e caminho sem espaco/acento. Logo o logo.png e as fontes NAO viajam
#  pelo atualizador (o painel tem fallback para os dois). Quem quer o visual
#  completo pega o instalador.
# ============================================================================

[CmdletBinding()]
param(
  [string] $Versao,
  [string] $Notas,
  [switch] $Simular
)

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$saida = Join-Path $base 'publicar'

function Nota($t) { Write-Host $t }
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t){ Write-Host "  [!] $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- versao ----
if (-not $Versao) {
  $vl = Join-Path $base 'versao-local.txt'
  if (Test-Path -LiteralPath $vl) { $Versao = (Get-Content -LiteralPath $vl -Raw).Trim() }
}
if (-not $Versao) { throw "Informe -Versao (ou tenha um versao-local.txt valido)." }

if (-not $Notas) {
  $rn = Join-Path $base 'NOTAS-DA-VERSAO.md'
  if (Test-Path -LiteralPath $rn) {
    # O painel mostra "notas" num <p> simples, sem markdown - o changelog
    # inteiro viraria um paredao com os ** aparecendo. Entao pega so o PRIMEIRO
    # PARAGRAFO do bloco "## <versao>": o resumo de uma linha. O texto completo
    # continua no .md, para quem le no GitHub.
    # -Encoding UTF8 e obrigatorio: no Windows PowerShell 5.1 o Get-Content sem
    # isso le como ANSI e "verificacao" chega no JSON como "verificaAAo".
    $linhas = Get-Content -LiteralPath $rn -Encoding UTF8
    $dentro = $false; $buf = @()
    foreach ($l in $linhas) {
      if ($l -match '^##\s') {
        if ($dentro) { break }
        if ($l -match [regex]::Escape($Versao)) { $dentro = $true }
        continue
      }
      if (-not $dentro) { continue }
      if ($l.Trim() -eq '') { if ($buf.Count) { break } else { continue } }
      $buf += $l.Trim()
    }
    $Notas = (($buf -join ' ').Trim())
  }
}
if (-not $Notas) { $Notas = "Versao $Versao" }

# ------------------------------------------------------- lista de arquivos --
# Raiz: os scripts do setup e os dois documentos.
$itens = @()
$itens += Get-ChildItem -LiteralPath $base -File -Filter *.ps1 |
          Where-Object { $_.Name -ne 'publicar.ps1' }
$itens += Get-ChildItem -LiteralPath $base -File |
          Where-Object { $_.Name -in @('LEIA-ME.txt', 'MANUAL-PAINEL.txt') }

# painel\: todo o codigo (inclui cert-apk.ps1, que fica em painel\server\).
$itens += Get-ChildItem -LiteralPath (Join-Path $base 'painel') -Recurse -File |
          Where-Object { $_.Extension -match '^\.(ps1|cjs|js|mjs|html|css|json|txt|bat|md)$' }

# Nunca entram: sao dados do usuario, nao codigo.
$proibidos = @('config.json', 'apps-catalog.json', 'painel-settings.json',
               'apks-fontes.json', 'update.json', 'versao-local.txt')

$arquivos = @()
$total = 0
foreach ($f in ($itens | Sort-Object FullName -Unique)) {
  $rel = $f.FullName.Substring($base.Length + 1).Replace('\', '/')

  if ($proibidos -contains (Split-Path $rel -Leaf)) { Aviso "pulado (dado do usuario): $rel"; continue }
  if ($rel -notmatch '^[A-Za-z0-9_./-]+$') { Aviso "pulado (caminho com espaco/acento, o painel ignoraria): $rel"; continue }

  $sha = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
  $arquivos += [ordered]@{ caminho = $rel; sha256 = $sha }
  $total += $f.Length

  if (-not $Simular) {
    $dest = Join-Path $saida ($rel -replace '/', '\')
    $pai = Split-Path $dest -Parent
    if (-not (Test-Path -LiteralPath $pai)) { New-Item -ItemType Directory -Path $pai -Force | Out-Null }
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
  }
}

# ------------------------------------------------------------ faxina ---------
# Arquivo que saiu do projeto tem que sair de publicar\ tambem, senao fica
# servindo codigo morto para quem clonar o repositorio.
if (-not $Simular -and (Test-Path -LiteralPath $saida)) {
  $devem = $arquivos | ForEach-Object { $_.caminho }
  Get-ChildItem -LiteralPath $saida -Recurse -File | ForEach-Object {
    $r = $_.FullName.Substring($saida.Length + 1).Replace('\', '/')
    if ($r -ne 'versao.json' -and $r -ne 'apks.json' -and $devem -notcontains $r) {
      Remove-Item -LiteralPath $_.FullName -Force
      Aviso "removido de publicar\ (nao existe mais no projeto): $r"
    }
  }
  Get-ChildItem -LiteralPath $saida -Recurse -Directory |
    Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Recurse -File) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}

# ---------------------------------------------------------- manifesto -------
$man = [ordered]@{
  versao   = $Versao
  notas    = $Notas
  gerado   = (Get-Date -Format 'yyyy-MM-dd')
  arquivos = $arquivos
}

if ($Simular) {
  Nota ""
  Nota "SIMULACAO - nada foi gravado."
  Nota "  versao   : $Versao"
  Nota "  arquivos : $($arquivos.Count)  ($([math]::Round($total/1KB)) KB)"
  $arquivos | ForEach-Object { Nota "    $($_.caminho)" }
  return
}

if (-not (Test-Path -LiteralPath $saida)) { New-Item -ItemType Directory -Path $saida -Force | Out-Null }
$json = $man | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $saida 'versao.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

Nota ""
Ok "publicar\ pronto para a versao $Versao"
Nota "  arquivos no manifesto : $($arquivos.Count)"
Nota "  peso                  : $([math]::Round($total/1KB)) KB"
Nota "  manifesto             : publicar\versao.json"
Nota ""
Nota "Agora: git add -A && git commit && git push"
