# Config Celular

Gerenciador de aparelhos Android para Windows, com **espelhamento de tela
controlável** rodando dentro do navegador. Painel local em Node, sem nenhuma
dependência de npm.

Feito para preparar aparelhos em série — debloat, instalação de apps, permissões,
bateria, tema — mas serve para o uso diário: espelhar, capturar, transferir
arquivos e mandar comandos ADB.

Funciona bem em realme/ColorOS (recursos completos) e em outras marcas —
Samsung, Xiaomi, Motorola, Pixel (as etapas exclusivas do realme são puladas
sozinhas).

---

## Baixar

**[⬇ Baixar a versão mais recente](https://github.com/satoshigynn/config-celular/releases/latest)**

| Arquivo | Para quem |
|---|---|
| `ConfigCelular-6.0-instalador.exe` | Uso normal. Instala na sua pasta de usuário, sem pedir administrador, cria os atalhos e atualiza uma instalação anterior sem apagar suas listas. |
| `ConfigCelular-6.0-portatil.zip` | Sem instalar nada. Descompacte onde quiser e rode o `Abrir Painel.exe` — dá para levar num pendrive. |
| `SHA256SUMS.txt` | Conferir se o download veio íntegro. |

Já vem com ADB, scrcpy e Node embutidos: não precisa instalar mais nada.

Para conferir o download:

```bash
Get-FileHash ConfigCelular-6.0-instalador.exe -Algorithm SHA256
```

---

## O espelhamento

Não é o `scrcpy.exe` aberto numa janela à parte. O servidor Node **fala o
protocolo binário do scrcpy** direto:

```
adb push scrcpy-server.jar /data/local/tmp
adb forward tcp:0 localabstract:scrcpy_<scid>
app_process / com.genymobile.scrcpy.Server <versao> video=true control=true ...
        │
        ├── socket de vídeo   → H.264 Annex-B → WebCodecs VideoDecoder → <canvas>
        └── socket de controle ← toque, teclado, rolagem, clipboard, rotação
```

O resultado é 30–60 fps com controle real (mouse = toque, roda = rolagem, botão
direito = voltar, teclado digita com acentos), vários aparelhos ao mesmo tempo,
e o espelho fixado numa coluna visível em todas as telas do painel.

O `scrcpy.exe` continua disponível para o que ele faz melhor: janela nativa e
gravação de vídeo com áudio.

---

## Requisitos

- Windows 10/11
- Navegador com **WebCodecs** (Edge ou Chrome). Sem isso o painel cai num modo
  simples, de prints sequenciais e sem controle, e avisa na tela.
- No celular: **Opções do desenvolvedor** e **Depuração USB** ligadas, e o PC
  autorizado no popup "Permitir".

ADB, scrcpy e Node vêm embutidos no instalador — não é preciso instalar nada.

> Formatou o celular? A formatação apaga as Opções do desenvolvedor, a Depuração
> USB e a autorização do PC. Refaça isso no aparelho antes de usar o programa:
> tudo aqui fala com o celular pelo adb.

---

## Como rodar

Instalador: dois cliques em `Abrir Painel.exe`. Abre em `http://localhost:8787`.

A partir do repositório (para desenvolver), é preciso colocar os binários que o
`.gitignore` mantém de fora:

| Item                          | Onde vai              | Origem                                     |
|-------------------------------|-----------------------|--------------------------------------------|
| `adb.exe` + DLLs              | `platform-tools/`     | Android SDK Platform-Tools                 |
| `scrcpy.exe` + `scrcpy-server`| `scrcpy/`             | [Genymobile/scrcpy][scrcpy] (Apache-2.0)   |
| `node.exe`                    | raiz                  | Node 24 para Windows                       |

Depois:

```bash
painel/iniciar-painel.bat
```

---

## Estrutura

```
painel/
  server.cjs            ponto de entrada: registra rotas, sobe HTTP + WebSocket
  server/
    core.cjs            caminhos, localizador do ADB, log, preferências, exec
    http.cjs            roteador, arquivos estáticos, SSE, injeção do token
    ws.cjs              servidor WebSocket RFC 6455 escrito à mão
    adb.cjs             registro de aparelhos (polling 2,2 s, cache de info)
    apks.cjs            atualizador de APKs + verificação de assinatura
    cert-apk.ps1        identidade e validade da assinatura (apksigner + parser)
    scrcpy/
      session.cjs       a engine: sobe o servidor, lê o vídeo, gerencia o ciclo
      control.cjs       as 23 mensagens de controle do protocolo
      dist.cjs          versão e envio do scrcpy-server.jar
      native.cjs        scrcpy.exe gerenciado (janela nativa e gravação)
    routes/             devices, mirror, capture, files, tools, apks, help,
                        system e legacy (as rotas da v5, intactas)
  app/
    main.js             shell da interface, roteamento, atalhos
    core/               api, estado, tarefas, doca do espelho, ícones, kit
    player/player.js    decodificador WebCodecs e captura de eventos
    views/              uma tela por arquivo
    styles/             tokens (temas e cores) + folha principal
```

Scripts de setup na raiz: `setup-celular.ps1` (etapas), `gerenciar-app.ps1`,
`extrair-apk.ps1`, `atualizar-apks.ps1`, `restaurar.ps1`.

---

## Segurança

O painel roda em `localhost`, mas isso sozinho não protege: qualquer página
aberta no navegador poderia mandar requisições para ele. Por isso:

- **token de sessão** gerado a cada inicialização, injetado no HTML e exigido em
  toda chamada de API (sem ele, `401`);
- **conferência de `Host`** contra rebinding de DNS;
- **conferência de `Origin`**;
- sem `Access-Control-Allow-Origin`.

APKs baixados pelo atualizador passam por verificação de assinatura antes de
serem adotados: o `apksigner` confere se o conteúdo bate com a assinatura, e o
certificado é comparado com o do arquivo que já estava na pasta. Veredito
negativo é terminal — não existe caminho alternativo que aceite o pacote.

Com uma ressalva honesta: o `apksigner` mora no **build-tools** do Android SDK
e depende de Java, então não vem embutido (seriam mais de 50 MB de JRE). Sem
ele, `cert-apk.ps1` cai no parser próprio e reporta `VERIFICADO=parcial` — ele
lê o certificado, mas não reconfere os digests do conteúdo. Quem quiser a
verificação completa instala o Android SDK build-tools e um Java; o painel
acha sozinho e passa a reportar `VERIFICADO=sim`.

---

## Atualização online

O painel se atualiza sozinho a partir da pasta [`publicar/`](publicar) deste
repositório:

1. `update.json` aponta para o RAW do GitHub;
2. o painel baixa `publicar/versao.json` — `{versao, notas, arquivos:[{caminho, sha256}]}`;
3. compara o `sha256` de cada arquivo com o local e baixa só os diferentes;
4. confere o hash de novo antes de gravar.

Só trafegam arquivos de texto/código (`ps1 cjs js mjs html css json txt bat md`),
sempre para dentro da pasta do programa. Arquivos que o usuário edita
(`config.json`, `apps-catalog.json`, `painel-settings.json`, `apks-fontes.json`)
**não** entram no manifesto: uma atualização nunca sobrescreve as suas listas.

Para gerar um lançamento:

```bash
powershell -ExecutionPolicy Bypass -File publicar.ps1 -Simular
```

Confira a lista, tire o `-Simular`, e faça o commit.

---

## Licença

[MIT](LICENSE) — use, copie e modifique à vontade, mantendo o aviso de
copyright.

Os componentes de terceiros que vêm junto no instalador seguem as licenças
deles, listadas no fim do [LICENSE](LICENSE): scrcpy (Apache-2.0),
Platform-Tools (Google), Node.js (MIT) e a fonte Copyduck.

---

## Créditos

- [scrcpy][scrcpy] — Genymobile, Apache-2.0. É dele o `scrcpy-server` e o
  protocolo que o painel implementa.
- [Android SDK Platform-Tools][pt] — Google (`adb`, `apksigner`).
- Fonte **Copyduck**, de Khurasan, obtida no [dafont][df]. Fica embutida em
  `painel/app/assets/fonts/`; se sumir, a marca volta para a Bahnschrift.

[scrcpy]: https://github.com/Genymobile/scrcpy
[pt]: https://developer.android.com/tools/releases/platform-tools
[df]: https://www.dafont.com/copyduck.font
