/* ==========================================================================
   views/help.js - Ajuda: diagnostico, guias por fabricante e erros frequentes
   --------------------------------------------------------------------------
   Nao e so texto: o diagnostico RODA verificacoes no aparelho e diz o que
   exatamente esta faltando, e os guias tem botoes que abrem a tela certa no
   celular (Opcoes do desenvolvedor, Sobre o telefone, Seguranca...).
   ========================================================================== */

import { h, mount, clear, toast, copy, debounce } from '../core/kit.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { currentSerial, currentDevice, hasDevice } from '../core/state.js';
import { go } from '../core/shell.js';
import { card, btn, iconBtn, chip, emptyState } from '../ui/widgets.js';

let filtro = '';
let familiaAtiva = 'auto';

/* ======================================================== GUIAS POR MARCA == */
const GUIAS = {
  xiaomi: {
    nome: 'Xiaomi · Redmi · POCO',
    sistema: 'MIUI / HyperOS',
    aviso: 'E a marca que mais bloqueia o ADB. Sem os dois interruptores abaixo, o painel consegue LER o aparelho mas nao consegue instalar apps nem alterar permissoes.',
    passos: [
      {
        t: 'Ligar as Opcoes do desenvolvedor',
        d: 'Ajustes > Sobre o telefone > toque 7 vezes em "Versao do MIUI" (ou "Versao do HyperOS"). Vai aparecer "Voce agora e um desenvolvedor".',
      },
      {
        t: 'Entrar na conta Mi (obrigatorio)',
        d: 'Ajustes > Conta Mi. Os dois interruptores seguintes NAO ligam sem uma conta Mi conectada. A Xiaomi tambem costuma exigir um chip no aparelho e internet ativa (as vezes dados moveis, nao so Wi-Fi).',
        critico: true,
      },
      {
        t: 'Ligar "Depuracao USB"',
        d: 'Ajustes > Configuracoes adicionais > Opcoes do desenvolvedor > Depuracao USB.',
      },
      {
        t: 'Ligar "Instalar via USB"',
        d: 'Na mesma tela das Opcoes do desenvolvedor. E este que permite o painel INSTALAR APKs. Sem ele o erro e INSTALL_FAILED_USER_RESTRICTED.',
        critico: true,
      },
      {
        t: 'Ligar "Depuracao USB (Configuracoes de seguranca)"',
        d: 'Tambem nas Opcoes do desenvolvedor. E este que libera ALTERAR PERMISSOES e a automacao de tela. Sem ele o erro e SecurityException / RUNTIME_PERMISSIONS. Ao ligar, o aparelho pede confirmacao da conta Mi e reinicia a conexao USB.',
        critico: true,
      },
      {
        t: 'Se aparecer "Tente novamente mais tarde"',
        d: 'A Xiaomi limita contas Mi recem-criadas. Costuma liberar depois de algumas horas com a conta conectada e o chip no aparelho. Nao ha como contornar pelo PC.',
      },
      {
        t: 'Desligar "Otimizacao MIUI" (MIUI 12 e anteriores)',
        d: 'Opcoes do desenvolvedor > Otimizacao MIUI (no fim da lista). Nas versoes antigas ela atrapalha o pm grant. No HyperOS essa opcao nao existe mais.',
      },
    ],
    obs: [
      'Depois de ligar cada interruptor, desconecte e reconecte o cabo - a autorizacao USB e refeita.',
      'O popup "Permitir depuracao USB" pode aparecer de novo a cada mudanca. Marque "Sempre permitir deste computador".',
      'Em alguns modelos a opcao "Instalar via USB" volta a desligar sozinha depois de um tempo. Se um dia parar de instalar, confira ela primeiro.',
    ],
  },

  samsung: {
    nome: 'Samsung',
    sistema: 'One UI',
    aviso: 'Funciona bem com o ADB. O unico tropeco moderno e o Auto Blocker, que veio ligado por padrao no One UI 6.1 em diante.',
    passos: [
      {
        t: 'Ligar as Opcoes do desenvolvedor',
        d: 'Ajustes > Sobre o telefone > Informacoes de software > toque 7 vezes em "Numero da versao".',
      },
      {
        t: 'Ligar "Depuracao USB"',
        d: 'Ajustes > Opcoes do desenvolvedor > Depuracao USB. Aceite o popup no celular.',
      },
      {
        t: 'Desligar o Auto Blocker',
        d: 'Ajustes > Seguranca e privacidade > Auto Blocker. Ligado, ele bloqueia a instalacao de apps por fontes nao autorizadas (inclusive o ADB) e ignora comandos USB com a tela bloqueada.',
        critico: true,
      },
      {
        t: 'Deixar a tela desbloqueada durante o uso',
        d: 'O Knox recusa varios comandos com o aparelho trancado. Em Opcoes do desenvolvedor, ligar "Permanecer ativo" ajuda.',
      },
    ],
    obs: [
      'Permissoes por ADB (pm grant) funcionam normalmente na Samsung.',
      'O clonador nativo da Samsung chama "Mensageiro Duplo" (Ajustes > Recursos uteis). O painel usa o Island para perfil de trabalho, que funciona em paralelo.',
      'Em aparelhos com Knox corporativo (MDM) varias acoes ficam bloqueadas por politica da empresa - nao ha o que fazer pelo painel.',
    ],
  },

  realme: {
    nome: 'realme · OPPO · OnePlus',
    sistema: 'ColorOS',
    aviso: 'E a marca para a qual o programa foi feito - as etapas exclusivas (App Market, clonador nativo, OTA) so aparecem aqui.',
    passos: [
      {
        t: 'Ligar as Opcoes do desenvolvedor',
        d: 'Ajustes > Sobre o dispositivo > Versao > toque 7 vezes em "Numero da versao".',
      },
      {
        t: 'Ligar "Depuracao USB"',
        d: 'Ajustes > Configuracoes adicionais > Opcoes do desenvolvedor > Depuracao USB.',
      },
      {
        t: 'Ligar "Depuracao USB (Config. de seguranca)"',
        d: 'Na mesma tela. Libera alterar permissoes e a automacao de tela. Pode pedir conta e chip, como na Xiaomi.',
        critico: true,
      },
      {
        t: 'Desativar o monitoramento de permissoes',
        d: 'Opcoes do desenvolvedor > "Desativar monitoramento de permissoes" (quando existir). Evita que o ColorOS revogue sozinho o que o painel concedeu.',
      },
    ],
    obs: [
      'Apagar a tela pelo espelhamento NAO funciona em varios ColorOS: a ROM bloqueia o comando de energia via ADB. Use o botao fisico.',
      'O clonador nativo do realme e usado pela etapa "Clonador nativo" da tela Configurar.',
      'A etapa "WA Business (loja)" usa a App Market do proprio aparelho - por isso so aparece aqui.',
    ],
  },

  motorola: {
    nome: 'Motorola · Lenovo',
    sistema: 'Android quase puro',
    aviso: 'Poucas travas. Costuma funcionar direto.',
    passos: [
      { t: 'Ligar as Opcoes do desenvolvedor', d: 'Ajustes > Sobre o telefone > toque 7 vezes em "Numero da versao".' },
      { t: 'Ligar "Depuracao USB"', d: 'Ajustes > Sistema > Opcoes do desenvolvedor > Depuracao USB.' },
    ],
    obs: ['Permissoes e instalacao por ADB funcionam sem interruptor extra.'],
  },

  google: {
    nome: 'Google Pixel',
    sistema: 'Android puro',
    aviso: 'O cenario mais simples: tudo o que o painel faz funciona sem travas do fabricante.',
    passos: [
      { t: 'Ligar as Opcoes do desenvolvedor', d: 'Ajustes > Sobre o telefone > toque 7 vezes em "Numero da versao".' },
      { t: 'Ligar "Depuracao USB"', d: 'Ajustes > Sistema > Opcoes do desenvolvedor > Depuracao USB.' },
    ],
    obs: ['As etapas exclusivas do realme (App Market, clonador nativo, OTA da Oppo) sao puladas automaticamente.'],
  },

  generico: {
    nome: 'Outras marcas',
    sistema: 'Android',
    aviso: 'O caminho e sempre o mesmo, mudam so os nomes dos menus.',
    passos: [
      { t: 'Ligar as Opcoes do desenvolvedor', d: 'Ajustes > Sobre o telefone > toque 7 vezes em "Numero da versao" (ou "Versao do software").' },
      { t: 'Ligar "Depuracao USB"', d: 'Procure por "Opcoes do desenvolvedor" nos Ajustes e ligue "Depuracao USB".' },
      { t: 'Procurar travas do fabricante', d: 'Se instalar apps ou alterar permissoes falhar, procure nas Opcoes do desenvolvedor por algo como "Instalar via USB" ou "Depuracao USB (seguranca)".' },
    ],
    obs: [],
  },
};

/* ====================================================== ERROS FREQUENTES == */
const ERROS = [
  {
    cat: 'Conexao',
    sintoma: 'O painel diz "Nenhum aparelho conectado" mesmo com o cabo ligado',
    causa: 'Quase sempre e o cabo: muitos cabos so conduzem energia, sem dados. Tambem pode ser a porta USB ou a falta do driver do fabricante.',
    solucao: [
      'Troque por um cabo de DADOS (o que veio na caixa costuma servir).',
      'Troque de porta USB - prefira as da traseira do PC, ligadas direto na placa-mae.',
      'No celular, puxe a barra de notificacoes e toque em "Carregando por USB" > escolha "Transferencia de arquivos (MTP)".',
      'Se o Windows nao reconhecer nada, instale o driver USB do fabricante.',
    ],
  },
  {
    cat: 'Conexao',
    sintoma: 'Aparece "Autorize no celular" / estado unauthorized',
    causa: 'O aparelho ainda nao confia neste computador. A chave de autorizacao e por PC.',
    solucao: [
      'Olhe a tela do celular: deve haver um popup "Permitir depuracao USB". Toque em PERMITIR e marque "Sempre permitir deste computador".',
      'Se o popup nao aparece: Opcoes do desenvolvedor > "Revogar autorizacoes de depuracao USB", depois desconecte e conecte de novo.',
      'Desbloqueie a tela antes de conectar - com o aparelho trancado o popup nao aparece.',
    ],
  },
  {
    cat: 'Conexao',
    sintoma: 'Estado "offline" ou o aparelho pisca entrando e saindo da lista',
    causa: 'Conexao instavel (cabo/porta) ou um segundo ADB de outra versao brigando pela porta 5037 - tipico de quem tem Android Studio ou outro gerenciador instalado.',
    solucao: [
      'Use o botao "Reiniciar o servidor ADB" no topo desta tela.',
      'Feche outros programas de Android (Android Studio, scrcpy avulso, gerenciadores de celular).',
      'Troque o cabo e evite hubs USB - ligue direto no PC.',
    ],
  },
  {
    cat: 'Instalacao',
    sintoma: 'INSTALL_FAILED_USER_RESTRICTED',
    causa: 'O fabricante bloqueou a instalacao de apps pelo ADB.',
    solucao: [
      'Xiaomi/Redmi/POCO: ligue "Instalar via USB" nas Opcoes do desenvolvedor (exige conta Mi conectada).',
      'Samsung: desligue o Auto Blocker em Ajustes > Seguranca e privacidade.',
      'Depois de mudar, reconecte o cabo.',
    ],
  },
  {
    cat: 'Instalacao',
    sintoma: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE ou SIGNATURE mismatch',
    causa: 'Ja existe uma versao instalada assinada por outra origem (ex.: veio da Play Store e o APK da pasta e de outro lugar).',
    solucao: [
      'Desinstale o app pelo painel (Gerenciar apps > Desinstalar) e instale de novo.',
      'Atencao: desinstalar apaga os dados. No WhatsApp, faca o backup antes.',
    ],
  },
  {
    cat: 'Instalacao',
    sintoma: 'INSTALL_FAILED_NO_MATCHING_ABIS',
    causa: 'O APK foi feito para outra arquitetura de processador (ex.: APK so de 64 bits num aparelho de 32).',
    solucao: [
      'O painel ja tenta sozinho o "bundle" (base + splits) da arquitetura certa quando existe.',
      'Se nao houver bundle, instale pela loja do aparelho e depois use "Extrair APK" na tela Avancado para guardar a versao compativel.',
    ],
  },
  {
    cat: 'Instalacao',
    sintoma: 'INSTALL_FAILED_INSUFFICIENT_STORAGE',
    causa: 'Falta espaco. WhatsApp e Facebook passam de 100 MB e o Android precisa do dobro durante a instalacao.',
    solucao: [
      'Ferramentas > "Limpar cache de todos os apps".',
      'Tela Avancado > escaneie e remova o que nao usa.',
      'Configuracoes > Manutencao do programa tambem libera espaco no PC (nao no celular).',
    ],
  },
  {
    cat: 'Permissoes',
    sintoma: 'SecurityException / RUNTIME_PERMISSIONS ao conceder permissoes',
    causa: 'A ROM bloqueia alterar permissoes pelo ADB. E o comportamento padrao de Xiaomi/MIUI/HyperOS e de varios ColorOS.',
    solucao: [
      'Ligue "Depuracao USB (Configuracoes de seguranca)" nas Opcoes do desenvolvedor.',
      'Na Xiaomi isso exige conta Mi conectada, chip no aparelho e internet.',
      'Em Samsung, Pixel e Motorola normalmente ja funciona sem nada disso.',
    ],
  },
  {
    cat: 'Espelhamento',
    sintoma: 'O espelho nao abre ou fica em "Nao consegui espelhar"',
    causa: 'O scrcpy-server nao subiu no aparelho. Costuma ser tela bloqueada, aparelho recem-ligado ou USB instavel.',
    solucao: [
      'Desbloqueie a tela do celular e clique em "Tentar de novo".',
      'Reconecte o cabo - o painel religa sozinho em poucos segundos.',
      'Se persistir, use "Janela nativa" (abre o scrcpy por fora) ou o "Modo simples".',
    ],
  },
  {
    cat: 'Espelhamento',
    sintoma: 'A imagem trava ou fica embaralhada',
    causa: 'Um quadro-chave se perdeu no caminho.',
    solucao: [
      'Clique em "Novo keyframe" na tela Espelhamento.',
      'Se voltar a acontecer, baixe o bitrate (Qualidade do video > 4 Mbps) - tipico em conexao Wi-Fi fraca.',
    ],
  },
  {
    cat: 'Espelhamento',
    sintoma: 'O navegador avisa que nao tem WebCodecs',
    causa: 'O espelho com controle depende do WebCodecs para decodificar o video.',
    solucao: [
      'Abra o painel no Microsoft Edge ou no Google Chrome atualizados.',
      'Sem WebCodecs o painel continua funcionando, mas o espelho vira prints sequenciais, sem controle.',
    ],
  },
  {
    cat: 'Espelhamento',
    sintoma: '"Apagar a tela" nao faz nada',
    causa: 'Varias ROMs (ColorOS, MIUI) bloqueiam o comando de energia da tela via ADB.',
    solucao: ['Nao ha contorno pelo PC - use o botao fisico do aparelho.'],
  },
  {
    cat: 'Captura',
    sintoma: 'A gravacao gerou um arquivo de 0 byte ou corrompido',
    causa: 'A gravacao foi encerrada a forca. O arquivo de video so e fechado corretamente quando a gravacao termina do jeito certo.',
    solucao: [
      'Sempre pare pelo botao "Parar" da tela Captura.',
      'Nao feche a janela preta do painel enquanto grava.',
    ],
  },
  {
    cat: 'Wi-Fi',
    sintoma: 'Conectei por Wi-Fi e depois de um tempo caiu',
    causa: 'O IP do aparelho mudou (DHCP) ou a economia de bateria derrubou o adbd.',
    solucao: [
      'O painel tenta reconectar sozinho os aparelhos conhecidos a cada 15 s.',
      'Se o IP mudou, reconecte uma vez pelo cabo e use "Ligar Wi-Fi neste aparelho" de novo.',
      'Deixe o celular fora da economia de bateria enquanto usar sem cabo.',
    ],
  },
  {
    cat: 'Wi-Fi',
    sintoma: 'Reiniciei o celular e o Wi-Fi parou de funcionar',
    causa: 'O modo TCP/IP do ADB nao sobrevive a um reinicio - e assim no Android inteiro.',
    solucao: ['Conecte o cabo uma vez e clique em "Ligar Wi-Fi neste aparelho" novamente.'],
  },
  {
    cat: 'Painel',
    sintoma: 'O painel nao abre / "a porta 8787 ja esta em uso"',
    causa: 'Ja existe um painel aberto, ou sobrou um node.exe rodando de uma sessao anterior.',
    solucao: [
      'Feche a janela preta antiga do painel e abra de novo.',
      'Se nao houver janela, abra o Gerenciador de Tarefas e encerre o "Node.js JavaScript Runtime".',
    ],
  },
  {
    cat: 'Painel',
    sintoma: 'Mudou alguma coisa mas a tela continua igual',
    causa: 'O navegador guardou a versao antiga dos arquivos.',
    solucao: [
      'Pressione F5. Se nao resolver, Ctrl+F5 (recarga forcada).',
      'Se o painel avisar que baixou uma atualizacao, FECHE a janela preta e abra de novo - F5 nao basta nesse caso.',
    ],
  },
  {
    cat: 'Painel',
    sintoma: 'Uma tarefa travou e nada mais responde',
    causa: 'As tarefas que mexem no aparelho entram numa fila e rodam uma de cada vez.',
    solucao: [
      'Clique em "Parar" na doca de Log ao vivo (Ctrl+L) - isso cancela a tarefa atual e libera a fila.',
      'A tecla Esc faz o mesmo.',
    ],
  },
  {
    cat: 'Debloat',
    sintoma: 'Removi um app por engano',
    causa: 'O debloat usa "pm uninstall --user 0": o app sai do perfil mas continua no firmware.',
    solucao: [
      'Tela Configurar > Ferramentas > "Restaurar removidos" traz de volta tudo o que o debloat tirou deste aparelho.',
      'A lista do que foi removido fica em logs\\<serial>-removidos.txt.',
    ],
  },
  {
    cat: 'Debloat',
    sintoma: 'O celular ficou estranho depois da limpeza',
    causa: 'Algum app de sistema que a lista nao protegia era necessario nessa ROM.',
    solucao: [
      'Use "Restaurar removidos" e reinicie o aparelho.',
      'Depois, na tela Avancado, adicione esse pacote a lista "protect" para nunca mais ser removido.',
      'Na primeira vez em um modelo novo, use sempre "Simular (dry-run)" para revisar antes.',
    ],
  },
];

/* ============================================================== FAQ ======= */
const FAQ = [
  {
    q: 'Preciso de root?',
    a: 'Nao. Tudo funciona com o aparelho de fabrica, so com a Depuracao USB ligada.',
  },
  {
    q: 'Isso apaga meus dados?',
    a: 'Nenhuma acao apaga dados sem confirmacao. "Limpar dados" e "Reinstalar" avisam antes, e o debloat mostra a lista completa do que vai remover.',
  },
  {
    q: 'Preciso de internet?',
    a: 'Nao para o dia a dia: tudo roda entre o PC e o celular. So "Atualizar APKs" e "Atualizar programa" baixam da internet.',
  },
  {
    q: 'Da para usar em varios celulares ao mesmo tempo?',
    a: 'Sim. Todos aparecem na tela Dispositivos, cada um com sua sessao. O aparelho escolhido no topo e o alvo de todas as acoes. No espelhamento, "Ver todos" mostra os demais lado a lado.',
  },
  {
    q: 'O que e o "Simular (dry-run)"?',
    a: 'Executa tudo em modo de teste: o painel mostra exatamente o que faria, sem alterar nada no celular. Use sempre na primeira vez em um modelo novo.',
  },
  {
    q: 'Onde ficam os arquivos?',
    a: 'Prints e gravacoes na pasta escolhida em Captura (por padrao capturas\\). APKs em apks\\. Logs de cada execucao em logs\\, e o log do proprio programa em logs\\_painel\\.',
  },
  {
    q: 'O painel manda meus dados para algum lugar?',
    a: 'Nao. O servidor so escuta em 127.0.0.1 (o proprio PC) e exige um token de sessao. Nenhum site aberto no navegador consegue dar comandos no seu celular.',
  },
  {
    q: 'Qual a diferenca entre "clone" e "perfil de trabalho"?',
    a: 'Perfil de trabalho e um usuario separado do Android (criado pelo Island ou pelo clonador do fabricante). Os apps ali sao independentes: outra conta, outros dados. E o que o painel gerencia na secao "Clones" da tela Gerenciar apps.',
  },
];

/* =========================================================== COMPONENTES == */
function passo(p, i) {
  return h('div.row', {},
    h('div.row__icon', { style: p.critico ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {} }, String(i + 1)),
    h('div.row__main', {},
      h('b', {}, p.t, p.critico ? h('span.chip.chip--accent', { style: { marginLeft: '8px' } }, 'essencial') : null),
      h('small', { style: { whiteSpace: 'normal' } }, p.d))
  );
}

function blocoErro(e) {
  const aberto = h('div', { style: { display: 'none' } },
    h('p.small.muted', { style: { marginBottom: '8px' } }, h('b', {}, 'Por que acontece: '), e.causa),
    h('div.stack', { style: { gap: '4px' } },
      ...e.solucao.map((s) => h('div.hstack', { style: { alignItems: 'flex-start', gap: '8px' } },
        icon('check', 14), h('span.small', { style: { flex: 1 } }, s))))
  );

  const head = h('button.row', {
    style: { width: '100%', textAlign: 'left', cursor: 'pointer' },
    onclick: () => {
      const on = aberto.style.display === 'none';
      aberto.style.display = on ? 'block' : 'none';
      seta.style.transform = on ? 'rotate(90deg)' : '';
    },
  },
    h('div.row__icon', {}, icon('warning', 16)),
    h('div.row__main', {}, h('b', { style: { whiteSpace: 'normal' } }, e.sintoma), h('small', {}, e.cat)),
    h('span', { style: { transition: 'transform .15s' } }, icon('back', 14))
  );
  const seta = head.lastChild;
  seta.style.transform = 'rotate(180deg)';

  return h('div', { style: { borderBottom: '1px solid var(--line)' } },
    head,
    h('div', { style: { padding: '0 var(--sp-5) var(--sp-4) 62px' } }, aberto));
}

function combina(texto) {
  if (!filtro) return true;
  return String(texto).toLowerCase().includes(filtro);
}

/* ================================================================ VIEW ==== */
export const helpView = {
  id: 'help',
  title: 'Ajuda',
  subtitle: 'Guia por fabricante, erros frequentes e diagnostico do aparelho',
  icon: 'info',
  group: 'sistema',

  actions: () => [
    btn('Reiniciar o servidor ADB', {
      small: true, icon: 'refresh',
      title: 'Resolve conflitos com outro ADB (Android Studio, etc.)',
      onClick: async () => {
        try { const r = await api.get('/api/help/restart-adb'); toast(r.out || 'Servidor ADB reiniciado', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      },
    }),
  ],

  async render(root) {
    const busca = h('input.input', {
      placeholder: 'Buscar nesta pagina: erro, mensagem, marca...', value: filtro,
    });
    const corpo = h('div');

    /* -------------------------------------------------- diagnostico ------ */
    const diagBox = h('div');
    const rodarDiagnostico = async () => {
      if (!hasDevice()) {
        mount(diagBox, h('p.small.muted', {},
          'Conecte um aparelho para o diagnostico verificar as travas do fabricante. As checagens do PC (ADB e scrcpy) rodam mesmo assim.'));
      }
      mount(diagBox, h('div.hstack', {}, h('span.spinner'), 'Verificando o PC e o aparelho...'));
      try {
        const r = await api.get('/api/help/diagnose', { serial: currentSerial() });
        clear(diagBox);

        const resumo = r.resumo || {};
        diagBox.appendChild(h('div.hstack.mb-3', {},
          chip(`${resumo.ok || 0} ok`, 'ok', 'check'),
          resumo.aviso ? chip(`${resumo.aviso} aviso(s)`, 'warn', 'warning') : null,
          resumo.erro ? chip(`${resumo.erro} problema(s)`, 'err', 'close') : null,
          r.fabricante ? chip(`${r.fabricante} ${r.modelo || ''}`) : null,
          r.android ? chip('Android ' + r.android) : null));

        const lista = h('div.list');
        for (const c of r.checagens) {
          const kind = c.estado === 'ok' ? 'ok' : c.estado === 'aviso' ? 'warn' : 'err';
          lista.appendChild(h('div.row', {},
            h('div.row__icon', { style: { color: `var(--${kind === 'err' ? 'err' : kind})` } },
              icon(c.estado === 'ok' ? 'check' : c.estado === 'aviso' ? 'warning' : 'close', 16)),
            h('div.row__main', {},
              h('b', {}, c.titulo),
              h('small', { style: { whiteSpace: 'normal' } }, c.detalhe),
              c.dica ? h('small', { style: { whiteSpace: 'normal', color: `var(--${kind === 'ok' ? 'text-dim' : kind})`, marginTop: '3px' } }, c.dica) : null)
          ));
        }
        diagBox.appendChild(lista);

        // o guia do fabricante detectado sobe para o topo
        if (r.familia && r.familia !== 'generico') {
          familiaAtiva = r.familia;
          desenhar();
        }
      } catch (e) {
        mount(diagBox, h('p.small.err', {}, 'Falha no diagnostico: ' + e.message));
      }
    };

    /* ------------------------------------------------ atalhos no aparelho - */
    const abrirTela = async (screen, nome) => {
      if (!hasDevice()) return toast('Conecte um aparelho primeiro', 'warn');
      try {
        await api.get('/api/help/open-setting', { serial: currentSerial(), screen });
        toast(`"${nome}" aberto no celular`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };

    /* ----------------------------------------------------- desenhar tudo -- */
    const desenhar = () => {
      clear(corpo);
      const dev = currentDevice();

      // --- guias por fabricante ---
      const chaves = ['xiaomi', 'samsung', 'realme', 'motorola', 'google', 'generico'];
      const abas = h('div.btnrow.mb-4', {}, ...chaves.map((k) => {
        const b = btn(GUIAS[k].nome, {
          small: true,
          variant: familiaAtiva === k ? 'primary' : undefined,
          onClick: () => { familiaAtiva = k; desenhar(); },
        });
        return b;
      }));

      const g = GUIAS[familiaAtiva] || GUIAS.generico;
      const guiaVisivel = combina(g.nome + ' ' + g.sistema + ' ' + g.aviso +
        g.passos.map((p) => p.t + p.d).join(' ') + (g.obs || []).join(' '));

      if (guiaVisivel) {
        corpo.appendChild(card(`Como preparar: ${g.nome}`, {
          subtitle: g.sistema,
          actions: [
            btn('Abrir "Sobre o telefone"', { small: true, icon: 'external', onClick: () => abrirTela('about', 'Sobre o telefone') }),
            btn('Abrir Opcoes do desenvolvedor', { small: true, icon: 'external', onClick: () => abrirTela('dev', 'Opcoes do desenvolvedor') }),
          ],
          flush: true,
        },
          h('div.card__body', {}, abas, h('p.small', { class: 'warn' }, g.aviso)),
          h('div.list', {}, ...g.passos.map(passo)),
          (g.obs && g.obs.length)
            ? h('div.card__body', {},
              h('div.section-title', { style: { paddingLeft: 0 } }, 'Bom saber'),
              h('div.stack', { style: { gap: '6px' } },
                ...g.obs.map((o) => h('div.hstack', { style: { alignItems: 'flex-start', gap: '8px' } },
                  icon('info', 14), h('span.small.muted', { style: { flex: 1 } }, o)))))
            : null
        ));
      }

      // --- erros frequentes, agrupados ---
      const filtrados = ERROS.filter((e) => combina(e.sintoma + ' ' + e.causa + ' ' + e.cat + ' ' + e.solucao.join(' ')));
      const cats = [...new Set(filtrados.map((e) => e.cat))];
      if (filtrados.length) {
        const lista = h('div');
        for (const cat of cats) {
          lista.appendChild(h('div.section-title', {}, cat));
          for (const e of filtrados.filter((x) => x.cat === cat)) lista.appendChild(blocoErro(e));
        }
        corpo.appendChild(card('Erros frequentes', {
          subtitle: `${filtrados.length} situacao(oes) - clique para ver a solucao`,
          flush: true,
        }, lista));
      }

      // --- FAQ ---
      const faq = FAQ.filter((f) => combina(f.q + ' ' + f.a));
      if (faq.length) {
        corpo.appendChild(card('Perguntas rapidas', { flush: true },
          h('div.list', {}, ...faq.map((f) => h('div.row', {},
            h('div.row__icon', {}, icon('info', 16)),
            h('div.row__main', {},
              h('b', { style: { whiteSpace: 'normal' } }, f.q),
              h('small', { style: { whiteSpace: 'normal' } }, f.a)))))));
      }

      // --- atalhos ---
      if (combina('atalhos telas do aparelho abrir ajustes')) {
        corpo.appendChild(card('Abrir uma tela no celular', {
          subtitle: 'O painel abre o menu direto no aparelho - util quando o caminho muda de marca para marca.',
        },
          h('div.actiongrid', {},
            ...[['dev', 'Opcoes do desenvolvedor'], ['about', 'Sobre o telefone'], ['security', 'Seguranca'],
            ['apps', 'Aplicativos'], ['wifi', 'Wi-Fi'], ['battery', 'Bateria'],
            ['accounts', 'Contas'], ['update', 'Atualizacao']]
              .map(([k, nome]) => btn(nome, { small: true, icon: 'external', onClick: () => abrirTela(k, nome) })))));
      }

      if (!corpo.children.length) {
        corpo.appendChild(emptyState('search', 'Nada encontrado', `Nenhum item combina com "${filtro}".`));
      }
    };

    busca.addEventListener('input', debounce((e) => { filtro = e.target.value.trim().toLowerCase(); desenhar(); }, 180));

    mount(root,
      card('Diagnostico do seu caso', {
        subtitle: 'Verifica o PC e o aparelho e aponta exatamente o que esta faltando.',
        actions: [btn('Verificar agora', { small: true, variant: 'primary', icon: 'shield', onClick: rodarDiagnostico })],
      }, diagBox),
      busca,
      h('div', { style: { height: '12px' } }),
      corpo
    );

    mount(diagBox, h('p.small.muted', {}, 'Clique em "Verificar agora" para o painel testar a conexao, as travas do fabricante e o que mais faltar.'));
    desenhar();
    if (hasDevice()) rodarDiagnostico();
  },

  commands: [
    { label: 'Abrir a Ajuda', icon: 'info', run: () => go('help') },
    { label: 'Diagnosticar problemas do aparelho', icon: 'shield', run: () => go('help') },
  ],
};
