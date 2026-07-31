# Notas da versão

O `publicar.ps1` lê este arquivo: pega o bloco `## <versão>` correspondente e
grava o texto como `notas` no `publicar/versao.json`. É esse texto que aparece
no painel, em Configurações → Atualização.

## 6.1

Pacote completo com os aplicativos incluídos, e dois erros do setup corrigidos.

**O download agora vem com os APKs.** O instalador da 6.0 tinha 41 MB e criava
a pasta `apks\` vazia — quem instalava numa máquina nova e rodava o setup não
via app nenhum ser instalado. Passa a existir um pacote **completo**, com os
aplicativos junto, para preparar celular sem depender de baixar nada. O pacote
leve continua disponível para quem só quer atualizar o programa.

**O setup dizia que o WhatsApp estava instalado quando não estava.** O comando
`pm list packages com.whatsapp` filtra por trecho no próprio aparelho e devolve
também `com.whatsapp.w4b`. A verificação comparava por trecho, então o WhatsApp
Business fazia o WhatsApp comum parecer presente: o resumo final anunciava
"WhatsApp: sim" num celular que só tinha o Business, e o clonador dizia
"[já clonado]" sobre um app ausente. Agora a comparação é com a linha inteira.

**A pasta de APKs vazia passava em silêncio.** A etapa de instalação imprimia o
cabeçalho e mais nada, sem dizer que não havia o que instalar. Agora avisa e
diz onde baixar.

**Correção menor:** as propriedades do instalador ficavam presas em `6.0.0.0`
em todo lançamento seguinte; a versão agora acompanha a do pacote.

## 6.0

Espelhamento de verdade, interface nova e verificação de assinatura de APK.

**Espelhamento.** O painel agora fala o protocolo binário do scrcpy direto do
servidor Node: envia o `scrcpy-server.jar` para o aparelho, abre o túnel ADB,
recebe o H.264 e o navegador decodifica com WebCodecs. 30–60 fps com controle
de mouse e teclado — antes era um print a cada 1,5 s, sem controle. Vários
aparelhos ao mesmo tempo, cada um com sua sessão.

**Espelho fixado.** Por padrão o celular fica numa coluna ao lado do Log ao
vivo, visível em todas as telas: dá para mexer no aparelho enquanto instala
apps ou usa o shell. Liga sozinho quando o aparelho aparece e religa sozinho
se a conexão cair, com espera crescente até 12 s. `Ctrl+M` fixa/solta.

**Interface.** Menu lateral, barra superior, cartões, tema claro e escuro,
5 cores de destaque, busca por comando (`Ctrl+K`) e atalhos de teclado (`F1`
lista todos). Marca com a fonte Copyduck e marca d'água do logo no log.

**Captura.** Print em PNG e gravação de vídeo com áudio (mp4/mkv), com pasta
de destino escolhida por você.

**Arquivos.** Arraste APKs — vários de uma vez, inclusive bundles `.apks`/
`.xapk`/`.apkm` — para instalar. Envie arquivos, navegue pelo celular e
exporte para o PC.

**Ferramentas ADB.** Recovery, bootloader, fastboot, sideload,
desinstalar/desativar apps, limpar cache, alterar resolução e densidade,
logcat e shell interativo.

**Wi-Fi.** Liga o ADB por rede num clique, guarda os aparelhos conhecidos e
reconecta sozinho quando eles voltam.

**Ajuda.** Diagnóstico com 11 checagens no PC e no aparelho, guia por
fabricante (Xiaomi/Redmi/POCO, Samsung, realme/OPPO, Motorola, Pixel),
catálogo de erros frequentes e botões que abrem a tela certa no celular.

**Atualizador de APKs.** Baixa das fontes oficiais e verifica a assinatura de
cada pacote antes de adotar: `apksigner` confere se o conteúdo bate com a
assinatura e o certificado é comparado com o que já estava na pasta. Pacote
com assinatura inválida é recusado. Bundles são extraídos e instalados com
`install-multiple`.

**Renomear aparelho.** Apelido por número de série, aplicado em todas as
telas.

**Segurança.** O painel deixou de aceitar chamadas de outros sites — antes
qualquer página aberta no navegador podia dar comandos no seu celular. Agora
exige token de sessão, e confere `Host` e `Origin`.

**Observação para quem atualiza pelo painel:** o canal de atualização só
transporta arquivos de texto/código. O logo e as fontes não viajam por ele; o
painel funciona sem eles (usa o ícone embutido e a Bahnschrift do Windows).
Para o visual completo, use o instalador.

## 5.0

Versão anterior: painel web com prints sequenciais (sem controle), setup por
etapas, gerenciamento de apps e debloat.
