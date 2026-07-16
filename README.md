<h1 align="center">ðŸ“± Config Celular</h1>

<p align="center">
  Ferramenta portÃ¡til para configurar celulares Android (realme/ColorOS e outros) via USB â€”
  limpeza de bloatware, instalaÃ§Ã£o de apps, clones, tema escuro e muito mais, tudo por um painel local.
</p>

<p align="center">
  <a href="https://github.com/satoshigynn/config-celular/releases/latest/download/ConfigCelular-Setup.zip">
    <img src="https://img.shields.io/badge/â¬‡%20BAIXAR-Instalador%20(Windows)-2ea44f?style=for-the-badge" alt="Baixar">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vers%C3%A3o-5.0-blue"> 
  <img src="https://img.shields.io/badge/plataforma-Windows-lightgrey"> 
  <img src="https://img.shields.io/badge/celular-Android-green">
</p>

---

## â¬‡ï¸ Download

**[Â» Baixar (ConfigCelular-Setup.zip) Â«](https://github.com/satoshigynn/config-celular/releases/latest/download/ConfigCelular-Setup.zip)**

Depois de baixar:
1. **Extraia o .zip** â€” quando pedir **senha, digite:** `config`
2. Execute o **ConfigCelular-Setup.exe** que estÃ¡ dentro.

> ðŸ”’ **Por que o .zip tem senha?** A senha (`config`) impede que o navegador/antivÃ­rus "escaneiem" o instalador e mostrem um **falso alerta de vÃ­rus** no download. **NÃ£o hÃ¡ vÃ­rus** â€” Ã© sÃ³ o instalador do programa.

Ou veja todas as versÃµes na pÃ¡gina de **[Releases](https://github.com/satoshigynn/config-celular/releases)**.

> Ã‰ um instalador Ãºnico e autossuficiente: jÃ¡ vem com o **ADB** e o **Node** embutidos. NÃ£o precisa instalar mais nada.
>
> **Aviso do Windows ao abrir:** se aparecer *"O Windows protegeu o seu PC"*, clique em **"Mais informaÃ§Ãµes" â†’ "Executar assim mesmo"** (o programa nÃ£o Ã© assinado, mas nÃ£o tem vÃ­rus).

---

## âœ… Requisitos

- **PC com Windows** (10 ou 11).
- **Cabo USB de dados** (nÃ£o serve cabo sÃ³ de carga).
- Celular **Android** com a **DepuraÃ§Ã£o USB** ligada.

---

## ðŸš€ Como usar

### 1) No celular â€” ligue a DepuraÃ§Ã£o USB
- **ConfiguraÃ§Ãµes â†’ Sobre o telefone â†’** toque **7 vezes** em *"NÃºmero da versÃ£o"* (ativa as OpÃ§Ãµes do desenvolvedor).
- **OpÃ§Ãµes do desenvolvedor â†’** ligue **"DepuraÃ§Ã£o USB"**.
- Conecte o cabo USB e, no popup do celular, toque em **Permitir** (marque *"Sempre permitir deste computador"*).

### 2) No PC â€” instale e abra
- Rode o **ConfigCelular-Setup.exe** e conclua a instalaÃ§Ã£o.
- Abra o atalho **"Config Celular"** (Ãrea de Trabalho). O painel abre no navegador em `http://localhost:8787`.

### 3) No painel
- Confira o status do celular no topo: ðŸŸ¢ verde = pronto para usar.
- Escolha as etapas (ou um perfil pronto) e clique em **Configurar celular**.

---

## âœ¨ Funcionalidades

- **Configurar** â€” debloat (remover apps de fÃ¡brica/lixo), congelar serviÃ§os, instalar APKs (WhatsApp, Telegram, Islandâ€¦), Island + clones, tema escuro, e perfis prontos (Completo / Celular cru / SÃ³ apps).
- **ðŸ“± Gerenciar apps** â€” instalar, reinstalar, limpar dados e desinstalar apps â€” **por app ou em lote**.
- **ðŸ›  AvanÃ§ado** â€” diagnÃ³stico visual (bateria/armazenamento/RAM), escanear e gerenciar apps do aparelho, permissÃµes, e editor das listas.
- **ðŸ“¸ Tela ao vivo** â€” espelha a tela do celular no painel, ao vivo, com download de print.
- **â¬† AtualizaÃ§Ã£o pela nuvem** â€” o prÃ³prio painel se atualiza (baixa sÃ³ o que muda), com aviso automÃ¡tico de nova versÃ£o.

---

## ðŸ”’ Privacidade

Tudo roda **localmente** no seu PC (o celular fica no cabo). Nada Ã© enviado para a internet, exceto o download de APKs oficiais e das atualizaÃ§Ãµes do prÃ³prio programa quando vocÃª pede.

---

## ðŸ†˜ Se o celular nÃ£o for detectado

- Confirme a **DepuraÃ§Ã£o USB** ligada e o popup **"Permitir"** autorizado.
- Troque o **cabo/porta USB** (use cabo de **dados**).
- Status *"unauthorized"* = falta tocar em **Permitir** no celular.
- Alguns PCs precisam do **driver USB** do fabricante (realme/Oppo/Xiaomi).

---

<sub>Ferramenta de uso local. A pasta `publicar/` deste repositÃ³rio contÃ©m os arquivos usados pela atualizaÃ§Ã£o automÃ¡tica do painel.</sub>
