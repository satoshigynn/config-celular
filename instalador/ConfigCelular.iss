; ============================================================================
;  Config Celular - script do instalador (Inno Setup 6)
; ----------------------------------------------------------------------------
;  Nao compile este arquivo direto. Use:
;      powershell -ExecutionPolicy Bypass -File instalador\gerar-instalador.ps1
;  O script monta a pasta _stage com o que deve ser distribuido (o repositorio
;  nao guarda os binarios) e so entao chama o ISCC.
;
;  DUAS COISAS AQUI NAO PODEM MUDAR SEM PENSAR:
;
;  1. AppId. Ele identifica a instalacao existente. O valor abaixo foi lido do
;     registro da instalacao real (chave ..._is1) e tem a chave dupla no fim,
;     que o autor original deixou por engano. Reproduzir o engano e o certo:
;     mudar o AppId faz o Windows tratar a v6.0 como OUTRO programa, e o
;     usuario fica com duas copias e dois desinstaladores.
;
;  2. Os arquivos com "onlyifdoesntexist". Sao listas que o usuario edita
;     (config.json, apks-fontes.json, apps-catalog.json). Instalar por cima
;     apagaria o trabalho dele numa atualizacao. O painel-settings.json nem
;     entra: e criado pelo painel no primeiro uso.
; ============================================================================

#define Nome        "Config Celular"
; O gerar-instalador.ps1 passa /DVersao. O ifndef deixa compilar a mao tambem;
; sem ele, este #define venceria o da linha de comando e a versao ficaria presa.
#ifndef Versao
  #define Versao    "6.2"
#endif
#define Autor       "Satoshigyn"
#define Site        "https://github.com/satoshigynn/config-celular"
#define Executavel  "Abrir Painel.exe"

; MODO DE TESTE (/DTeste): mesmo instalador, com AppId descartavel e outro
; nome. Serve para instalar numa pasta temporaria, conferir que o pacote sobe
; e desinstalar - tudo isso sem encostar no registro da instalacao de verdade.
; Publicar so o build SEM /DTeste.
; ArqSaida e o nome COMPLETO do arquivo gerado, montado de uma vez. Antes era
; um sufixo colado no meio de "ConfigCelular-<versao><sufixo>-instalador", o
; que produzia "ConfigCelular-6.1-completo-instalador.exe" - nome que o
; gerador nao procurava, entao ele acusava que o ISCC nao tinha gerado nada.
#ifdef Teste
  #define IdApp    "{{CFG0CELULAR-TESTE-DESCARTAVEL}"
  #define Sufixo   " (TESTE)"
  #define ArqSaida "ConfigCelular-" + Versao + "-TESTE-instalador"
#else
  #define IdApp    "{{B2A7C3E1-4F6D-4A9B-9C21-CFG0CELULAR01}}"
  #define Sufixo   ""
  #ifdef Completo
    #define ArqSaida "ConfigCelular-" + Versao + "-completo"
  #else
    #define ArqSaida "ConfigCelular-" + Versao + "-instalador"
  #endif
#endif

; MODO COMPLETO (/DCompleto): leva junto a pasta apks\ - os aplicativos que o
; setup instala no celular. Sem ele o pacote tem 41 MB e a pasta apks\ chega
; VAZIA: bom para quem so atualiza o programa, inutil para quem acabou de
; instalar numa maquina nova e vai preparar aparelho.
; Os dois instalam o MESMO programa, com o mesmo AppId - a diferenca e so o
; conteudo da pasta apks\.

[Setup]
AppId={#IdApp}
AppName={#Nome}{#Sufixo}
AppVersion={#Versao}
AppVerName={#Nome} {#Versao}{#Sufixo}
AppPublisher={#Autor}
AppPublisherURL={#Site}
AppSupportURL={#Site}/issues
AppUpdatesURL={#Site}/releases
; Vem do gerar-instalador.ps1, que normaliza "6.1" para "6.1.0.0" (o Windows
; exige 4 numeros). Estava fixo em 6.0.0.0: as propriedades do arquivo
; mentiriam a versao em todo lançamento seguinte.
#ifndef VersaoArquivo
  #define VersaoArquivo Versao + ".0.0"
#endif
VersionInfoVersion={#VersaoArquivo}
VersionInfoDescription=Gerenciador de aparelhos Android com espelhamento de tela

; Instala na pasta do usuario: nao pede administrador.
DefaultDirName={userpf}\{#Nome}{#Sufixo}
DefaultGroupName={#Nome}{#Sufixo}
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=no
AllowNoIcons=yes

LicenseFile=_stage\LICENSE
InfoAfterFile=_stage\LEIA-ME.txt
OutputDir=_saida
OutputBaseFilename={#ArqSaida}
SetupIconFile=icone.ico
UninstallDisplayIcon={app}\{#Executavel}
UninstallDisplayName={#Nome} {#Versao}

Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

; O painel roda o node.exe de dentro da pasta; com ele aberto os arquivos
; ficam travados. O PrepareToInstall abaixo encerra so os processos que
; estao rodando DE DENTRO da pasta do programa.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar um atalho na Area de Trabalho"; GroupDescription: "Atalhos:"

[Files]
; ---- programa (sempre atualizado) ------------------------------------------
Source: "_stage\{#Executavel}";      DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\node.exe";           DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\*.ps1";              DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\LEIA-ME.txt";        DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\MANUAL-PAINEL.txt";  DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\LICENSE";            DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\README.md";          DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\update.json";        DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\versao-local.txt";   DestDir: "{app}"; Flags: ignoreversion
Source: "_stage\painel\*";           DestDir: "{app}\painel"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "_stage\scrcpy\*";           DestDir: "{app}\scrcpy"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "_stage\platform-tools\*";   DestDir: "{app}\platform-tools"; Flags: ignoreversion recursesubdirs createallsubdirs

; ---- listas do usuario (NAO sobrescrever numa atualizacao) ------------------
Source: "_stage\config.json";        DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "_stage\apks-fontes.json";   DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "_stage\apps-catalog.json";  DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

#ifdef Completo
; ---- os aplicativos (so no pacote completo) --------------------------------
; nocompression de proposito: APK e ZIP, ja vem comprimido. Tentar comprimir de
; novo levaria muitos minutos para economizar quase nada - e ainda faria o
; instalador demorar para extrair na maquina do usuario.
Source: "..\apks\*"; DestDir: "{app}\apks"; Flags: ignoreversion recursesubdirs createallsubdirs nocompression
#endif

[Dirs]
; Conteudo do usuario: fica onde esta, inclusive ao desinstalar.
Name: "{app}\apks";     Flags: uninsneveruninstall
Name: "{app}\capturas"; Flags: uninsneveruninstall
Name: "{app}\logs";     Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#Nome}";                  Filename: "{app}\{#Executavel}"; WorkingDir: "{app}"
Name: "{group}\Manual do painel";         Filename: "{app}\MANUAL-PAINEL.txt"
Name: "{group}\Desinstalar {#Nome}";      Filename: "{uninstallexe}"
Name: "{userdesktop}\{#Nome}";            Filename: "{app}\{#Executavel}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#Executavel}"; Description: "Abrir o painel agora"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
// Encerra o painel se ele estiver rodando DE DENTRO da pasta de instalacao.
// Nao usa "taskkill /IM node.exe": isso derrubaria qualquer outro Node da
// maquina, inclusive coisas que nao tem nada a ver com este programa.
procedure PararPainel();
var
  Codigo: Integer;
  Cmd: String;
begin
  // Sem -Filter de proposito: a sintaxe WQL exigiria aspas duplas dentro de
  // aspas duplas, que nao sobrevivem a viagem Pascal -> linha de comando ->
  // PowerShell. Filtrar no Where-Object usa so aspas simples e e' confiavel.
  Cmd :=
    '-NoProfile -NonInteractive -WindowStyle Hidden -Command ' +
    '"$alvo = ''' + ExpandConstant('{app}') + '''; ' +
    'Get-CimInstance Win32_Process ' +
    '| Where-Object { ($_.Name -eq ''node.exe'' -or $_.Name -eq ''Abrir Painel.exe'') ' +
    '-and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($alvo) } ' +
    '| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"';
  Exec('powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, Codigo);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  PararPainel();
  Sleep(700);
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    PararPainel();
end;
