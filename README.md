<h1 align="center">📱 Config Celular</h1>

<p align="center">
  Ferramenta portátil para configurar celulares Android (realme/ColorOS e outros) via USB —
  limpeza de bloatware, instalação de apps, clones, tema escuro e muito mais, tudo por um painel local.
</p>

<p align="center">
  <a href="https://github.com/satoshigynn/config-celular/releases/latest/download/ConfigCelular-Setup.exe">
    <img src="https://img.shields.io/badge/⬇%20BAIXAR-Instalador%20(Windows)-2ea44f?style=for-the-badge" alt="Baixar">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vers%C3%A3o-3.5-blue"> 
  <img src="https://img.shields.io/badge/plataforma-Windows-lightgrey"> 
  <img src="https://img.shields.io/badge/celular-Android-green">
</p>

---

## ⬇️ Download

**[» Baixar o instalador (ConfigCelular-Setup.exe) «](https://github.com/satoshigynn/config-celular/releases/latest/download/ConfigCelular-Setup.exe)**

Ou veja todas as versões na página de **[Releases](https://github.com/satoshigynn/config-celular/releases)**.

> É um instalador único e autossuficiente: já vem com o **ADB** e o **Node** embutidos. Não precisa instalar mais nada.

---

## ✅ Requisitos

- **PC com Windows** (10 ou 11).
- **Cabo USB de dados** (não serve cabo só de carga).
- Celular **Android** com a **Depuração USB** ligada.

---

## 🚀 Como usar

### 1) No celular — ligue a Depuração USB
- **Configurações → Sobre o telefone →** toque **7 vezes** em *"Número da versão"* (ativa as Opções do desenvolvedor).
- **Opções do desenvolvedor →** ligue **"Depuração USB"**.
- Conecte o cabo USB e, no popup do celular, toque em **Permitir** (marque *"Sempre permitir deste computador"*).

### 2) No PC — instale e abra
- Rode o **ConfigCelular-Setup.exe** e conclua a instalação.
- Abra o atalho **"Config Celular"** (Área de Trabalho). O painel abre no navegador em `http://localhost:8787`.

### 3) No painel
- Confira o status do celular no topo: 🟢 verde = pronto para usar.
- Escolha as etapas (ou um perfil pronto) e clique em **Configurar celular**.

---

## ✨ Funcionalidades

- **Configurar** — debloat (remover apps de fábrica/lixo), congelar serviços, instalar APKs (WhatsApp, Telegram, Island…), Island + clones, tema escuro, e perfis prontos (Completo / Celular cru / Só apps).
- **📱 Gerenciar apps** — instalar, reinstalar, limpar dados e desinstalar apps — **por app ou em lote**.
- **🛠 Avançado** — diagnóstico visual (bateria/armazenamento/RAM), escanear e gerenciar apps do aparelho, permissões, e editor das listas.
- **📸 Tela ao vivo** — espelha a tela do celular no painel, ao vivo, com download de print.
- **⬆ Atualização pela nuvem** — o próprio painel se atualiza (baixa só o que muda), com aviso automático de nova versão.

---

## 🔒 Privacidade

Tudo roda **localmente** no seu PC (o celular fica no cabo). Nada é enviado para a internet, exceto o download de APKs oficiais e das atualizações do próprio programa quando você pede.

---

## 🆘 Se o celular não for detectado

- Confirme a **Depuração USB** ligada e o popup **"Permitir"** autorizado.
- Troque o **cabo/porta USB** (use cabo de **dados**).
- Status *"unauthorized"* = falta tocar em **Permitir** no celular.
- Alguns PCs precisam do **driver USB** do fabricante (realme/Oppo/Xiaomi).

---

<sub>Ferramenta de uso local. A pasta `publicar/` deste repositório contém os arquivos usados pela atualização automática do painel.</sub>
