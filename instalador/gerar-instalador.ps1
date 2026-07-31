# ============================================================================
#  gerar-instalador.ps1 - monta o pacote e compila o instalador
# ----------------------------------------------------------------------------
#  Produz, em instalador\_saida\:
#     ConfigCelular-<versao>-instalador.exe   instalador (Inno Setup)
#     ConfigCelular-<versao>-portatil.zip     mesma pasta, sem instalar nada
#     SHA256SUMS.txt                          hash dos dois, para conferencia
#
#  POR QUE EXISTE UMA PASTA _stage: o repositorio nao guarda binario. O
#  node.exe (88 MB), o scrcpy (40 MB) e o platform-tools (17 MB) vivem so na
#  instalacao. O _stage junta o codigo versionado com esses binarios e vira a
#  unica fonte do instalador - assim nada entra por acidente (APK, log,
#  captura, painel-settings.json) nem falta por esquecimento.
# ============================================================================

[CmdletBinding()]
param(
  [string] $Versao,
  [switch] $PularZip
)

$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$raiz = Split-Path -Parent $aqui
$stage = Join-Path $aqui '_stage'
$saida = Join-Path $aqui '_saida'

function Passo($t) { Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   [ok] $t" -ForegroundColor Green }
function Erro($t)  { throw $t }

if (-not $Versao) { $Versao = (Get-Content -LiteralPath (Join-Path $raiz 'versao-local.txt') -Raw).Trim() }
if (-not $Versao) { Erro 'nao consegui descobrir a versao (versao-local.txt vazio)' }
Passo "Versao $Versao"

# ------------------------------------------------------------- conferencias --
$iscc = @(
  'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  'C:\Program Files\Inno Setup 6\ISCC.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { Erro 'Inno Setup 6 nao encontrado. Instale de https://jrsoftware.org/isdl.php' }

# Sem estes, o pacote sai quebrado - melhor parar agora do que publicar assim.
$obrigatorios = @(
  'Abrir Painel.exe', 'node.exe',
  'scrcpy\scrcpy.exe', 'scrcpy\scrcpy-server',
  'platform-tools\adb.exe',
  'painel\server.cjs', 'painel\index.html',
  'painel\server\scrcpy\session.cjs',
  'painel\app\assets\logo.png'
)
$faltando = $obrigatorios | Where-Object { -not (Test-Path -LiteralPath (Join-Path $raiz $_)) }
if ($faltando) {
  Write-Host 'Faltam arquivos que o instalador precisa:' -ForegroundColor Red
  $faltando | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
  Erro 'pacote incompleto - rode a partir de uma instalacao completa do programa'
}
Ok 'todas as pecas presentes'

# ------------------------------------------------------------------- _stage --
Passo 'Montando _stage'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($d in @('painel', 'scrcpy', 'platform-tools')) {
  Copy-Item -LiteralPath (Join-Path $raiz $d) -Destination (Join-Path $stage $d) -Recurse -Force
}
$soltos = @(
  'Abrir Painel.exe', 'node.exe',
  'LEIA-ME.txt', 'MANUAL-PAINEL.txt', 'LICENSE', 'README.md',
  'setup-celular.ps1', 'gerenciar-app.ps1', 'extrair-apk.ps1',
  'atualizar-apks.ps1', 'restaurar.ps1', 'clones-cloneapp.ps1',
  'config.json', 'apks-fontes.json', 'update.json', 'versao-local.txt'
)
foreach ($f in $soltos) { Copy-Item -LiteralPath (Join-Path $raiz $f) -Destination (Join-Path $stage $f) -Force }

# O catalogo vai VAZIO: os apps que voce adicionou sao dado seu, nao do pacote.
'{"custom":[]}' | Set-Content -LiteralPath (Join-Path $stage 'apps-catalog.json') -Encoding UTF8 -NoNewline
# A versao do pacote manda no versao-local.txt.
$Versao | Set-Content -LiteralPath (Join-Path $stage 'versao-local.txt') -Encoding ASCII

# Rede de seguranca: se algo privado escorregou para o _stage, para tudo.
$proibidos = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $r = $_.FullName.Substring($stage.Length + 1)
  $_.Name -eq 'painel-settings.json' -or
  $r.StartsWith('logs\') -or $r.StartsWith('capturas\') -or $r.StartsWith('apks\') -or
  $_.Extension -eq '.apk' -or $_.Extension -eq '.apks'
}
if ($proibidos) {
  $proibidos | ForEach-Object { Write-Host "   PRIVADO: $($_.FullName.Substring($stage.Length+1))" -ForegroundColor Red }
  Erro 'arquivo privado no pacote - abortado'
}
$mb = [math]::Round((Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Ok "$mb MB, sem nada privado"

# -------------------------------------------------------------------- icone --
# O Inno so aceita .ico. Gera um multi-resolucao a partir do logo.png para o
# instalador, o atalho e a entrada em Programas e Recursos.
Passo 'Gerando icone.ico a partir do logo'
Add-Type -AssemblyName System.Drawing
$png = Join-Path $raiz 'painel\app\assets\logo.png'
$ico = Join-Path $aqui 'icone.ico'
$orig = [System.Drawing.Image]::FromFile($png)
$tamanhos = @(256, 128, 64, 48, 32, 16)
$imagens = @()
foreach ($t in $tamanhos) {
  $bmp = New-Object System.Drawing.Bitmap($t, $t)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($orig, 0, 0, $t, $t)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $imagens += , @{ tam = $t; dados = $ms.ToArray() }
  $bmp.Dispose(); $ms.Dispose()
}
$orig.Dispose()

$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$imagens.Count)
$offset = 6 + (16 * $imagens.Count)
foreach ($i in $imagens) {
  $d = if ($i.tam -ge 256) { 0 } else { $i.tam }
  $bw.Write([Byte]$d); $bw.Write([Byte]$d)
  $bw.Write([Byte]0);  $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$i.dados.Length); $bw.Write([UInt32]$offset)
  $offset += $i.dados.Length
}
foreach ($i in $imagens) { $bw.Write($i.dados) }
$bw.Close(); $fs.Close()
Ok "icone.ico ($($imagens.Count) resolucoes, $([math]::Round((Get-Item $ico).Length/1KB)) KB)"

# --------------------------------------------------------------- compilacao --
if (-not (Test-Path -LiteralPath $saida)) { New-Item -ItemType Directory -Path $saida -Force | Out-Null }

# O Windows quer 4 numeros nas propriedades do arquivo. "6.1" vira "6.1.0.0".
$partes = @($Versao -split '\.') + @('0', '0', '0', '0')
$verArquivo = ($partes[0..3]) -join '.'

# Dois pacotes do MESMO programa, com o mesmo AppId:
#   leve     - so o programa; a pasta apks\ chega vazia (41 MB)
#   completo - leva os aplicativos junto, para preparar celular numa maquina
#              nova sem depender de baixar nada (~1 GB)
$saidas = @{}
foreach ($modo in @('leve', 'completo')) {
  $defs = @("/DVersao=$Versao", "/DVersaoArquivo=$verArquivo")
  $nome = "ConfigCelular-$Versao-instalador.exe"
  if ($modo -eq 'completo') {
    $mbApks = [math]::Round((Get-ChildItem -LiteralPath (Join-Path $raiz 'apks') -Recurse -File -EA SilentlyContinue |
                             Measure-Object Length -Sum).Sum / 1MB, 0)
    if (-not $mbApks) { Aviso 'a pasta apks\ esta vazia - pulando o pacote completo'; continue }
    $defs += '/DCompleto'
    $nome = "ConfigCelular-$Versao-completo.exe"
    Passo "Compilando o pacote COMPLETO (+$mbApks MB de APKs, sem recomprimir)"
  } else {
    Passo 'Compilando o pacote leve (compressao maxima - demora)'
  }

  $log = & $iscc @defs (Join-Path $aqui 'ConfigCelular.iss') 2>&1
  if ($LASTEXITCODE -ne 0) {
    $log | Select-Object -Last 25 | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
    Erro "ISCC falhou no pacote $modo (codigo $LASTEXITCODE)"
  }
  $alvo = Join-Path $saida $nome
  if (-not (Test-Path -LiteralPath $alvo)) { Erro "o ISCC terminou mas $nome nao apareceu" }
  $saidas[$modo] = $alvo
  Ok "$nome  ($([math]::Round((Get-Item $alvo).Length/1MB,1)) MB)"
}
$exe = $saidas['leve']
$exeCompleto = $saidas['completo']

# -------------------------------------------------------------------- portatil
$zip = Join-Path $saida "ConfigCelular-$Versao-portatil.zip"
if (-not $PularZip) {
  Passo 'Gerando o ZIP portatil'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  Ok "$(Split-Path $zip -Leaf)  ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)"
}

# ----------------------------------------------------------------- conferencia
Passo 'Hashes'
$linhas = @()
foreach ($f in @($exeCompleto, $exe, $zip)) {
  if (-not $f -or -not (Test-Path -LiteralPath $f)) { continue }
  $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  $linhas += "$h  $(Split-Path $f -Leaf)"
  Write-Host "   $h  $(Split-Path $f -Leaf)"
}
$linhas -join "`n" | Set-Content -LiteralPath (Join-Path $saida 'SHA256SUMS.txt') -Encoding ASCII

Write-Host ''
Write-Host "Pronto. Arquivos em: $saida" -ForegroundColor Green
