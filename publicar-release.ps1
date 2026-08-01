# ============================================================================
#  publicar-release.ps1 - publica a Release no GitHub e sobe os APKs
# ----------------------------------------------------------------------------
#  Faz, nesta ordem (a ordem importa):
#    1. Release da versao, com o instalador, o ZIP portatil e o SHA256SUMS.
#    2. Sobe para a tag "apks", com --clobber, TODOS os .apk da pasta local
#       que batem com o catalogo - nao so os que mudaram. A API do GitHub
#       expoe tamanho e data dos assets, mas nao o sha256, entao decidir "esse
#       ja esta igual" exigiria baixar cada um antes - o mesmo trafego que se
#       quer economizar. Reenviar e idempotente; o custo e banda, nao risco.
#    3. CONFERE, baixando de volta, se o que esta publicado bate com o
#       publicar\apks.json.
#    4. So entao commita e envia o apks.json.
#
#  POR QUE O apks.json E O ULTIMO: o painel baixa a url do catalogo e confere
#  o sha256. Se o catalogo subir antes dos arquivos, ele anuncia um hash que a
#  Release ainda nao serve, e todo mundo que clicar em "Atualizar APKs pela
#  nuvem" leva um "verificacao (hash) falhou. Abortado por seguranca." sem
#  entender por que.
#
#  Precisa do gh autenticado (gh auth login). O git push usa o Credential
#  Manager e funciona sem isso, mas criar Release e' API - outra credencial.
# ============================================================================

[CmdletBinding()]
param(
  [string] $Versao,
  [string] $TagApks = 'apks',
  [switch] $PularConferencia
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
#  Com ErrorActionPreference='Stop', qualquer linha que um programa externo
#  escreva em stderr vira erro FATAL - mesmo sendo um aviso esperado. O
#  "gh release view" escreve "release not found" quando a Release ainda nao
#  existe, que e o caso normal da PRIMEIRA publicacao: o script morria ali,
#  antes de criar coisa nenhuma.
#
#  Nao da para resolver com $PSNativeCommandUseErrorActionPreference: essa
#  variavel so existe no PowerShell 7, e este script tambem roda no Windows
#  PowerShell 5.1, onde o problema e o mesmo.
#
#  Entao toda chamada externa passa por aqui: roda com 'Continue', devolve a
#  saida como texto e deixa o $LASTEXITCODE intacto - que e o que o script
#  usa para decidir. Redirecionar stderr nao serviria: o valor esta em ler o
#  texto ("release not found" e resposta, nao falha).
# ---------------------------------------------------------------------------
function Rodar {
  param(
    [Parameter(Mandatory = $true)][string] $Programa,
    [Parameter(ValueFromRemainingArguments = $true)][string[]] $Argumentos
  )
  $antigo = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try   { & $Programa @Argumentos 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $antigo }
}

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$saida = Join-Path $base 'instalador\_saida'

function Passo($t) { Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "   [!] $t" -ForegroundColor Yellow }

if (-not $Versao) { $Versao = (Get-Content -LiteralPath (Join-Path $base 'versao-local.txt') -Raw).Trim() }
$tag = "v$Versao"

# ------------------------------------------------------------ conferencias --
Rodar gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh nao autenticado. Rode: gh auth login' }
Ok 'gh autenticado'

$assets = @(
  (Join-Path $saida "ConfigCelular-$Versao-instalador.exe"),
  (Join-Path $saida "ConfigCelular-$Versao-portatil.zip"),
  (Join-Path $saida 'SHA256SUMS.txt')
)
$notas = Join-Path $saida 'NOTAS-RELEASE.md'
foreach ($f in ($assets + $notas)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "falta o arquivo: $f  (rode instalador\gerar-instalador.ps1)" }
}

# O pacote completo (com os APKs) e' opcional: so existe quando a pasta apks\
# tinha conteudo na hora de gerar. Vai na frente da lista porque e' o download
# principal - e' ele que serve para preparar celular numa maquina nova.
$completo = Join-Path $saida "ConfigCelular-$Versao-completo.exe"
if (Test-Path -LiteralPath $completo) {
  $assets = @($completo) + $assets
  Ok "pacote completo incluido ($([math]::Round((Get-Item $completo).Length/1MB)) MB)"
} else {
  Aviso 'sem pacote completo nesta geracao (a pasta apks\ estava vazia)'
}
Ok "$($assets.Count) arquivos prontos"

# --------------------------------------------------- 0. links do README ------
# Os botoes de download do README apontam para a tag da versao. Presos numa
# versao antiga, o botao principal entrega o arquivo errado - erro que so
# aparece quando alguem reclama. Reescreve para a versao que esta sendo
# publicada, e o commit do fim leva a mudanca junto.
Passo 'Links de download do README'
$readme = Join-Path $base 'README.md'
$antes = [System.IO.File]::ReadAllText($readme)
$depois = $antes
$depois = [regex]::Replace($depois, 'releases/download/v[0-9][0-9.]*/', "releases/download/$tag/")
$depois = [regex]::Replace($depois, 'ConfigCelular-[0-9][0-9.]*-(completo\.exe|instalador\.exe|portatil\.zip)', "ConfigCelular-$Versao-`$1")
# Troca SO o numero, preservando a palavra como ela esta no arquivo.
# A versao anterior trazia um "a" com til dentro do padrao e da substituicao:
# o Windows PowerShell le .ps1 sem BOM como ANSI, o caractere chegava
# corrompido, o padrao nunca casava com "versao" e o rotulo ficava preso na
# versao antiga enquanto os links (so ASCII) eram atualizados - o README
# anunciava 6.1 com links da 6.2. Sem acento no script, o problema nao existe.
$depois = [regex]::Replace($depois, '(\*\*vers\w*o\s+)[0-9][0-9.]*(\*\*)', "`${1}$Versao`${2}")
if ($depois -ne $antes) {
  [System.IO.File]::WriteAllText($readme, $depois, (New-Object System.Text.UTF8Encoding($false)))
  Ok "atualizados para $tag"
} else {
  Ok "ja apontavam para $tag"
}

# --------------------------------------------------------------- 1. Release --
Passo "Release $tag"
Rodar gh release view $tag | Out-Null
if ($LASTEXITCODE -eq 0) {
  Aviso "a Release $tag ja existe - substituindo os arquivos"
  Rodar gh release upload $tag @assets --clobber | ForEach-Object { "   $_" }
  if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar os arquivos' }
} else {
  Rodar gh release create $tag --title "Config Celular $Versao" --notes-file $notas @assets | ForEach-Object { "   $_" }
  if ($LASTEXITCODE -ne 0) { throw 'falha ao criar a Release' }
}
Ok "https://github.com/satoshigynn/config-celular/releases/tag/$tag"

# ------------------------------------------------------------------ 2. APKs --
Passo "APKs na tag $TagApks"
$cat = Get-Content -LiteralPath (Join-Path $base 'publicar\apks.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Rodar gh release view $TagApks | Out-Null
if ($LASTEXITCODE -ne 0) { throw "a tag '$TagApks' nao tem Release. Crie-a antes de subir APK." }

$subir = @()
foreach ($e in $cat.apks) {
  $local = Join-Path $base "apks\$($e.arquivo)"
  if (-not (Test-Path -LiteralPath $local)) {
    Aviso "$($e.arquivo): so publicado (nao esta na pasta local) - mantido como esta"
    continue
  }
  $h = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $e.sha256) { throw "$($e.arquivo): o catalogo nao bate com o arquivo local. Rode publicar-apks.ps1 de novo." }
  $subir += $local
}

if ($subir.Count) {
  Write-Host "   enviando $($subir.Count) arquivo(s) - pode demorar:"
  $subir | ForEach-Object { Write-Host "     $(Split-Path $_ -Leaf)  ($([math]::Round((Get-Item $_).Length/1MB,1)) MB)" }
  Rodar gh release upload $TagApks @subir --clobber | ForEach-Object { "   $_" }
  if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar os APKs' }
  Ok 'APKs enviados'
}

# ------------------------------------------------------------ 3. conferencia -
if (-not $PularConferencia) {
  Passo 'Conferindo o que ficou publicado (baixando de volta)'
  $node = Join-Path $base 'node.exe'
  $script = @'
const https=require("https"),c=require("crypto"),fs=require("fs");
const cat=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const get=(u,n=0)=>new Promise((res,rej)=>{ if(n>5) return rej(new Error("redirect loop"));
  https.get(u,{headers:{"User-Agent":"ConfigCelular/publicador"}},r=>{
    if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){r.resume();return get(r.headers.location,n+1).then(res,rej);}
    if(r.statusCode!==200){r.resume();return rej(new Error("HTTP "+r.statusCode));}
    const h=c.createHash("sha256");r.on("data",d=>h.update(d));r.on("end",()=>res(h.digest("hex")));
  }).on("error",rej);});
(async()=>{ let mau=0;
  for(const e of cat.apks){
    try{ const h=await get(e.url);
      const ok=h===e.sha256; if(!ok)mau++;
      console.log("     "+(ok?"ok   ":"FALHA")+"  "+e.arquivo);
    }catch(err){ mau++; console.log("     FALHA  "+e.arquivo+"  ("+err.message+")"); }
  }
  process.exit(mau?1:0);
})();
'@
  $tmp = Join-Path $env:TEMP 'conferir-apks.js'
  [System.IO.File]::WriteAllText($tmp, $script, (New-Object System.Text.UTF8Encoding($false)))
  Rodar $node $tmp (Join-Path $base 'publicar\apks.json') | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw 'o que esta publicado nao bate com o catalogo - apks.json NAO foi commitado' }
  Ok 'tudo publicado bate com o catalogo'
}

# --------------------------------------------------------- 4. commit do json -
Passo 'Commit do catalogo'
Rodar git -C $base add publicar/apks.json README.md | Out-Null
Rodar git -C $base diff --cached --quiet | Out-Null
if ($LASTEXITCODE -eq 0) {
  Ok 'catalogo e README ja estavam iguais - nada a commitar'
} else {
  $vWa = ($cat.apks | Where-Object { $_.arquivo -eq 'WhatsApp.apk' }).versionName
  $vTg = ($cat.apks | Where-Object { $_.arquivo -eq 'Telegram.apk' }).versionName
  Rodar git -C $base commit -q -m "release $tag`: catalogo da nuvem (WhatsApp $vWa, Telegram $vTg) e links do README" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'falha ao commitar o catalogo' }
  Rodar git -C $base push origin main | ForEach-Object { "   $_" }
  if ($LASTEXITCODE -ne 0) { throw 'falha ao enviar o commit do catalogo' }
  Ok 'catalogo commitado e enviado'
}

Write-Host ''
Write-Host "Release $tag publicada." -ForegroundColor Green
