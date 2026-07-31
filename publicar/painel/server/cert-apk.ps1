<#
================================================================
  cert-apk.ps1 - identifica quem ASSINOU um arquivo .apk
================================================================
  Imprime:
     SHA256=<64 hex>        impressao digital do certificado
     VERIFICADO=sim|nao|parcial
     METODO=apksigner|parser
     ESQUEMA=<esquemas presentes>

  Para que serve: antes de substituir um APK da pasta por um recem
  baixado, comparar as duas impressoes. Iguais = mesmo publicador.

  DOIS MODOS, e a diferenca importa:

   1. apksigner (do Android SDK), quando existir na maquina.
      VERIFICACAO DE VERDADE: reconfere os digests de todo o
      conteudo do pacote. Se um byte foi trocado, ele acusa.
      -> VERIFICADO=sim

   2. parser proprio (sem Java, so .NET), como reserva.
      So LE o certificado; NAO reconfere digest nenhum.
      -> VERIFICADO=parcial

  POR QUE A ORDEM v2/v3 ANTES DE v1 E OBRIGATORIA:
  um .apk e um ZIP. Qualquer um pode COPIAR o META-INF\*.RSA de um
  app legitimo para dentro de outro APK, sem re-assinar nada. Se o
  leitor olhasse o v1 primeiro, passaria a jurar que o pacote e do
  outro publicador. O Android resolve isso ignorando o v1 quando ha
  APK Signing Block (v2/v3/v3.1) - e este script faz igual. Alem
  disso, no caminho v1 exigimos MANIFEST.MF e o .SF de mesmo nome,
  para recusar um bloco de assinatura orfao enxertado.

  USO:
    powershell -ExecutionPolicy Bypass -File .\cert-apk.ps1 -Apk "C:\...\WhatsApp.apk"

  SAIDA (exit code):
    0 = certificado lido
    2 = nao ha assinatura utilizavel
    3 = arquivo ilegivel / nao e um APK
    4 = ASSINATURA INVALIDA (o conteudo nao bate com a assinatura)

  Sobre o codigo 4: quando o apksigner esta disponivel e diz que o
  pacote nao confere, o script PARA ali. Nao cai para o parser -
  senao bastaria enxertar META-INF de outro app para o arquivo se
  passar por ele (ataque testado, hoje barrado).
================================================================
#>
param(
  [Parameter(Mandatory = $true)][string]$Apk,
  [switch]$Detalhado
)

function Falhar([string]$msg, [int]$codigo) {
  [Console]::Error.WriteLine("ERRO: $msg")
  Write-Output "ERRO: $msg"
  exit $codigo
}

# ------------------------------------------------------------ validacoes ----
if (-not (Test-Path -LiteralPath $Apk)) { Falhar "arquivo nao encontrado: $Apk" 3 }
if ((Get-Item -LiteralPath $Apk).PSIsContainer) { Falhar "'$Apk' e uma pasta - aponte para um arquivo .apk" 3 }
try {
  $fsChk = [System.IO.File]::Open($Apk, 'Open', 'Read', 'Read')
  $b2 = New-Object byte[] 2
  [void]$fsChk.Read($b2, 0, 2)
  $fsChk.Dispose()
  if ($b2[0] -ne 0x50 -or $b2[1] -ne 0x4B) { Falhar 'o arquivo nao e um ZIP/APK' 3 }
} catch { Falhar "nao consegui abrir o arquivo: $($_.Exception.Message)" 3 }

Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

# =========================== MODO 1: apksigner (verificacao de verdade) ======
function Achar-Apksigner {
  $bases = @(
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\build-tools'),
    'C:\Android\Sdk\build-tools',
    (Join-Path $env:ProgramFiles 'Android\Sdk\build-tools')
  )
  foreach ($b in $bases) {
    if (-not (Test-Path $b)) { continue }
    $v = Get-ChildItem $b -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    foreach ($d in $v) {
      $p = Join-Path $d.FullName 'apksigner.bat'
      if (Test-Path $p) { return $p }
    }
  }
  $cmd = Get-Command apksigner -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Usar-Apksigner([string]$exe, [string]$arquivo) {
  # precisa de java no PATH
  if (-not (Get-Command java -ErrorAction SilentlyContinue)) { return $null }

  # O veredito vem do CODIGO DE SAIDA, nao do texto: 0 = confere, != 0 = nao.
  # Nao da para confiar em procurar "DOES NOT VERIFY" na saida - num pacote
  # adulterado o apksigner imprime uma linha de ERROR por arquivo afetado
  # (medi 1,2 MILHAO de caracteres num teste), e a formatacao do Out-String
  # quebra as linhas de um jeito que faz a ancora de regex falhar.
  # stderr vai para o lixo justamente para nao carregar esse volume.
  try {
    $saida = (& $exe verify --print-certs -v -- $arquivo 2>$null) -join "`n"
    $codigo = $LASTEXITCODE
  } catch { return $null }

  if ($null -eq $codigo) { return $null }

  # PONTO DE SEGURANCA: veredito negativo e TERMINAL. Nao pode cair para o
  # parser proprio, que so LE o certificado e aceitaria de bom grado um bloco
  # de assinatura copiado de outro app (ataque testado - hoje barrado aqui).
  if ($codigo -ne 0) {
    Falhar "assinatura INVALIDA - o conteudo do pacote nao bate com a assinatura (apksigner, codigo $codigo)" 4
  }
  if (-not $saida) { return $null }

  # Duas formas de rotulo, dependendo de haver rotacao de chave (v3.1):
  #   "Signer #1 certificate SHA-256 digest: ..."
  #   "Signer (minSdkVersion=33, maxSdkVersion=...) certificate SHA-256 digest: ..."
  $m = [regex]::Match($saida, 'Signer[^\r\n]*?certificate SHA-256 digest:\s*([0-9a-fA-F]{64})')
  if (-not $m.Success) { return $null }

  $verificado = $true   # so chegamos aqui com codigo de saida 0
  $esquemas = @()
  foreach ($e in @('v1', 'v2', 'v3.1', 'v3', 'v4')) {
    if ([regex]::IsMatch($saida, "Verified using $([regex]::Escape($e)) scheme[^:]*:\s*true")) { $esquemas += $e }
  }
  $sujeito = ([regex]::Match($saida, 'Signer[^\r\n]*?certificate DN:\s*(.+)')).Groups[1].Value.Trim()

  return [pscustomobject]@{
    Sha256    = $m.Groups[1].Value.ToUpper()
    Verificado = $(if ($verificado) { 'sim' } else { 'nao' })
    Esquemas  = $(if ($esquemas.Count) { $esquemas -join '+' } else { 'desconhecido' })
    Titular   = $sujeito
    Metodo    = 'apksigner'
  }
}

# ============================ MODO 2: parser proprio (reserva) ==============
# --- APK Signing Block (v2 / v3 / v3.1): a fonte confiavel -------------------
function Get-CertDoBloco([string]$caminho) {
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($caminho, 'Open', 'Read', 'Read')
    $br = New-Object System.IO.BinaryReader($fs)
    $tam = $fs.Length
    if ($tam -lt 100) { return $null }

    # 1. EOCD (50 4B 05 06) varrendo o fim
    $limite = [long][Math]::Min(66000, $tam)
    $fs.Seek($tam - $limite, 'Begin') | Out-Null
    $cauda = $br.ReadBytes([int]$limite)
    $eocd = -1
    for ($i = $cauda.Length - 22; $i -ge 0; $i--) {
      if ($cauda[$i] -eq 0x50 -and $cauda[$i+1] -eq 0x4B -and $cauda[$i+2] -eq 0x05 -and $cauda[$i+3] -eq 0x06) { $eocd = $i; break }
    }
    if ($eocd -lt 0) { return $null }
    $cdOffset = [long][BitConverter]::ToUInt32($cauda, $eocd + 16)
    if ($cdOffset -le 24 -or $cdOffset -ge $tam) { return $null }

    # 2. magica 16 bytes antes do diretorio central
    $fs.Seek($cdOffset - 16, 'Begin') | Out-Null
    if ([System.Text.Encoding]::ASCII.GetString($br.ReadBytes(16)) -ne 'APK Sig Block 42') { return $null }

    # 3. tamanho do bloco -> inicio
    $fs.Seek($cdOffset - 24, 'Begin') | Out-Null
    $tamBloco = [long]$br.ReadUInt64()
    if ($tamBloco -le 0 -or $tamBloco -gt $cdOffset) { return $null }
    $inicio = $cdOffset - $tamBloco - 8
    if ($inicio -lt 0) { return $null }

    # 4. pares (tamanho, id, valor). Preferencia: v3.1 > v3 > v2
    $fs.Seek($inicio + 8, 'Begin') | Out-Null
    $fim = $cdOffset - 24
    $achados = @{}
    while ($fs.Position -lt $fim) {
      if ($fs.Position + 12 -gt $fim) { break }
      $tamPar = [long]$br.ReadUInt64()
      if ($tamPar -lt 4 -or ($fs.Position + $tamPar) -gt $fim) { break }
      $id = [long][Convert]::ToUInt32($br.ReadUInt32())
      $valor = $br.ReadBytes([int]($tamPar - 4))
      if ($id -eq 0x7109871A -or $id -eq 0xF05368C0 -or $id -eq 0x1B93AD61) { $achados[$id] = $valor }
    }
    if ($achados.Count -eq 0) { return $null }

    $ordem = @(0x1B93AD61, 0xF05368C0, 0x7109871A)   # v3.1, v3, v2
    $nomes = @{ 0x1B93AD61 = 'v3.1'; 0xF05368C0 = 'v3'; 0x7109871A = 'v2' }
    $presentes = @()
    foreach ($k in $ordem) { if ($achados.ContainsKey($k)) { $presentes += $nomes[$k] } }

    foreach ($k in $ordem) {
      if (-not $achados.ContainsKey($k)) { continue }
      $v = $achados[$k]
      $q = 0
      # leitor com limite: qualquer tamanho absurdo aborta em vez de estourar
      $u32 = {
        param([byte[]]$buf, [ref]$pos)
        if ($pos.Value + 4 -gt $buf.Length) { throw 'fim inesperado' }
        $x = [long][Convert]::ToUInt32([BitConverter]::ToUInt32($buf, $pos.Value))
        $pos.Value += 4
        return $x
      }
      try {
        [void](& $u32 $v ([ref]$q))          # tamanho da lista de signatarios
        [void](& $u32 $v ([ref]$q))          # tamanho do 1o signatario
        [void](& $u32 $v ([ref]$q))          # tamanho do signed data
        $tamDigests = & $u32 $v ([ref]$q)
        if ($tamDigests -lt 0 -or $q + $tamDigests -gt $v.Length) { continue }
        $q += [int]$tamDigests
        [void](& $u32 $v ([ref]$q))          # tamanho da lista de certificados
        $tamCert = & $u32 $v ([ref]$q)       # tamanho do 1o certificado (o do Android)
        if ($tamCert -le 0 -or $q + $tamCert -gt $v.Length) { continue }
        $der = New-Object byte[] ([int]$tamCert)
        [Array]::Copy($v, $q, $der, 0, [int]$tamCert)
        $cert = [System.Security.Cryptography.X509Certificates.X509CertificateLoader]::LoadCertificate($der)
        return [pscustomobject]@{ Cert = $cert; Esquemas = ($presentes -join '+') }
      } catch { continue }
    }
    return $null
  } catch {
    return $null
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

# --- v1 (JAR): SO quando nao ha bloco, e com as guardas do Android -----------
function Get-CertV1([string]$caminho) {
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($caminho)
    $nomes = $zip.Entries | ForEach-Object { $_.FullName }

    # sem MANIFEST.MF nao existe assinatura v1 legitima
    if ($nomes -notcontains 'META-INF/MANIFEST.MF') { return $null }

    $ent = $zip.Entries | Where-Object { $_.FullName -match '^META-INF/([^/]+)\.(RSA|DSA|EC)$' } | Select-Object -First 1
    if (-not $ent) { return $null }

    # o bloco tem que ter o .SF de mesmo nome-base; sem ele e arquivo enxertado
    $base = [System.IO.Path]::GetFileNameWithoutExtension($ent.FullName)
    if ($nomes -notcontains "META-INF/$base.SF") { return $null }

    $ms = New-Object System.IO.MemoryStream
    $s = $ent.Open(); $s.CopyTo($ms); $s.Close()
    $bytes = $ms.ToArray(); $ms.Dispose()

    $cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
    $cms.Decode($bytes)
    if ($cms.Certificates.Count -lt 1) { return $null }
    return [pscustomobject]@{ Cert = $cms.Certificates[0]; Esquemas = 'v1' }
  } catch {
    return $null
  } finally {
    if ($zip) { $zip.Dispose() }
  }
}

# =================================== main ===================================
$exe = Achar-Apksigner
$r = $null
if ($exe) { $r = Usar-Apksigner $exe $Apk }

if (-not $r) {
  # ORDEM CRITICA: bloco primeiro. Ver o comentario no topo.
  $achado = Get-CertDoBloco $Apk
  if (-not $achado) { $achado = Get-CertV1 $Apk }
  if (-not $achado) { Falhar 'nao ha assinatura utilizavel neste arquivo' 2 }

  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($achado.Cert.RawData)
  $r = [pscustomobject]@{
    Sha256    = (($sha | ForEach-Object { $_.ToString('X2') }) -join '')
    Verificado = 'parcial'
    Esquemas  = $achado.Esquemas
    Titular   = $achado.Cert.Subject
    Metodo    = 'parser'
  }
}

Write-Output "SHA256=$($r.Sha256)"
Write-Output "VERIFICADO=$($r.Verificado)"
Write-Output "METODO=$($r.Metodo)"
if ($Detalhado) {
  Write-Output "ESQUEMA=$($r.Esquemas)"
  Write-Output "TITULAR=$($r.Titular)"
}
exit 0
