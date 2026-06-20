'use strict';

/* ===================================================
   CONFIGURAÇÃO — edite aqui para mudar nomes e cores
   =================================================== */
const PESSOAS = [
  { id: 'mateus',  nome: 'Mateus',  cor: '#f5a724' },
  { id: 'sorriso', nome: 'Sorriso', cor: '#4ecdc4' },
  { id: 'caio',    nome: 'Caio',    cor: '#b48bff' },
];

/* ===================================================
   FIREBASE — banco de dados compartilhado
   ===================================================

   Passo a passo (veja também o README.md):
   1. Crie um projeto grátis em https://console.firebase.google.com
   2. No menu lateral, abra "Realtime Database" → Criar banco de dados
      → comece em modo de teste (ajustamos as regras depois).
   3. Vá em Configurações do projeto (ícone de engrenagem) → Geral →
      "Seus apps" → ícone </> (Web) → registre o app.
   4. O Firebase mostra um objeto "firebaseConfig" — copie SÓ OS
      VALORES dele (apiKey, authDomain, etc.) para dentro dos campos
      abaixo. NÃO troque o nome "FIREBASE_CONFIG" pelo nome que o
      Firebase usa ("firebaseConfig", minúsculo) — o resto do código
      espera exatamente esse nome, em maiúsculas. Troque só o que
      está escrito "COLE_AQUI".
   5. Em Realtime Database → Regras, cole:
        { "rules": { ".read": true, ".write": true } }
      (sem login pra simplificar — ok pra um app de 3 amigos, mas
      qualquer pessoa com o link do site consegue escrever dados).
*/
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDrymkBS-SAlNl32ujHJ4veK9B-8r3Y4hU",
    authDomain: "rachadinha-c3907.firebaseapp.com",
    databaseURL: "https://rachadinha-c3907-default-rtdb.firebaseio.com",
    projectId: "rachadinha-c3907",
    storageBucket: "rachadinha-c3907.firebasestorage.app",
    messagingSenderId: "37555514703",
    appId: "1:37555514703:web:963f6b22338bdde521293a"
};

let dbRefCorridas    = null;
let dadosCarregados  = false;
let firebaseConfigOk = false;

/* ===================================================
   ESTADO
   =================================================== */
let corridas = [];

/* ===================================================
   UTILITÁRIOS
   =================================================== */
function pessoaPorId(id) {
  return PESSOAS.find(p => p.id === id) ?? null;
}

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(dataISO) {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarNomeMes(anoMes) {
  // anoMes = "2026-06"
  const [ano, mes] = anoMes.split('-');
  const d = new Date(Number(ano), Number(mes) - 1, 1);
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function gerarId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function arredondar(v) {
  return Math.round(v * 100) / 100;
}

/* ===================================================
   FIREBASE — conexão e sincronização em tempo real
   =================================================== */
function inicializarFirebase() {
  firebaseConfigOk = Object.values(FIREBASE_CONFIG).every(v => v && v !== 'COLE_AQUI');

  if (!firebaseConfigOk) {
    console.warn('Firebase não configurado — preencha FIREBASE_CONFIG no topo do script.js.');
    mostrarToast('⚠️ Configure o Firebase no script.js para sincronizar os dados.');
    dadosCarregados = true;
    renderizarTudo();
    return;
  }

  firebase.initializeApp(FIREBASE_CONFIG);
  dbRefCorridas = firebase.database().ref('corridas');

  // dispara toda vez que algo muda no banco — seja por este celular
  // ou pelo do Sorriso/Caio — e atualiza a tela na hora
  dbRefCorridas.on('value', snapshot => {
    const dados = snapshot.val() || {};
    corridas = Object.entries(dados)
      .map(([chave, valor]) => ({ ...valor, _key: chave }))
      .sort((a, b) => b.data.localeCompare(a.data));

    dadosCarregados = true;
    renderizarTudo();
  }, erro => {
    console.error(erro);
    mostrarToast('⚠️ Sem conexão com o banco de dados. Verifique as regras do Firebase.');
  });
}

/* ===================================================
   CÁLCULO DE SALDOS
   Saldo positivo → a receber
   Saldo negativo → a pagar

   IMPORTANTE: a divisão de cada corrida (valor / nº de
   participantes) é acumulada com o valor EXATO, sem
   arredondar a cada corrida. Arredondar a cada passo e
   já usar esse valor arredondado na corrida seguinte
   acumula erro de centavos ao longo de muitos registros
   (em 16 corridas reais isso já desviava o resultado em
   alguns centavos). Por isso só arredondamos uma única
   vez, no saldo final de cada pessoa.
   =================================================== */
function calcularSaldos() {
  const saldos = {};
  PESSOAS.forEach(p => { saldos[p.id] = 0; });

  corridas.forEach(c => {
    const parteExata = c.valor / c.participantes.length;
    // quem pagou adianta o valor completo
    saldos[c.pagador] += c.valor;
    // cada participante "consome" a sua parte exata
    c.participantes.forEach(id => {
      saldos[id] -= parteExata;
    });
  });

  // arredonda só agora, no total acumulado de cada pessoa
  PESSOAS.forEach(p => { saldos[p.id] = arredondar(saldos[p.id]); });

  return saldos;
}

/* ===================================================
   CÁLCULO DE ACERTOS (quem paga pra quem)

   Dívida líquida PAR A PAR: para cada dupla, calcula
   quanto A consumiu de corridas pagas por B e quanto B
   consumiu de corridas pagas por A, e mostra só a
   diferença (quem deve pra quem, na relação direta entre
   os dois).

   Isso é diferente de simplificar tudo para o mínimo de
   transferências via um único "credor geral" — aqui a
   dívida entre Caio e Mateus aparece mesmo que os dois
   também devam para o Sorriso, porque é uma dívida real
   e direta entre eles.
   =================================================== */
function calcularConsumoPareado() {
  const consumo = {};
  PESSOAS.forEach(a => {
    consumo[a.id] = {};
    PESSOAS.forEach(b => { consumo[a.id][b.id] = 0; });
  });

  corridas.forEach(c => {
    const parteExata = c.valor / c.participantes.length;
    c.participantes.forEach(id => {
      if (id !== c.pagador) consumo[id][c.pagador] += parteExata;
    });
  });

  return consumo;
}

function calcularAcertos() {
  const consumo = calcularConsumoPareado();
  const acertos = [];

  for (let i = 0; i < PESSOAS.length; i++) {
    for (let j = i + 1; j < PESSOAS.length; j++) {
      const a = PESSOAS[i].id;
      const b = PESSOAS[j].id;
      const liquido = consumo[a][b] - consumo[b][a]; // > 0: a deve b

      if (liquido > 0.004) {
        acertos.push({ de: a, para: b, valor: arredondar(liquido) });
      } else if (liquido < -0.004) {
        acertos.push({ de: b, para: a, valor: arredondar(-liquido) });
      }
    }
  }

  // maiores valores primeiro
  return acertos.sort((x, y) => y.valor - x.valor);
}

/* ===================================================
   CHIPS (selecionar pagador / participantes)
   =================================================== */
function criarChip(tipo, pessoa, marcado) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chip-wrapper';

  const input = document.createElement('input');
  input.type      = tipo === 'pagador' ? 'radio' : 'checkbox';
  input.name      = tipo === 'pagador' ? 'pagador' : 'participante';
  input.value     = pessoa.id;
  input.id        = `chip-${tipo}-${pessoa.id}`;
  input.className = 'chip-input';
  input.checked   = marcado;
  input.setAttribute('data-test', `chip-${tipo}-${pessoa.id}`);

  const label = document.createElement('label');
  label.htmlFor   = `chip-${tipo}-${pessoa.id}`;
  label.className = 'chip';
  label.style.setProperty('--cor-pessoa', pessoa.cor);

  const inicial = document.createElement('span');
  inicial.className = 'chip__inicial';
  inicial.style.background = pessoa.cor;
  inicial.textContent = pessoa.nome[0].toUpperCase();

  const nome = document.createElement('span');
  nome.className  = 'chip__nome';
  nome.textContent = pessoa.nome;

  label.append(inicial, nome);
  wrapper.append(input, label);
  return wrapper;
}

function renderizarChips() {
  const grupoPagador       = document.getElementById('grupo-pagador');
  const grupoParticipantes = document.getElementById('grupo-participantes');
  grupoPagador.innerHTML       = '';
  grupoParticipantes.innerHTML = '';

  PESSOAS.forEach(p => {
    grupoPagador.appendChild(criarChip('pagador', p, false));
    grupoParticipantes.appendChild(criarChip('participante', p, true));
  });

  // ao selecionar quem pagou → garantir que ele seja participante
  grupoPagador.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const cb = document.querySelector(
        `#grupo-participantes input[value="${radio.value}"]`
      );
      if (cb && !cb.checked) cb.checked = true;
      atualizarPreview();
    });
  });

  grupoParticipantes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', atualizarPreview);
  });

  // Monitora mudanças nos checkboxes e campo de valor (importante para testes Cypress com force: true)
  const observer = new MutationObserver(() => {
    atualizarPreview();
  });

  grupoParticipantes.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    observer.observe(cb, { attributes: true, attributeFilter: ['checked'] });
  });

  // Monitora mudanças no campo de valor também
  const campoValor = document.getElementById('campo-valor');
  observer.observe(campoValor, { attributes: true, attributeFilter: ['value'] });
}

/* ===================================================
   PREVIEW DE DIVISÃO
   =================================================== */
function atualizarPreview() {
  const el     = document.getElementById('preview-divisao');
  const valor  = parseFloat(document.getElementById('campo-valor').value);
  const n      = document.querySelectorAll('#grupo-participantes input:checked').length;

  if (!valor || isNaN(valor) || valor <= 0 || n === 0) {
    el.textContent = '';
    return;
  }

  const porPessoa = arredondar(valor / n);
  el.textContent = `${formatarMoeda(porPessoa)} por pessoa · ${n} ${n === 1 ? 'pessoa' : 'pessoas'}`;
}

/* ===================================================
   TOAST
   =================================================== */
let _toastTimer;
function mostrarToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('toast--visivel');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('toast--visivel'), 3000);
}

/* ===================================================
   FORMULÁRIO — adicionar corrida
   =================================================== */
function inicializarForm() {
  // data padrão: hoje
  document.getElementById('campo-data').value =
    new Date().toISOString().slice(0, 10);

  const campoValor = document.getElementById('campo-valor');
  
  // Listeners de evento para atualizar preview
  campoValor.addEventListener('input', atualizarPreview);
  campoValor.addEventListener('change', atualizarPreview);
  campoValor.addEventListener('keyup', atualizarPreview);
  campoValor.addEventListener('blur', atualizarPreview);
  
  // Monitor periódico quando campo tem foco (para capturar mudanças forçadas pelo Cypress)
  let _monitorInterval;
  campoValor.addEventListener('focus', () => {
    _monitorInterval = setInterval(atualizarPreview, 100);
  });
  campoValor.addEventListener('blur', () => {
    clearInterval(_monitorInterval);
    atualizarPreview(); // Uma última atualização ao sair do campo
  });

  document.getElementById('btn-adicionar').addEventListener('click', () => {
    const data   = document.getElementById('campo-data').value.trim();
    const valor  = parseFloat(document.getElementById('campo-valor').value);
    const pagador = document.querySelector('#grupo-pagador input:checked')?.value ?? null;
    const participantes = [...document.querySelectorAll('#grupo-participantes input:checked')]
      .map(i => i.value);

    // validações
    if (!data)                         return mostrarToast('⚠️ Escolha a data da corrida.');
    if (!valor || isNaN(valor) || valor <= 0) return mostrarToast('⚠️ Insira um valor válido.');
    if (!pagador)                      return mostrarToast('⚠️ Selecione quem pagou.');
    if (participantes.length === 0)    return mostrarToast('⚠️ Selecione quem foi na corrida.');
    if (!participantes.includes(pagador))
      return mostrarToast('⚠️ Quem pagou precisa estar entre os participantes.');

    if (!firebaseConfigOk) {
      return mostrarToast('⚠️ Firebase não configurado. Veja o README.');
    }

    const corrida = {
      id: gerarId(),
      data,
      valor: arredondar(valor),
      pagador,
      participantes,
    };

    document.getElementById('btn-adicionar').disabled = true;
    dbRefCorridas.push(corrida)
      .then(() => {
        document.getElementById('campo-valor').value = '';
        atualizarPreview();
        mostrarToast('✅ Corrida registrada!');
      })
      .catch(() => mostrarToast('⚠️ Não foi possível salvar. Tente novamente.'))
      .finally(() => { document.getElementById('btn-adicionar').disabled = false; });
    // a tela é atualizada sozinha pelo listener do Firebase (dbRefCorridas.on)
  });
}

/* ===================================================
   RENDERIZAR SALDOS
   =================================================== */
function renderizarSaldos(saldos) {
  const grade = document.getElementById('grade-saldos');
  grade.innerHTML = '';

  PESSOAS.forEach(p => {
    const saldo = saldos[p.id] ?? 0;

    const card = document.createElement('div');
    card.className = 'cartao-saldo';
    card.setAttribute('data-test', `card-saldo-${p.id}`);

    // topo: avatar + nome
    const topo = document.createElement('div');
    topo.className = 'cartao-saldo__topo';

    const ini = document.createElement('div');
    ini.className = 'cartao-saldo__inicial';
    ini.style.background = p.cor;
    ini.textContent = p.nome[0].toUpperCase();

    const nome = document.createElement('div');
    nome.className = 'cartao-saldo__nome';
    nome.textContent = p.nome;

    topo.append(ini, nome);

    // valor com cor semântica
    const valorEl = document.createElement('div');
    const cls = saldo >  0.005 ? 'cartao-saldo__valor--positivo'
              : saldo < -0.005 ? 'cartao-saldo__valor--negativo'
              :                  'cartao-saldo__valor--neutro';
    valorEl.className = `cartao-saldo__valor ${cls}`;
    valorEl.setAttribute('data-test', `valor-saldo-${p.id}`);
    valorEl.textContent = formatarMoeda(Math.abs(saldo));

    // legenda
    const legenda = document.createElement('div');
    legenda.className = 'cartao-saldo__legenda';
    legenda.setAttribute('data-test', `legenda-saldo-${p.id}`);
    legenda.textContent = saldo >  0.005 ? 'a receber'
                        : saldo < -0.005 ? 'a pagar'
                        : 'tudo em dia';

    card.append(topo, valorEl, legenda);
    grade.appendChild(card);
  });
}

/* ===================================================
   RENDERIZAR ACERTOS
   =================================================== */
function renderizarAcertos(acertos) {
  const lista = document.getElementById('lista-acertos');
  lista.innerHTML = '';

  if (acertos.length === 0) {
    const vazio = document.createElement('div');
    vazio.className = 'estado-vazio';
    vazio.setAttribute('data-test', 'acertos-vazio');
    vazio.innerHTML =
      '<span class="estado-vazio__icone">🎉</span>' +
      'Ninguém deve nada pra ninguém.<br>Todo mundo está quite!';
    lista.appendChild(vazio);
    return;
  }

  acertos.forEach((a, idx) => {
    const pDe   = pessoaPorId(a.de);
    const pPara = pessoaPorId(a.para);
    if (!pDe || !pPara) return;

    const rota = document.createElement('div');
    rota.className = 'rota-acerto';
    rota.setAttribute('data-test', `rota-acerto-${idx}`);

    // — quem deve (esquerda)
    const pessoaDe = document.createElement('div');
    pessoaDe.className = 'rota-acerto__pessoa';
    pessoaDe.setAttribute('data-test', `acerto-de-${a.de}`);
    const iniDe = document.createElement('div');
    iniDe.className = 'rota-acerto__inicial';
    iniDe.style.background = pDe.cor;
    iniDe.textContent = pDe.nome[0].toUpperCase();
    const nomeDe = document.createElement('span');
    nomeDe.textContent = pDe.nome;
    pessoaDe.append(iniDe, nomeDe);

    // — caminho com valor
    const caminho = document.createElement('div');
    caminho.className = 'rota-acerto__caminho';
    const valorEl = document.createElement('span');
    valorEl.className = 'rota-acerto__valor';
    valorEl.setAttribute('data-test', `acerto-valor-${a.de}-${a.para}`);
    valorEl.textContent = formatarMoeda(a.valor);
    caminho.appendChild(valorEl);

    // — quem recebe (direita)
    const pessoaPara = document.createElement('div');
    pessoaPara.className = 'rota-acerto__pessoa';
    pessoaPara.setAttribute('data-test', `acerto-para-${a.para}`);
    const iniPara = document.createElement('div');
    iniPara.className = 'rota-acerto__inicial';
    iniPara.style.background = pPara.cor;
    iniPara.textContent = pPara.nome[0].toUpperCase();
    const nomePara = document.createElement('span');
    nomePara.textContent = pPara.nome;
    pessoaPara.append(iniPara, nomePara);

    rota.append(pessoaDe, caminho, pessoaPara);
    lista.appendChild(rota);
  });
}

/* ===================================================
   FILTRO DE MÊS
   =================================================== */
function popularFiltroMes() {
  const select = document.getElementById('filtro-mes');
  const valorAtual = select.value;

  const meses = [...new Set(corridas.map(c => c.data.slice(0, 7)))]
    .sort()
    .reverse();

  select.innerHTML = '<option value="">Todos os meses</option>';
  meses.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = formatarNomeMes(m);
    select.appendChild(opt);
  });

  if (meses.includes(valorAtual)) select.value = valorAtual;
}

/* ===================================================
   TAG DE PESSOA (na tabela)
   =================================================== */
function criarTagPessoa(pessoa) {
  const tag = document.createElement('span');
  tag.className = 'pessoa-tag';

  const ini = document.createElement('span');
  ini.className = 'pessoa-tag__inicial';
  ini.style.background = pessoa.cor;
  ini.textContent = pessoa.nome[0].toUpperCase();

  const txt = document.createElement('span');
  txt.textContent = pessoa.nome;

  tag.append(ini, txt);
  return tag;
}

/* ===================================================
   RENDERIZAR HISTÓRICO
   =================================================== */
function renderizarHistorico(filtroMes) {
  const tbody = document.getElementById('corpo-historico');
  tbody.innerHTML = '';

  const lista = filtroMes
    ? corridas.filter(c => c.data.startsWith(filtroMes))
    : corridas;

  if (!dadosCarregados) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    const carregando = document.createElement('div');
    carregando.className = 'estado-vazio';
    carregando.innerHTML = '<span class="estado-vazio__icone">⏳</span>Carregando corridas…';
    td.appendChild(carregando);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  if (lista.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    const vazio = document.createElement('div');
    vazio.className = 'estado-vazio';
    vazio.setAttribute('data-test', 'historico-vazio');
    vazio.innerHTML =
      '<span class="estado-vazio__icone">🚗</span>' +
      (filtroMes
        ? 'Nenhuma corrida neste mês.'
        : 'Nenhuma corrida registrada ainda.<br>Adicione a primeira acima!');
    td.appendChild(vazio);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  lista.forEach((c, idx) => {
    const pagador   = pessoaPorId(c.pagador);
    const porPessoa = arredondar(c.valor / c.participantes.length);

    const tr = document.createElement('tr');
    tr.setAttribute('data-test', `row-historico-${idx}`);
    tr.setAttribute('data-corrida-id', c.id);

    // data
    const tdData = document.createElement('td');
    tdData.className = 'td-mono';
    tdData.setAttribute('data-test', `cell-data-${c.id}`);
    tdData.setAttribute('data-label', 'Data');
    tdData.textContent = formatarData(c.data);

    // pagador
    const tdPag = document.createElement('td');
    tdPag.setAttribute('data-test', `cell-pagador-${c.id}`);
    tdPag.setAttribute('data-label', 'Pagador');
    if (pagador) tdPag.appendChild(criarTagPessoa(pagador));

    // valor total
    const tdValor = document.createElement('td');
    tdValor.className = 'td-direita';
    tdValor.setAttribute('data-test', `cell-valor-${c.id}`);
    tdValor.setAttribute('data-label', 'Valor');
    tdValor.textContent = formatarMoeda(c.valor);

    // participantes
    const tdPart = document.createElement('td');
    tdPart.setAttribute('data-test', `cell-participantes-${c.id}`);
    tdPart.setAttribute('data-label', 'Participantes');
    const wrap = document.createElement('div');
    wrap.className = 'td-participantes';
    c.participantes.forEach(id => {
      const p = pessoaPorId(id);
      if (p) wrap.appendChild(criarTagPessoa(p));
    });
    tdPart.appendChild(wrap);

    // por pessoa
    const tdPP = document.createElement('td');
    tdPP.className = 'td-direita';
    tdPP.setAttribute('data-test', `cell-por-pessoa-${c.id}`);
    tdPP.setAttribute('data-label', 'Por pessoa');
    tdPP.textContent = formatarMoeda(porPessoa);

    // excluir
    const tdAcao = document.createElement('td');
    tdAcao.className = 'td-centro';
    tdAcao.setAttribute('data-label', 'Ação');
    const btnDel = document.createElement('button');
    btnDel.className = 'botao-icone';
    btnDel.setAttribute('data-test', `btn-deletar-${c.id}`);
    btnDel.setAttribute('aria-label',
      `Excluir corrida de ${formatarData(c.data)} — ${formatarMoeda(c.valor)}`);
    btnDel.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>`;
    btnDel.addEventListener('click', () => {
      if (!confirm(`Excluir a corrida de ${formatarData(c.data)} (${formatarMoeda(c.valor)})?`)) return;
      if (!firebaseConfigOk) return mostrarToast('⚠️ Firebase não configurado.');
      dbRefCorridas.child(c._key).remove()
        .then(() => mostrarToast('🗑️ Corrida removida.'))
        .catch(() => mostrarToast('⚠️ Não foi possível excluir. Tente novamente.'));
      // a tela é atualizada sozinha pelo listener do Firebase (dbRefCorridas.on)
    });
    tdAcao.appendChild(btnDel);

    tr.append(tdData, tdPag, tdValor, tdPart, tdPP, tdAcao);
    tbody.appendChild(tr);
  });
}

/* ===================================================
   EXPORTAR / IMPORTAR / LIMPAR
   =================================================== */
function inicializarDados() {
  // exportar
  document.getElementById('btn-exportar').addEventListener('click', () => {
    if (corridas.length === 0) return mostrarToast('⚠️ Nenhuma corrida para exportar.');
    const blob = new Blob([JSON.stringify(corridas, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rachometro-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    mostrarToast('📦 Dados exportados!');
  });

  // importar
  document.getElementById('btn-importar').addEventListener('click', () => {
    document.getElementById('input-importar').click();
  });

  document.getElementById('input-importar').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const novos = JSON.parse(ev.target.result);
        if (!Array.isArray(novos)) throw new Error('formato inválido');
        if (!firebaseConfigOk) return mostrarToast('⚠️ Firebase não configurado.');

        const idsExistentes = new Set(corridas.map(c => c.id));
        const paraAdd = novos.filter(c => c.id && !idsExistentes.has(c.id));

        Promise.all(paraAdd.map(c => dbRefCorridas.push(c)))
          .then(() => mostrarToast(`✅ ${paraAdd.length} corrida(s) importada(s)!`))
          .catch(() => mostrarToast('⚠️ Erro ao importar. Tente novamente.'));
        // a tela é atualizada sozinha pelo listener do Firebase (dbRefCorridas.on)
      } catch {
        mostrarToast('❌ Arquivo inválido. Use um JSON exportado pelo Rachadinha.');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // permite reimportar o mesmo arquivo
  });

  // limpar tudo
  document.getElementById('btn-limpar').addEventListener('click', () => {
    if (!confirm('Apagar TODAS as corridas — do Mateus, Sorriso e Caio? Essa ação não pode ser desfeita.')) return;
    if (!firebaseConfigOk) return mostrarToast('⚠️ Firebase não configurado.');
    dbRefCorridas.remove()
      .then(() => mostrarToast('🗑️ Todos os dados foram apagados.'))
      .catch(() => mostrarToast('⚠️ Não foi possível apagar. Tente novamente.'));
    // a tela é atualizada sozinha pelo listener do Firebase (dbRefCorridas.on)
  });
}

/* ===================================================
   RENDER GERAL — chama tudo junto
   =================================================== */
function renderizarTudo() {
  const saldos  = calcularSaldos();
  const acertos = calcularAcertos();
  const filtroMes = document.getElementById('filtro-mes').value;

  renderizarSaldos(saldos);
  renderizarAcertos(acertos);
  popularFiltroMes();
  renderizarHistorico(filtroMes);
}

/* ===================================================
   INIT
   =================================================== */
function init() {
  renderizarChips();
  inicializarForm();
  inicializarDados();

  document.getElementById('filtro-mes')
    .addEventListener('change', e => renderizarHistorico(e.target.value));

  inicializarFirebase(); // renderizarTudo() é chamado quando os dados chegarem
}

document.addEventListener('DOMContentLoaded', init);
