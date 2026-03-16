// ==UserScript==
// @name         Central de Guias
// @namespace    projudi-central-guias.user.js
// @version      2.0
// @icon         https://img.icons8.com/ios-filled/100/scales--v1.png
// @description  Central local para sincronizar, acompanhar e alertar sobre guias de pagamento no Projudi.
// @author       lourencosv (GPT)
// @license      CC BY-NC 4.0
// @updateURL    https://gist.githubusercontent.com/lourencosv/b62f6a7595e1c6a4f6ce0441bbdc3a46/raw/projudi-central-guias.user.js
// @downloadURL  https://gist.githubusercontent.com/lourencosv/b62f6a7595e1c6a4f6ce0441bbdc3a46/raw/projudi-central-guias.user.js
// @match        *://projudi.tjgo.jus.br/*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

(function () {
  'use strict';

  const INSTANCE_KEY = '__projudi_central_guias_instance__';
  if (window[INSTANCE_KEY] && typeof window[INSTANCE_KEY].destroy === 'function') {
    try { window[INSTANCE_KEY].destroy(); } catch (_) {}
  }

  const STORAGE_KEY = 'projudi_guides_central::db';
  const SCRIPT_META = (() => {
    const fallbackName = 'Central de Guias';
    const fallbackId = 'projudi-central-guias';
    try {
      const script = GM_info && GM_info.script ? GM_info.script : {};
      const name = String(script.name || fallbackName).trim() || fallbackName;
      const namespace = String(script.namespace || '').trim();
      const version = String(script.version || 'unknown').trim() || 'unknown';
      const base = (namespace || name || fallbackId)
        .replace(/\.user\.js$/i, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      const id = base || fallbackId;
      return { name, version, id, fileName: `${id}.json` };
    } catch (_) {
      return { name: fallbackName, version: 'unknown', id: fallbackId, fileName: `${fallbackId}.json` };
    }
  })();
  const BACKUP_KEY = 'projudi_guides_central::backup';
  const MENU_LABEL = 'Gerenciar Central de Guias';
  const BACKUP_SCHEMA = 'projudi-central-guias-backup-v1';
  const DEFAULT_BACKUP_SETTINGS = {
    enabled: false,
    gistId: '',
    token: '',
    fileName: SCRIPT_META.fileName,
    autoBackupOnSave: false
  };
  const UI_Z = 2147483200;
  const ALERT_BUSINESS_DAYS = 7;
  const STALE_SYNC_DAYS = 10;
  const WEEK_DAYS = 7;
  const HOME_TABLE_LIMIT = 8;
  const CNJ_REGEX = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;
  const SHORT_PROC_REGEX = /\b\d{7}-\d{2}\b/;
  const MSG_OPEN_MANAGER = 'pj-guides-open-manager';

  const state = {
    menuId: null,
    styleMounted: false,
    timer: null,
    homeMounted: false,
    processMounted: false,
    guidesMounted: false,
    guideSyncSignature: null,
    cleanupFns: [],
    alertsShown: new Set(),
    wasHomePage: false,
    homeAlertShown: false,
    backupTimer: null
  };

  const storage = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      } catch (_) {}
      try {
        const raw = localStorage.getItem(key);
        if (raw === null || typeof raw === 'undefined') return fallback;
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') return GM_setValue(key, value);
      } catch (_) {}
      localStorage.setItem(key, JSON.stringify(value));
    }
  };

  function normalizeBackupSettings(value) {
    const next = { ...DEFAULT_BACKUP_SETTINGS, ...(value || {}) };
    next.enabled = !!next.enabled;
    next.gistId = String(next.gistId || '').trim();
    next.token = String(next.token || '').trim();
    next.fileName = String(next.fileName || SCRIPT_META.fileName).trim() || SCRIPT_META.fileName;
    next.autoBackupOnSave = !!next.autoBackupOnSave;
    return next;
  }

  function loadBackupSettings() {
    return normalizeBackupSettings(storage.get(BACKUP_KEY, DEFAULT_BACKUP_SETTINGS));
  }

  function saveBackupSettings(next) {
    const normalized = normalizeBackupSettings(next);
    storage.set(BACKUP_KEY, normalized);
    return normalized;
  }

  function buildBackupPayload() {
    return {
      schema: BACKUP_SCHEMA,
      scriptId: SCRIPT_META.id,
      scriptName: SCRIPT_META.name,
      version: SCRIPT_META.version,
      exportedAt: nowIso(),
      host: location.host,
      db: loadDb()
    };
  }

  function applyBackupPayload(payload) {
    const db = payload && typeof payload === 'object' && payload.db && typeof payload.db === 'object' ? payload.db : payload;
    saveDb(normalizeDb(db));
  }

  function githubRequest(options) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest indisponível.'));
        return;
      }
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: options.url,
        headers: options.headers || {},
        data: options.data,
        onload: resolve,
        onerror: () => reject(new Error('Falha de rede ao acessar o GitHub.')),
        ontimeout: () => reject(new Error('Tempo esgotado ao acessar o GitHub.'))
      });
    });
  }

  function parseGithubError(response) {
    try {
      const parsed = JSON.parse(response.responseText || '{}');
      if (parsed && parsed.message) return parsed.message;
    } catch (_) {}
    return `GitHub respondeu com status ${response.status}.`;
  }

  async function pushBackupToGist(backupSettings, payload) {
    if (!backupSettings.gistId) throw new Error('Informe o Gist ID.');
    if (!backupSettings.token) throw new Error('Informe o token do GitHub.');
    const response = await githubRequest({
      method: 'PATCH',
      url: `https://api.github.com/gists/${encodeURIComponent(backupSettings.gistId)}`,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${backupSettings.token}`,
        'Content-Type': 'application/json'
      },
      data: JSON.stringify({ files: { [backupSettings.fileName]: { content: JSON.stringify(payload, null, 2) } } })
    });
    if (response.status < 200 || response.status >= 300) throw new Error(parseGithubError(response));
  }

  async function readBackupFromGist(backupSettings) {
    if (!backupSettings.gistId) throw new Error('Informe o Gist ID.');
    if (!backupSettings.token) throw new Error('Informe o token do GitHub.');
    const response = await githubRequest({
      method: 'GET',
      url: `https://api.github.com/gists/${encodeURIComponent(backupSettings.gistId)}`,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${backupSettings.token}`
      }
    });
    if (response.status < 200 || response.status >= 300) throw new Error(parseGithubError(response));
    const gist = JSON.parse(response.responseText || '{}');
    const file = gist && gist.files ? gist.files[backupSettings.fileName] : null;
    if (!file || !file.content) throw new Error('Arquivo de backup não encontrado no Gist.');
    return JSON.parse(file.content);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function addDays(base, amount) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + amount);
    return d;
  }

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  function addBusinessDays(base, amount) {
    const d = stripTime(base);
    let remaining = Math.max(0, amount | 0);
    while (remaining > 0) {
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      d.setTime(next.getTime());
      if (isWeekend(d)) continue;
      remaining -= 1;
    }
    return new Date(d);
  }

  function diffInDays(target, base) {
    const ms = 24 * 60 * 60 * 1000;
    return Math.floor((stripTime(target) - stripTime(base)) / ms);
  }

  function stripTime(date) {
    const d = new Date(date.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parsePtDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = match;
    const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(dateLike) {
    if (!dateLike) return '--';
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleDateString('pt-BR');
  }

  function formatDateTime(dateLike) {
    if (!dateLike) return '--';
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDateTimeSingleLine(dateLike) {
    const value = formatDateTime(dateLike);
    return value === '--' ? value : value.replace(', ', ' ');
  }

  function textOf(node) {
    return String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function htmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function loadDb() {
    const raw = storage.get(STORAGE_KEY, null);
    const next = raw && typeof raw === 'object' ? raw : {};
    const processes = next.processes && typeof next.processes === 'object' ? next.processes : {};
    return { version: 1, processes };
  }

  function saveDb(db) {
    storage.set(STORAGE_KEY, db);
    scheduleAutoBackup();
  }

  function scheduleAutoBackup() {
    clearTimeout(state.backupTimer);
    state.backupTimer = null;
    const backupSettings = loadBackupSettings();
    if (!backupSettings.enabled || !backupSettings.autoBackupOnSave) return;
    state.backupTimer = setTimeout(async () => {
      state.backupTimer = null;
      try {
        await pushBackupToGist(backupSettings, buildBackupPayload());
      } catch (_) {}
    }, 800);
  }

  function normalizeManual(manual) {
    return {
      paid: !!(manual && manual.paid),
      notified: !!(manual && manual.notified),
      ignored: !!(manual && manual.ignored)
    };
  }

  function mergeGuideLists(...lists) {
    const merged = new Map();
    lists.reduce((acc, list) => acc.concat(Array.isArray(list) ? list : []), []).filter(Boolean).forEach(guide => {
      const key = guide.guideId || guide.number || `${guide.rowNumber || ''}:${guide.type || ''}:${guide.dueDate || ''}`;
      const existing = merged.get(key);
      merged.set(key, {
        ...existing,
        ...guide,
        manual: normalizeManual({
          ...(existing && existing.manual),
          ...(guide && guide.manual)
        })
      });
    });
    return Array.from(merged.values());
  }

  function ensureProcessRecord(db, identity) {
    const candidates = [identity.processId, identity.cnj, identity.shortNumber].filter(Boolean);
    const matchedEntries = Object.entries(db.processes || {}).filter(([, proc]) => (
      candidates.some(candidate => (
        candidate &&
        (proc.processId === candidate || proc.cnj === candidate || proc.shortNumber === candidate || proc.key === candidate)
      ))
    ));
    const key = identity.processId
      || (matchedEntries.find(([, proc]) => proc.processId)?.[0])
      || identity.cnj
      || (matchedEntries.find(([, proc]) => proc.cnj)?.[0])
      || identity.shortNumber
      || (matchedEntries[0] && matchedEntries[0][0])
      || '';
    if (!key) return null;
    const existing = matchedEntries.reduce((acc, [, proc]) => ({
      ...acc,
      ...proc,
      manual: undefined,
      guides: mergeGuideLists(acc.guides || [], proc.guides || [])
    }), db.processes[key] || {});
    const normalized = {
      key,
      processId: identity.processId || existing.processId || '',
      cnj: identity.cnj || existing.cnj || '',
      shortNumber: identity.shortNumber || existing.shortNumber || '',
      area: identity.area || existing.area || '',
      serventia: identity.serventia || existing.serventia || '',
      classe: identity.classe || existing.classe || '',
      assunto: identity.assunto || existing.assunto || '',
      processUrl: identity.processUrl || existing.processUrl || '',
      lastProcessSeenAt: identity.lastProcessSeenAt || existing.lastProcessSeenAt || '',
      lastGuidesSyncAt: existing.lastGuidesSyncAt || '',
      lastGuidesSyncSource: existing.lastGuidesSyncSource || '',
      guides: Array.isArray(existing.guides) ? existing.guides.map(g => ({
        ...g,
        manual: normalizeManual(g.manual)
      })) : []
    };
    matchedEntries.forEach(([matchedKey]) => {
      if (matchedKey !== key) delete db.processes[matchedKey];
    });
    db.processes[key] = normalized;
    return normalized;
  }

  function findProcessRecord(db, matcher) {
    const values = Object.values(db.processes || {});
    return values.find(proc => (
      (matcher.processId && proc.processId === matcher.processId) ||
      (matcher.cnj && proc.cnj === matcher.cnj) ||
      (matcher.shortNumber && proc.shortNumber === matcher.shortNumber)
    )) || null;
  }

  function getQueryParam(name, url = location.href) {
    try {
      return new URL(url, location.origin).searchParams.get(name) || '';
    } catch (_) {
      return '';
    }
  }

  function buildProcessLookupUrl(identity) {
    if (!identity) return '';
    const processNumber = identity.shortNumber || identity.cnj || '';
    if (processNumber) {
      return `BuscaProcesso?PaginaAtual=2&TipoConsultaProcesso=24&ProcessoNumero=${encodeURIComponent(processNumber)}`;
    }
    if (identity.processId) {
      return `BuscaProcesso?Id_Processo=${encodeURIComponent(identity.processId)}`;
    }
    return identity.processUrl || '';
  }

  function getProcessOpenUrl(processRecord) {
    return buildProcessLookupUrl(processRecord);
  }

  function extractProcessPageContext(doc = document) {
    const cnjEl = doc.querySelector('#span_proc_numero');
    const table = doc.querySelector('#TabelaArquivos');
    if (!cnjEl || !table) return null;
    const cnj = textOf(cnjEl).match(CNJ_REGEX)?.[0] || textOf(cnjEl);
    const shortNumber = cnj.split('.').shift() || cnj;
    const processId = getQueryParam('Id_Processo', location.href);
    const bolds = Array.from(doc.querySelectorAll('.aEsquerda .bold')).map(textOf).filter(Boolean);
    const area = bolds.find(item => item !== cnj) || '';
    const infoFieldset = Array.from(doc.querySelectorAll('fieldset.VisualizaDados.field_processo'))
      .find(fs => /Outras Informações/i.test(textOf(fs.querySelector('legend'))));
    const infoText = infoFieldset ? infoFieldset.innerText : '';
    const serventia = matchInlineField(infoText, 'Serventia');
    const classe = matchInlineField(infoText, 'Classe');
    const assunto = matchInlineField(infoText, 'Assunto(s)');
    return {
      processId,
      cnj,
      shortNumber,
      area,
      serventia,
      classe,
      assunto,
      processUrl: processId ? `BuscaProcesso?Id_Processo=${encodeURIComponent(processId)}` : '',
      lastProcessSeenAt: nowIso()
    };
  }

  function matchInlineField(text, label) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    const regex = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.*?)(?=(Serventia|Classe|Assunto\\(s\\)|Valor da Causa|Valor Condenação|Processo Originário|Fase Processual|Dt\\. Distribuição|Segredo de Justiça|Status|Prioridade|Efeito Suspensivo|Julgado 2º Grau|Custas|Penhora no Rosto)\\s|$)`, 'i');
    const match = source.match(regex);
    return match ? match[1].trim() : '';
  }

  function isGuidesPage(doc = document) {
    return !!(doc.querySelector('form#ProcessoGuias') && doc.querySelector('#Tabela') && doc.querySelector('#numeroProcesso'));
  }

  function extractGuidesPageContext(doc = document, db = loadDb()) {
    if (!isGuidesPage(doc)) return null;
    const processLink = doc.querySelector('#numeroProcesso');
    const shortNumber = textOf(processLink).match(SHORT_PROC_REGEX)?.[0] || textOf(processLink);
    const href = processLink ? processLink.getAttribute('href') || '' : '';
    const processId = getQueryParam('Id_Processo', href);
    const known = findProcessRecord(db, { processId, shortNumber });
    return {
      processId: processId || (known && known.processId) || '',
      cnj: known && known.cnj || '',
      shortNumber: shortNumber || (known && known.shortNumber) || '',
      processUrl: href || (known && known.processUrl) || '',
      title: textOf(doc.querySelector('.area h2'))
    };
  }

  function parseInstallment(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return { text: '', number: null, total: null };
    const match = cleaned.match(/Parcela\s+(\d+)\s+de\s+(\d+)/i);
    return {
      text: cleaned,
      number: match ? Number(match[1]) : null,
      total: match ? Number(match[2]) : null
    };
  }

  function parseGuideRows(doc = document, processRecord = null) {
    const rows = Array.from(doc.querySelectorAll('#Tabela tbody tr'));
    const prevGuides = new Map((processRecord && processRecord.guides || []).map(guide => [guide.guideId || guide.number, guide]));
    return rows.map((row, index) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 10) return null;
      const link = cells[1].querySelector('a');
      const href = link ? link.getAttribute('href') || '' : '';
      const installment = parseInstallment(textOf(cells[9]));
      const previous = prevGuides.get(getQueryParam('Id_GuiaEmissao', href) || textOf(cells[1])) || null;
      return {
        rowNumber: index + 1,
        guideId: getQueryParam('Id_GuiaEmissao', href),
        number: textOf(cells[1]),
        type: textOf(cells[2]),
        issueDate: parsePtDate(textOf(cells[3]))?.toISOString() || '',
        dueDate: parsePtDate(textOf(cells[4]))?.toISOString() || '',
        receivedDate: parsePtDate(textOf(cells[5]))?.toISOString() || '',
        canceledDate: parsePtDate(textOf(cells[6]))?.toISOString() || '',
        situation: textOf(cells[7]),
        nature: textOf(cells[8]),
        installmentText: installment.text,
        installmentNumber: installment.number,
        installmentTotal: installment.total,
        detailUrl: href,
        manual: normalizeManual(previous && previous.manual),
        lastSeenAt: nowIso()
      };
    }).filter(Boolean);
  }

  function computeGuideStatus(guide, baseDate = startOfToday()) {
    const manual = normalizeManual(guide.manual);
    const due = guide.dueDate ? new Date(guide.dueDate) : null;
    const hasReceived = !!guide.receivedDate;
    const hasCanceled = !!guide.canceledDate;
    const situation = String(guide.situation || '').toUpperCase();

    if (manual.ignored) return 'ignored';
    if (manual.paid) return 'paid_manual';
    if (hasReceived) return 'paid';
    if (hasCanceled) return 'canceled';
    if (situation.includes('BAIXADA COM GRATUIDADE')) return 'gratuidade';
    if (situation.includes('PARCELAMENTO PAGO')) return 'parcelamento_pago';
    if (situation.includes('PARCELAMENTO REALIZADO')) return 'parcelamento_realizado';
    if (!due) return 'open';

    const days = diffInDays(due, baseDate);
    const businessDeadline = addBusinessDays(baseDate, ALERT_BUSINESS_DAYS);
    if (days < 0) return 'overdue';
    if (days === 0) return 'due_today';
    if (stripTime(due) <= businessDeadline) return 'due_soon';
    if (days <= WEEK_DAYS) return 'due_week';
    return 'open';
  }

  function computeProcessSummary(processRecord, baseDate = startOfToday()) {
    const guides = Array.isArray(processRecord.guides) ? processRecord.guides : [];
    const summary = {
      total: guides.length,
      open: 0,
      overdue: 0,
      dueToday: 0,
      dueSoon: 0,
      dueWeek: 0,
      paid: 0,
      canceled: 0,
      ignored: 0,
      notified: 0,
      nearestDueDate: null,
      nearestDueGuide: null,
      staleSync: false,
      neverSynced: !processRecord.lastGuidesSyncAt
    };

    guides.forEach(guide => {
      const status = computeGuideStatus(guide, baseDate);
      const due = guide.dueDate ? new Date(guide.dueDate) : null;
      if (guide.manual && guide.manual.notified) summary.notified += 1;
      if (status === 'overdue') summary.overdue += 1;
      else if (status === 'due_today') summary.dueToday += 1;
      else if (status === 'due_soon') summary.dueSoon += 1;
      else if (status === 'due_week') summary.dueWeek += 1;
      else if (status === 'paid' || status === 'gratuidade' || status === 'paid_manual' || status === 'parcelamento_pago' || status === 'parcelamento_realizado') summary.paid += 1;
      else if (status === 'canceled') summary.canceled += 1;
      else if (status === 'ignored') summary.ignored += 1;
      else summary.open += 1;
      if (['open', 'due_week', 'due_soon', 'due_today', 'overdue'].includes(status)) summary.open += 0;
      if (['overdue', 'due_today', 'due_soon', 'due_week', 'open'].includes(status) && due) {
        if (!summary.nearestDueDate || due < summary.nearestDueDate) {
          summary.nearestDueDate = due;
          summary.nearestDueGuide = guide;
        }
      }
    });

    summary.open = guides.filter(guide => {
      const status = computeGuideStatus(guide, baseDate);
      return ['open', 'due_week', 'due_soon', 'due_today', 'overdue'].includes(status);
    }).length;

    if (processRecord.lastGuidesSyncAt) {
      const lastSync = new Date(processRecord.lastGuidesSyncAt);
      if (!Number.isNaN(lastSync.getTime())) {
        summary.staleSync = diffInDays(baseDate, lastSync) >= STALE_SYNC_DAYS;
      }
    }

    return summary;
  }

  function allProcessesSorted(db = loadDb()) {
    return Object.values(db.processes || {})
      .filter(proc => proc && (proc.cnj || proc.shortNumber || proc.processId))
      .sort((a, b) => {
        const ta = new Date(a.lastGuidesSyncAt || a.lastProcessSeenAt || 0).getTime();
        const tb = new Date(b.lastGuidesSyncAt || b.lastProcessSeenAt || 0).getTime();
        return tb - ta;
      });
  }

  function allCriticalGuides(db = loadDb(), baseDate = startOfToday()) {
    const rows = [];
    allProcessesSorted(db).forEach(processRecord => {
      processRecord.guides.forEach(guide => {
        const status = computeGuideStatus(guide, baseDate);
        if (!['overdue', 'due_today', 'due_soon', 'due_week'].includes(status)) return;
        rows.push({ processRecord, guide, status });
      });
    });
    rows.sort((a, b) => {
      const da = a.guide.dueDate ? new Date(a.guide.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const dbb = b.guide.dueDate ? new Date(b.guide.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return da - dbb;
    });
    return rows;
  }

  function navigateToUrl(url) {
    if (!url) return;
    const topDoc = getTopDocument();
    const iframe = topDoc.getElementById('Principal');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.location.href = url;
      return;
    }
    location.href = url;
  }

  function getTopDocument() {
    try {
      return window.top && window.top.document ? window.top.document : document;
    } catch (_) {
      return document;
    }
  }

  function getTopWindow() {
    try {
      return window.top || window;
    } catch (_) {
      return window;
    }
  }

  function isTopWindow() {
    return getTopWindow() === window;
  }

  function showToast(message, tone = 'info', options = {}) {
    if (!message) return;
    const timeout = typeof options === 'number' ? options : options.timeout;
    const persistent = !!(options && typeof options === 'object' && options.persistent);
    const doc = document;
    let host = doc.getElementById('pj-guides-toast-host');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'pj-guides-toast-host';
      host.className = 'pj-guides-toast-host';
      doc.body.appendChild(host);
    }
    const el = doc.createElement('div');
    el.className = `pj-guides-toast pj-guides-toast--${tone}`;
    const body = doc.createElement('div');
    body.className = 'pj-guides-toast__body';
    const text = doc.createElement('div');
    text.className = 'pj-guides-toast__text';
    text.textContent = message;
    body.appendChild(text);
    if (persistent) {
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'pj-guides-toast__close';
      closeBtn.title = 'Fechar aviso';
      closeBtn.setAttribute('aria-label', 'Fechar aviso');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => {
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 180);
      });
      body.appendChild(closeBtn);
    }
    el.appendChild(body);
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    if (!persistent) {
      setTimeout(() => {
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 180);
      }, timeout || 4500);
    }
  }

  function ensureStyles() {
    if (state.styleMounted || !document.head) return;
    const style = document.createElement('style');
    style.id = 'pj-guides-style';
    style.textContent = `
      .pj-guides-card,
      .pj-guides-home,
      .pj-guides-inline,
      .pj-guides-manager,
      .pj-guides-toast {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      }
      .pj-guides-inline {
        margin: 12px 0 14px;
        padding: 14px 16px;
        border: 1px solid #d8e3ef;
        border-radius: 12px;
        background: linear-gradient(180deg, #ffffff 0%, #f6f9fc 100%);
        box-shadow: 0 12px 28px rgba(31, 52, 74, .08);
      }
      .pj-guides-inline__header,
      .pj-guides-home__header,
      .pj-guides-manager__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .pj-guides-inline__title,
      .pj-guides-home__title,
      .pj-guides-manager__title {
        font-size: 18px;
        font-weight: 700;
        color: #17365d;
      }
      .pj-guides-inline__meta,
      .pj-guides-home__meta {
        color: #5e7390;
        font-size: 12px;
      }
      .pj-guides-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        gap: 10px;
        margin-bottom: 12px;
      }
      .pj-guides-stat {
        background: #eef4fa;
        border: 1px solid #d8e4ef;
        border-radius: 10px;
        padding: 10px 12px;
      }
      .pj-guides-stat__label {
        display: block;
        color: #60758f;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: .04em;
        margin-bottom: 5px;
      }
      .pj-guides-stat__value {
        font-size: 20px;
        font-weight: 700;
        color: #17365d;
      }
      .pj-guides-inline__actions,
      .pj-guides-home__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
        justify-content: flex-end;
      }
      .pj-guides-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid #b8cbe0;
        border-radius: 999px;
        padding: 8px 12px;
        background: #fff;
        color: #17365d;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .pj-guides-btn:hover {
        background: #edf4fb;
      }
      .pj-guides-btn--primary {
        background: #1f5d97;
        border-color: #1f5d97;
        color: #fff;
      }
      .pj-guides-btn--primary:hover {
        background: #184b79;
        border-color: #184b79;
        color: #fff;
      }
      .pj-guides-btn--danger {
        background: #fff5f5;
        color: #a33131;
        border-color: #efc2c2;
      }
      .pj-guides-btn--warn {
        background: #fff8ea;
        color: #996817;
        border-color: #f1d7a0;
      }
      .pj-guides-btn--icon {
        width: 38px;
        min-width: 38px;
        height: 38px;
        padding: 0;
        font-size: 15px;
      }
      .pj-guides-btn--icon.pj-guides-btn--primary,
      .pj-guides-btn--icon.pj-guides-btn--warn,
      .pj-guides-btn--icon.pj-guides-btn--danger {
        padding: 0;
      }
      .pj-guides-btn--tool {
        width: auto;
        min-width: 0;
        height: auto;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #4d6d94;
        font-size: 34px;
        line-height: 1;
      }
      .pj-guides-btn--tool > i {
        display: block;
        font-size: 2em;
        line-height: 1;
      }
      .pj-guides-btn--tool:hover {
        background: transparent;
        color: #1f5d97;
      }
      .pj-guides-home__actions .pj-guides-btn--tool,
      .pj-guides-inline__actions .pj-guides-btn--tool {
        font-size: 34px;
      }
      .pj-guides-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .pj-guides-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        margin-bottom: 12px;
        border: 1px solid #ead8aa;
        background: #fff7dd;
        color: #6a5517;
      }
      .pj-guides-banner--danger {
        border-color: #efc2c2;
        background: #fff1f1;
        color: #8a2d2d;
      }
      .pj-guides-home {
        margin: 16px 0;
        padding: 16px;
        border: 1px solid #d7e1eb;
        border-radius: 12px;
        background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%);
        box-shadow: 0 10px 24px rgba(31, 52, 74, .08);
      }
      .pj-guides-home__table,
      .pj-guides-manager__table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .pj-guides-home__table th,
      .pj-guides-home__table td,
      .pj-guides-manager__table th,
      .pj-guides-manager__table td {
        padding: 8px 10px;
        border-bottom: 1px solid #e4edf5;
        text-align: left;
        vertical-align: top;
      }
      .pj-guides-home__table th,
      .pj-guides-manager__table th {
        color: #58708d;
        font-weight: 700;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      .pj-guides-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }
      .pj-guides-badge--overdue,
      .pj-guides-badge--due_today { background: #fde5e5; color: #9a2626; }
      .pj-guides-badge--due_soon,
      .pj-guides-badge--due_week { background: #fff1d9; color: #8d5b0a; }
      .pj-guides-badge--paid,
      .pj-guides-badge--gratuidade,
      .pj-guides-badge--paid_manual,
      .pj-guides-badge--parcelamento_pago,
      .pj-guides-badge--parcelamento_realizado { background: #e4f4e4; color: #1e6a33; }
      .pj-guides-badge--canceled,
      .pj-guides-badge--ignored { background: #ebedf0; color: #5a6472; }
      .pj-guides-badge--open { background: #e7f0fb; color: #225791; }
      .pj-guides-manager-overlay {
        position: fixed;
        inset: 0;
        background: rgba(9, 18, 31, .46);
        z-index: ${UI_Z};
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
        backdrop-filter: blur(3px);
      }
      .pj-guides-manager {
        width: min(1240px, calc(100vw - 24px));
        max-height: min(88vh, 900px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        border-radius: 16px;
        background: #fff;
        box-shadow: 0 28px 70px rgba(2, 11, 23, .35);
        border: 1px solid #d6e1eb;
      }
      .pj-guides-manager__header {
        padding: 12px 16px;
        margin-bottom: 0;
        border-bottom: 1px solid #e2eaf1;
        background: linear-gradient(180deg, #1f5d97 0%, #1c527f 100%);
        color: #fff;
      }
      .pj-guides-manager__title { color: #fff; font-size: 17px; }
      .pj-guides-manager__body {
        padding: 12px 18px 18px;
        overflow: auto;
        min-width: 0;
      }
      .pj-guides-manager__body > * {
        min-width: 0;
      }
      .pj-guides-manager__toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 12px;
      }
      .pj-guides-manager__backup {
        margin-bottom: 14px;
        padding: 12px;
        border: 1px solid #d7e3ef;
        border-radius: 12px;
        background: #f8fbff;
        min-width: 0;
        overflow: hidden;
      }
      .pj-guides-manager__backup-title {
        margin: 0 0 4px;
        font-size: 12px;
        font-weight: 700;
        color: #17365d;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      .pj-guides-manager__backup-desc {
        margin: 0 0 10px;
        font-size: 12px;
        color: #5d6f86;
      }
      .pj-guides-manager__backup-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        min-width: 0;
      }
      .pj-guides-manager__backup-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        width: 100%;
      }
      .pj-guides-manager__backup-field label,
      .pj-guides-manager__backup-toggle label {
        font-size: 12px;
        color: #2d4668;
        font-weight: 600;
      }
      .pj-guides-manager__backup-field input {
        width: 100%;
        min-width: 0;
        max-width: 100%;
      }
      .pj-guides-manager__backup-field--full {
        grid-column: auto;
      }
      .pj-guides-manager__backup-row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: 10px;
        margin-top: 10px;
        min-width: 0;
      }
      .pj-guides-manager__backup-toggle {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        flex-wrap: wrap;
        flex: 1 1 100%;
        min-width: 0;
      }
      .pj-guides-manager__backup-toggle label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
      }
      .pj-guides-manager__backup-status {
        flex: 1 1 100%;
        font-size: 12px;
        color: #47627f;
        min-width: 0;
      }
      .pj-guides-manager__backup-row .pj-guides-btn {
        white-space: nowrap;
      }
      .pj-guides-manager__backup-field .pj-guides-input {
        min-width: 0;
        width: 100%;
        max-width: 100%;
      }
      .pj-guides-input,
      .pj-guides-select {
        border: 1px solid #c6d6e6;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        min-width: 180px;
      }
      .pj-guides-manager__table {
        table-layout: fixed;
      }
      .pj-guides-col-process { width: 14%; }
      .pj-guides-col-guide { width: 17%; }
      .pj-guides-col-type { width: 18%; }
      .pj-guides-col-due { width: 9%; }
      .pj-guides-col-status { width: 16%; }
      .pj-guides-col-sync { width: 12%; }
      .pj-guides-col-actions { width: 16%; }
      .pj-guides-process-main {
        display: block;
        font-weight: 700;
        color: #1d3559;
        font-size: 14px;
        line-height: 1.15;
        white-space: nowrap;
      }
      .pj-guides-guide-main {
        display: block;
        color: #1f2f46;
        font-size: 13px;
        line-height: 1.2;
        white-space: nowrap;
      }
      .pj-guides-guide-sub {
        display: block;
        margin-top: 2px;
        color: #5d6f86;
        font-size: 11px;
        line-height: 1.2;
      }
      .pj-guides-guide-type {
        font-size: 13px;
        white-space: nowrap;
        display: inline-block;
        padding-right: 18px;
      }
      .pj-guides-sync {
        white-space: nowrap;
        font-size: 12px;
      }
      .pj-guides-status-cell {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        min-width: 0;
      }
      .pj-guides-status-note {
        color: #5d6f86;
        font-size: 11px;
        line-height: 1.2;
      }
      .pj-guides-manager__empty {
        padding: 18px;
        border: 1px dashed #cfdbe8;
        border-radius: 12px;
        color: #647990;
        background: #f7fbff;
      }
      .pj-guides-close-btn {
        width: 30px;
        height: 30px;
        min-width: 30px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: rgba(255,255,255,.2);
        color: #fff;
        font-size: 16px;
        font-weight: 700;
        line-height: 1;
      }
      .pj-guides-close-btn:hover {
        background: rgba(255,255,255,.28);
      }
      .pj-guides-row-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        justify-content: flex-end;
      }
      .pj-guides-manager .pj-guides-btn {
        padding: 7px 10px;
        font-size: 11px;
        text-align: center;
      }
      .pj-guides-manager .pj-guides-btn--icon {
        padding: 0;
        width: 32px;
        min-width: 32px;
        height: 32px;
        font-size: 13px;
      }
      .pj-guides-header-menu a {
        color: #484848;
        text-decoration: none;
        display: block;
        margin-left: 3px;
        margin-right: 3px;
        padding: 1px 3px;
        font-weight: bold;
      }
      .pj-guides-header-menu a:hover {
        background-color: #eee !important;
        color: #333 !important;
      }
      .pj-guides-toast-host {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: ${UI_Z + 5};
      }
      .pj-guides-toast {
        min-width: 260px;
        max-width: 420px;
        border-radius: 12px;
        padding: 12px 14px;
        color: #fff;
        box-shadow: 0 18px 36px rgba(8, 17, 28, .25);
        transform: translateY(6px);
        opacity: 0;
        transition: opacity .18s ease, transform .18s ease;
      }
      .pj-guides-toast.is-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .pj-guides-toast__body {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .pj-guides-toast__text {
        flex: 1 1 auto;
      }
      .pj-guides-toast__close {
        border: 0;
        width: 22px;
        height: 22px;
        min-width: 22px;
        padding: 0;
        border-radius: 999px;
        background: rgba(255,255,255,.18);
        color: #fff;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
      }
      .pj-guides-toast__close:hover {
        background: rgba(255,255,255,.28);
      }
      .pj-guides-toast--info { background: #1f5d97; }
      .pj-guides-toast--success { background: #23703b; }
      .pj-guides-toast--warn { background: #9a6613; }
      .pj-guides-toast--danger { background: #9b2e2e; }
    `;
    document.head.appendChild(style);
    state.styleMounted = true;
  }

  function clearDynamicUi() {
    ['pj-guides-home-panel', 'pj-guides-process-card', 'pj-guides-guide-card'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  function registerMenu() {
    if (!isTopWindow()) return;
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (state.menuId && typeof GM_unregisterMenuCommand === 'function') {
      try { GM_unregisterMenuCommand(state.menuId); } catch (_) {}
    }
    try {
      state.menuId = GM_registerMenuCommand(MENU_LABEL, openManager);
    } catch (_) {}
  }

  function getStatusLabel(status) {
    return {
      overdue: 'Vencida',
      due_today: 'Vence hoje',
      due_soon: 'Vence em breve',
      due_week: 'Vence na semana',
      paid: 'Paga',
      gratuidade: 'Baixada com gratuidade',
      paid_manual: 'Marcada como paga',
      parcelamento_pago: 'Parcelamento pago',
      canceled: 'Cancelada',
      ignored: 'Ignorada',
      parcelamento_realizado: 'Parcelamento realizado',
      open: 'Em aberto'
    }[status] || 'Em aberto';
  }

  function buildSummaryStats(summary, labels = {}) {
    return `
      <div class="pj-guides-stats">
        <div class="pj-guides-stat"><span class="pj-guides-stat__label">${htmlEscape(labels.open || 'Em aberto')}</span><span class="pj-guides-stat__value">${summary.open}</span></div>
        <div class="pj-guides-stat"><span class="pj-guides-stat__label">${htmlEscape(labels.overdue || 'Vencidas')}</span><span class="pj-guides-stat__value">${summary.overdue}</span></div>
        <div class="pj-guides-stat"><span class="pj-guides-stat__label">${htmlEscape(labels.soon || 'Próximos vencimentos')}</span><span class="pj-guides-stat__value">${summary.dueToday + summary.dueSoon}</span></div>
        <div class="pj-guides-stat"><span class="pj-guides-stat__label">${htmlEscape(labels.extra || 'Avisadas')}</span><span class="pj-guides-stat__value">${summary.notified}</span></div>
      </div>
    `;
  }

  function createIconButton(iconClass, label, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i class="${iconClass}" aria-hidden="true"></i><span class="pj-guides-sr-only">${htmlEscape(label)}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function getCompactInstallmentText(guide) {
    if (guide.installmentNumber && guide.installmentTotal) {
      return `Parcela ${guide.installmentNumber} de ${guide.installmentTotal}`;
    }
    return guide.installmentText || '';
  }

  function maybeAlertForProcess(processRecord, summary) {
    if (!processRecord) return;
    const signature = `${processRecord.key}:${summary.overdue}:${summary.dueToday}:${summary.dueSoon}:${summary.nearestDueDate ? summary.nearestDueDate.toISOString() : ''}`;
    if (state.alertsShown.has(signature)) return;
    let message = '';
    let tone = 'info';
    if (summary.overdue > 0) {
      message = `${processRecord.shortNumber || processRecord.cnj}: ${summary.overdue} guia(s) vencida(s).`;
      tone = 'danger';
    } else if (summary.dueToday + summary.dueSoon > 0) {
      message = `${processRecord.shortNumber || processRecord.cnj}: ${summary.dueToday + summary.dueSoon} guia(s) vencem até ${formatDate(summary.nearestDueDate)}.`;
      tone = 'warn';
    }
    if (!message) return;
    state.alertsShown.add(signature);
    showToast(message, tone, { timeout: 6500 });
  }

  function maybeAlertForHome(signature, message, tone) {
    if (!message) return;
    if (state.homeAlertShown) return;
    state.homeAlertShown = true;
    showToast(message, tone, { persistent: true });
  }

  function mountProcessCard() {
    const ctx = extractProcessPageContext(document);
    if (!ctx) return;
    const db = loadDb();
    const processRecord = ensureProcessRecord(db, ctx);
    saveDb(db);
    const summary = computeProcessSummary(processRecord);

    const anchor = document.querySelector('#divEditar > fieldset.VisualizaDados') || document.querySelector('#divEditar');
    if (!anchor || document.getElementById('pj-guides-process-card')) return;

    const card = document.createElement('div');
    card.id = 'pj-guides-process-card';
    card.className = 'pj-guides-inline';

    const staleText = summary.neverSynced
      ? 'Guias ainda não sincronizadas.'
      : summary.staleSync
        ? `Última sincronização em ${formatDateTime(processRecord.lastGuidesSyncAt)}.`
        : `Última sincronização em ${formatDateTime(processRecord.lastGuidesSyncAt)}.`;

    card.innerHTML = `
      <div class="pj-guides-inline__header">
        <div>
          <div class="pj-guides-inline__title">Central de Guias</div>
          <div class="pj-guides-inline__meta">${htmlEscape(staleText)}</div>
        </div>
      </div>
      ${buildSummaryStats(summary)}
      ${summary.overdue > 0 ? `<div class="pj-guides-banner pj-guides-banner--danger">Existem ${summary.overdue} guia(s) vencida(s) neste processo.</div>` : ''}
      ${summary.dueToday + summary.dueSoon > 0 ? `<div class="pj-guides-banner">${summary.dueToday + summary.dueSoon} guia(s) vencem em até ${ALERT_BUSINESS_DAYS} dias úteis.</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'pj-guides-inline__actions';
    actions.appendChild(createIconButton('fa-solid fa-folder-open', 'Abrir Consultar Guias', 'pj-guides-btn pj-guides-btn--tool', () => navigateToUrl('GuiaEmissao?PaginaAtual=6')));
    actions.appendChild(createIconButton('fa-solid fa-table-columns', 'Abrir Painel', 'pj-guides-btn pj-guides-btn--tool', () => openManager(processRecord.key)));
    card.appendChild(actions);

    anchor.insertAdjacentElement('afterend', card);
    state.processMounted = true;
    maybeAlertForProcess(processRecord, summary);
  }

  function syncGuidesFromPage(options = {}) {
    const db = loadDb();
    const ctx = extractGuidesPageContext(document, db);
    if (!ctx) return null;
    const processRecord = ensureProcessRecord(db, ctx);
    if (!processRecord) return null;
    const guides = parseGuideRows(document, processRecord);
    processRecord.guides = guides;
    processRecord.lastGuidesSyncAt = nowIso();
    processRecord.lastGuidesSyncSource = 'GuiaEmissao?PaginaAtual=6';
    saveDb(db);

    const summary = computeProcessSummary(processRecord);
    if (!options.silent) {
      const tone = summary.overdue > 0 ? 'danger' : (summary.dueToday + summary.dueSoon > 0 ? 'warn' : 'success');
      showToast(`${guides.length} guia(s) sincronizada(s) para ${processRecord.shortNumber || processRecord.cnj}.`, tone, { timeout: 5200 });
    }
    return { processRecord, summary };
  }

  function mountGuidesCard() {
    if (document.getElementById('pj-guides-guide-card')) return;
    const sync = syncGuidesFromPage({ silent: true });
    if (!sync) return;
    const { processRecord, summary } = sync;
    const target = document.querySelector('#divEditar .formEdicao') || document.querySelector('#divEditar');
    if (!target) return;

    const card = document.createElement('div');
    card.id = 'pj-guides-guide-card';
    card.className = 'pj-guides-inline';
    card.innerHTML = `
      <div class="pj-guides-inline__header">
        <div>
          <div class="pj-guides-inline__title">Central de Guias</div>
          <div class="pj-guides-inline__meta">Sincronização local desta página. Última leitura: ${formatDateTime(processRecord.lastGuidesSyncAt)}</div>
        </div>
      </div>
      ${buildSummaryStats(summary)}
      ${summary.overdue > 0 ? `<div class="pj-guides-banner pj-guides-banner--danger">${summary.overdue} guia(s) vencida(s) detectada(s).</div>` : ''}
      ${summary.dueToday + summary.dueSoon > 0 ? `<div class="pj-guides-banner">${summary.dueToday + summary.dueSoon} guia(s) vencem em até ${ALERT_BUSINESS_DAYS} dias úteis.</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'pj-guides-inline__actions';
    actions.appendChild(createIconButton('fa-solid fa-rotate-right', 'Sincronizar agora', 'pj-guides-btn pj-guides-btn--tool', () => {
      const result = syncGuidesFromPage();
      if (!result) return;
      card.remove();
      state.guidesMounted = false;
      mountGuidesCard();
    }));
    actions.appendChild(createIconButton('fa-solid fa-table-columns', 'Abrir painel', 'pj-guides-btn pj-guides-btn--tool', () => openManager(processRecord.key)));
    card.appendChild(actions);

    target.insertAdjacentElement('afterbegin', card);
    state.guidesMounted = true;
  }

  function mountHomePanel() {
    if (document.getElementById('pj-guides-home-panel')) return;
    const area = document.querySelector('.area');
    const firstFieldset = document.querySelector('#divCorpo > fieldset.fieldEdicaoEscuro');
    if (!area || !firstFieldset) return;

    const db = loadDb();
    const processes = allProcessesSorted(db);
    const critical = allCriticalGuides(db).slice(0, HOME_TABLE_LIMIT);
    const counts = processes.reduce((acc, proc) => {
      const summary = computeProcessSummary(proc);
      acc.open += summary.open;
      acc.overdue += summary.overdue;
      acc.dueToday += summary.dueToday;
      acc.dueSoon += summary.dueSoon;
      acc.dueWeek += summary.dueWeek;
      if (summary.open > 0) acc.activeProcesses += 1;
      return acc;
    }, {
      open: 0,
      overdue: 0,
      dueToday: 0,
      dueSoon: 0,
      dueWeek: 0,
      activeProcesses: 0
    });

    const panel = document.createElement('div');
    panel.id = 'pj-guides-home-panel';
    panel.className = 'pj-guides-home';
    panel.innerHTML = `
      <div class="pj-guides-home__header">
        <div>
          <div class="pj-guides-home__title">Central de Guias</div>
          <div class="pj-guides-home__meta">Monitoramento local das guias sincronizadas a partir da página Consultar Guias.</div>
        </div>
      </div>
      ${buildSummaryStats(
        { open: counts.open, overdue: counts.overdue, dueToday: counts.dueToday, dueSoon: counts.dueSoon, notified: counts.activeProcesses },
        { extra: 'Processos ativos' }
      )}
    `;

    const actions = document.createElement('div');
    actions.className = 'pj-guides-home__actions';
    actions.appendChild(createIconButton('fa-solid fa-table-columns', 'Abrir painel completo', 'pj-guides-btn pj-guides-btn--tool', () => openManager()));
    panel.appendChild(actions);

    if (critical.length) {
      const tableWrap = document.createElement('div');
      tableWrap.innerHTML = `
        <table class="pj-guides-home__table">
          <thead>
            <tr>
              <th>Processo</th>
              <th>Guia</th>
              <th>Vencimento</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${critical.map(row => `
              <tr>
                <td><span class="pj-guides-process-main" title="${htmlEscape(row.processRecord.cnj || row.processRecord.shortNumber || row.processRecord.processId)}">${htmlEscape(row.processRecord.shortNumber || row.processRecord.cnj || row.processRecord.processId)}</span></td>
                <td><span class="pj-guides-guide-main">${htmlEscape(row.guide.number)}</span>${getCompactInstallmentText(row.guide) ? `<span class="pj-guides-guide-sub">${htmlEscape(getCompactInstallmentText(row.guide))}</span>` : ''}</td>
                <td>${formatDate(row.guide.dueDate)}</td>
                <td><span class="pj-guides-badge pj-guides-badge--${row.status}">${htmlEscape(getStatusLabel(row.status))}</span></td>
                <td><button type="button" class="pj-guides-btn pj-guides-btn--icon" data-open-process-key="${htmlEscape(row.processRecord.key)}" title="Abrir processo" aria-label="Abrir processo"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="pj-guides-sr-only">Abrir processo</span></button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      tableWrap.querySelectorAll('[data-open-process-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dbForClick = loadDb();
          const processRecord = dbForClick.processes[btn.getAttribute('data-open-process-key')];
          navigateToUrl(getProcessOpenUrl(processRecord));
        });
      });
      panel.appendChild(tableWrap);
    } else {
      const empty = document.createElement('div');
      empty.className = 'pj-guides-manager__empty';
      empty.textContent = 'Nenhuma guia crítica encontrada. As guias só entram aqui depois que você abre “Consultar Guias” no processo.';
      panel.appendChild(empty);
    }

    firstFieldset.insertAdjacentElement('beforebegin', panel);
    state.homeMounted = true;

    if (counts.overdue > 0) {
      maybeAlertForHome(`overdue:${counts.overdue}`, `Existem ${counts.overdue} guia(s) vencida(s) nas guias sincronizadas.`, 'danger');
    } else if (counts.dueToday + counts.dueSoon > 0) {
      maybeAlertForHome(`soon:${counts.dueToday + counts.dueSoon}`, `Existem ${counts.dueToday + counts.dueSoon} guia(s) vencendo em até ${ALERT_BUSINESS_DAYS} dias úteis.`, 'warn');
    }
  }

  function registerHeaderMenuEntry() {
    if (!isTopWindow()) return;
    const topDoc = getTopDocument();
    const menu = topDoc.getElementById('menuPrinciapl');
    if (!menu || topDoc.getElementById('pj-guides-header-menu')) return;
    const ul = topDoc.createElement('ul');
    ul.id = 'pj-guides-header-menu';
    ul.className = 'pj-guides-header-menu';
    const li = topDoc.createElement('li');
    const a = topDoc.createElement('a');
    a.href = '#';
    a.target = '_self';
    a.title = 'Abrir Central de Guias';
    a.textContent = 'Central de Guias';
    a.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openManager();
    });
    li.appendChild(a);
    ul.appendChild(li);

    const certUl = Array.from(menu.children).find(node => {
      const anchor = node.querySelector && node.querySelector('a');
      return anchor && textOf(anchor) === 'Certificados';
    });
    if (certUl && certUl.parentElement === menu) certUl.insertAdjacentElement('afterend', ul);
    else menu.appendChild(ul);
  }

  function statusPriority(status) {
    return {
      overdue: 1,
      due_today: 2,
      due_soon: 3,
      due_week: 4,
      open: 5,
      ignored: 6,
      paid_manual: 7,
      gratuidade: 8,
      paid: 9,
      parcelamento_pago: 10,
      parcelamento_realizado: 11,
      canceled: 12
    }[status] || 50;
  }

  function flattenGuides(db = loadDb()) {
    const rows = [];
    allProcessesSorted(db).forEach(processRecord => {
      processRecord.guides.forEach(guide => {
        rows.push({
          processRecord,
          guide,
          status: computeGuideStatus(guide)
        });
      });
    });
    rows.sort((a, b) => {
      if (a.processRecord.key !== b.processRecord.key) {
        const ta = new Date(a.processRecord.lastGuidesSyncAt || a.processRecord.lastProcessSeenAt || 0).getTime();
        const tb = new Date(b.processRecord.lastGuidesSyncAt || b.processRecord.lastProcessSeenAt || 0).getTime();
        if (tb !== ta) return tb - ta;
        return String(a.processRecord.shortNumber || a.processRecord.cnj || a.processRecord.processId || '')
          .localeCompare(String(b.processRecord.shortNumber || b.processRecord.cnj || b.processRecord.processId || ''), 'pt-BR');
      }
      const rowDiff = (Number(a.guide.rowNumber) || Number.MAX_SAFE_INTEGER) - (Number(b.guide.rowNumber) || Number.MAX_SAFE_INTEGER);
      if (rowDiff !== 0) return rowDiff;
      return String(a.guide.number || '').localeCompare(String(b.guide.number || ''), 'pt-BR');
    });
    return rows;
  }

  function updateGuideManual(processKey, guideIdentifier, patch) {
    const db = loadDb();
    const processRecord = db.processes[processKey];
    if (!processRecord) return;
    const target = processRecord.guides.find(guide => (guide.guideId || guide.number) === guideIdentifier);
    if (!target) return;
    target.manual = { ...normalizeManual(target.manual), ...patch };
    saveDb(db);
  }

  function openManager(focusProcessKey = '') {
    if (!isTopWindow()) {
      getTopWindow().postMessage({ type: MSG_OPEN_MANAGER, focusProcessKey }, '*');
      return;
    }
    ensureStyles();
    const existing = document.getElementById('pj-guides-manager-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pj-guides-manager-overlay';
    overlay.className = 'pj-guides-manager-overlay';

    const panel = document.createElement('div');
    panel.className = 'pj-guides-manager';
    panel.innerHTML = `
      <div class="pj-guides-manager__header">
        <div>
          <div class="pj-guides-manager__title">Central de Guias</div>
          <div class="pj-guides-inline__meta" style="color: rgba(255,255,255,.8)">Painel local para revisar guias abertas, vencidas e próximas do vencimento.</div>
        </div>
        <button type="button" class="pj-guides-btn pj-guides-close-btn" aria-label="Fechar painel">&times;</button>
      </div>
      <div class="pj-guides-manager__body">
        <div class="pj-guides-manager__toolbar">
          <input id="pj-guides-search" class="pj-guides-input" type="text" placeholder="Buscar processo, guia ou situação">
          <select id="pj-guides-filter" class="pj-guides-select">
            <option value="all">Todas</option>
            <option value="overdue">Vencidas</option>
            <option value="due_soon">Próximos</option>
            <option value="due_week">Semana</option>
            <option value="open">Em aberto</option>
            <option value="ignored">Ignoradas</option>
            <option value="paid">Pagas</option>
          </select>
        </div>
        <div class="pj-guides-manager__backup">
          <div class="pj-guides-manager__backup-title">Backup remoto</div>
          <div class="pj-guides-manager__backup-desc">Use um unico Gist no Github e um arquivo separado para este script.</div>
          <div class="pj-guides-manager__backup-grid">
            <div class="pj-guides-manager__backup-field">
              <label for="pj-guides-backup-gist">Gist ID</label>
              <input id="pj-guides-backup-gist" class="pj-guides-input" type="text" placeholder="Cole o Gist ID">
            </div>
            <div class="pj-guides-manager__backup-field">
              <label for="pj-guides-backup-file">Arquivo</label>
              <input id="pj-guides-backup-file" class="pj-guides-input" type="text" placeholder="projudi-central-guias.json">
            </div>
            <div class="pj-guides-manager__backup-field pj-guides-manager__backup-field--full">
              <label for="pj-guides-backup-token">Token do GitHub</label>
              <input id="pj-guides-backup-token" class="pj-guides-input" type="password" placeholder="ghp_...">
            </div>
          </div>
          <div class="pj-guides-manager__backup-row">
            <div class="pj-guides-manager__backup-toggle">
              <label><input id="pj-guides-backup-enabled" type="checkbox"> Ativar backup por Gist no Github.</label>
              <label><input id="pj-guides-backup-auto" type="checkbox"> Backup automatico</label>
            </div>
            <button type="button" id="pj-guides-backup-send" class="pj-guides-btn">Enviar backup</button>
            <button type="button" id="pj-guides-backup-restore" class="pj-guides-btn">Restaurar backup</button>
            <span id="pj-guides-backup-status" class="pj-guides-manager__backup-status"></span>
          </div>
        </div>
        <div id="pj-guides-manager-content"></div>
      </div>
    `;

    const closeBtn = panel.querySelector('.pj-guides-manager__header .pj-guides-btn');
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
    });

    const searchInput = panel.querySelector('#pj-guides-search');
    const filterSelect = panel.querySelector('#pj-guides-filter');
    const content = panel.querySelector('#pj-guides-manager-content');
    const backupEnabled = panel.querySelector('#pj-guides-backup-enabled');
    const backupAuto = panel.querySelector('#pj-guides-backup-auto');
    const backupGist = panel.querySelector('#pj-guides-backup-gist');
    const backupToken = panel.querySelector('#pj-guides-backup-token');
    const backupFile = panel.querySelector('#pj-guides-backup-file');
    const backupSend = panel.querySelector('#pj-guides-backup-send');
    const backupRestore = panel.querySelector('#pj-guides-backup-restore');
    const backupStatus = panel.querySelector('#pj-guides-backup-status');
    const backupSettings = loadBackupSettings();

    backupEnabled.checked = backupSettings.enabled;
    backupAuto.checked = backupSettings.autoBackupOnSave;
    backupGist.value = backupSettings.gistId;
    backupToken.value = backupSettings.token;
    backupFile.value = backupSettings.fileName;

    function setBackupStatus(message, isError) {
      backupStatus.textContent = message || '';
      backupStatus.style.color = isError ? '#b42318' : '#47627f';
    }

    function readBackupSettingsFromPanel() {
      return saveBackupSettings({
        enabled: backupEnabled.checked,
        autoBackupOnSave: backupAuto.checked,
        gistId: backupGist.value,
        token: backupToken.value,
        fileName: backupFile.value
      });
    }

    async function runBackupNow() {
      const nextSettings = readBackupSettingsFromPanel();
      setBackupStatus('Enviando backup...');
      await pushBackupToGist(nextSettings, buildBackupPayload());
      setBackupStatus(`Backup enviado em ${formatDateTimeSingleLine(new Date())}.`);
    }

    backupSend.addEventListener('click', async () => {
      try {
        await runBackupNow();
      } catch (error) {
        setBackupStatus(error && error.message ? error.message : 'Falha ao enviar backup.', true);
      }
    });

    backupRestore.addEventListener('click', async () => {
      try {
        const nextSettings = readBackupSettingsFromPanel();
        setBackupStatus('Restaurando backup...');
        const payload = await readBackupFromGist(nextSettings);
        applyBackupPayload(payload);
        setBackupStatus(`Backup restaurado em ${formatDateTimeSingleLine(new Date())}.`);
        render();
      } catch (error) {
        setBackupStatus(error && error.message ? error.message : 'Falha ao restaurar backup.', true);
      }
    });
    [backupEnabled, backupAuto, backupGist, backupToken, backupFile].forEach(el => {
      const eventName = el && el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        readBackupSettingsFromPanel();
        if (backupStatus.textContent) setBackupStatus('');
      });
    });

    function render() {
      const db = loadDb();
      const rows = flattenGuides(db);
      const term = String(searchInput.value || '').trim().toLowerCase();
      const filter = filterSelect.value;
      const filtered = rows.filter(row => {
        const haystack = [
          row.processRecord.cnj,
          row.processRecord.shortNumber,
          row.processRecord.processId,
          row.guide.number,
          row.guide.type,
          row.guide.situation,
          row.guide.installmentText,
          getStatusLabel(row.status)
        ].join(' ').toLowerCase();
        if (term && !haystack.includes(term)) return false;
        if (filter === 'overdue') return row.status === 'overdue';
        if (filter === 'due_soon') return ['due_today', 'due_soon'].includes(row.status);
        if (filter === 'due_week') return row.status === 'due_week';
        if (filter === 'open') return ['open', 'due_week', 'due_soon', 'due_today', 'overdue'].includes(row.status);
        if (filter === 'ignored') return row.status === 'ignored';
        if (filter === 'paid') return ['paid', 'gratuidade', 'paid_manual', 'parcelamento_pago', 'parcelamento_realizado'].includes(row.status);
        return true;
      });

      if (!filtered.length) {
        content.innerHTML = '<div class="pj-guides-manager__empty">Nenhuma guia encontrada com os filtros atuais.</div>';
        return;
      }

      content.innerHTML = `
        <table class="pj-guides-manager__table">
          <thead>
            <tr>
              <th class="pj-guides-col-process">Processo</th>
              <th class="pj-guides-col-guide">Guia</th>
              <th class="pj-guides-col-type">Tipo</th>
              <th class="pj-guides-col-due">Vencimento</th>
              <th class="pj-guides-col-status">Status</th>
              <th class="pj-guides-col-sync">Última sync</th>
              <th class="pj-guides-col-actions">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(row => {
              const proc = row.processRecord;
              const guide = row.guide;
              const identifier = guide.guideId || guide.number;
              return `
                <tr>
                  <td>
                    <span class="pj-guides-process-main" title="${htmlEscape(proc.cnj || proc.shortNumber || proc.processId)}">${htmlEscape(proc.shortNumber || proc.cnj || proc.processId)}</span>
                  </td>
                  <td>
                    <span class="pj-guides-guide-main">${htmlEscape(guide.number)}</span>
                    ${getCompactInstallmentText(guide) ? `<span class="pj-guides-guide-sub">${htmlEscape(getCompactInstallmentText(guide))}</span>` : ''}
                  </td>
                  <td><span class="pj-guides-guide-type">${htmlEscape(guide.type)}</span></td>
                  <td>${formatDate(guide.dueDate)}</td>
                  <td>
                    <div class="pj-guides-status-cell">
                      <span class="pj-guides-badge pj-guides-badge--${row.status}">${htmlEscape(getStatusLabel(row.status))}</span>
                      ${(guide.manual && guide.manual.notified) ? '<span class="pj-guides-status-note">Cliente avisado</span>' : ''}
                    </div>
                  </td>
                  <td><span class="pj-guides-sync">${formatDateTimeSingleLine(proc.lastGuidesSyncAt)}</span></td>
                  <td>
                    <div class="pj-guides-row-actions">
                      <button type="button" class="pj-guides-btn pj-guides-btn--icon" data-action="paid" data-process-key="${htmlEscape(proc.key)}" data-guide-key="${htmlEscape(identifier)}" title="${htmlEscape(guide.manual && guide.manual.paid ? 'Desfazer pago' : 'Marcar pago')}" aria-label="${htmlEscape(guide.manual && guide.manual.paid ? 'Desfazer pago' : 'Marcar pago')}"><i class="fa-solid ${guide.manual && guide.manual.paid ? 'fa-arrow-rotate-left' : 'fa-circle-check'}" aria-hidden="true"></i><span class="pj-guides-sr-only">${htmlEscape(guide.manual && guide.manual.paid ? 'Desfazer pago' : 'Marcar pago')}</span></button>
                      <button type="button" class="pj-guides-btn pj-guides-btn--icon" data-action="notify" data-process-key="${htmlEscape(proc.key)}" data-guide-key="${htmlEscape(identifier)}" title="${htmlEscape(guide.manual && guide.manual.notified ? 'Desfazer aviso' : 'Marcar aviso')}" aria-label="${htmlEscape(guide.manual && guide.manual.notified ? 'Desfazer aviso' : 'Marcar aviso')}"><i class="fa-solid ${guide.manual && guide.manual.notified ? 'fa-bell-slash' : 'fa-bell'}" aria-hidden="true"></i><span class="pj-guides-sr-only">${htmlEscape(guide.manual && guide.manual.notified ? 'Desfazer aviso' : 'Marcar aviso')}</span></button>
                      <button type="button" class="pj-guides-btn pj-guides-btn--warn pj-guides-btn--icon" data-action="ignore" data-process-key="${htmlEscape(proc.key)}" data-guide-key="${htmlEscape(identifier)}" title="${htmlEscape(guide.manual && guide.manual.ignored ? 'Reativar' : 'Ignorar')}" aria-label="${htmlEscape(guide.manual && guide.manual.ignored ? 'Reativar' : 'Ignorar')}"><i class="fa-solid ${guide.manual && guide.manual.ignored ? 'fa-eye' : 'fa-ban'}" aria-hidden="true"></i><span class="pj-guides-sr-only">${htmlEscape(guide.manual && guide.manual.ignored ? 'Reativar' : 'Ignorar')}</span></button>
                      <button type="button" class="pj-guides-btn pj-guides-btn--icon" data-action="open" data-process-key="${htmlEscape(proc.key)}" title="Abrir processo" aria-label="Abrir processo"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="pj-guides-sr-only">Abrir processo</span></button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;

      content.querySelectorAll('[data-action="open"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dbForClick = loadDb();
          const processRecord = dbForClick.processes[btn.getAttribute('data-process-key')];
          navigateToUrl(getProcessOpenUrl(processRecord));
        });
      });
      content.querySelectorAll('[data-action="paid"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const processKey = btn.getAttribute('data-process-key');
          const guideKey = btn.getAttribute('data-guide-key');
          const current = flattenGuides(loadDb()).find(row => row.processRecord.key === processKey && (row.guide.guideId || row.guide.number) === guideKey);
          updateGuideManual(processKey, guideKey, { paid: !(current && current.guide.manual && current.guide.manual.paid) });
          render();
        });
      });
      content.querySelectorAll('[data-action="notify"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const processKey = btn.getAttribute('data-process-key');
          const guideKey = btn.getAttribute('data-guide-key');
          const current = flattenGuides(loadDb()).find(row => row.processRecord.key === processKey && (row.guide.guideId || row.guide.number) === guideKey);
          updateGuideManual(processKey, guideKey, { notified: !(current && current.guide.manual && current.guide.manual.notified) });
          render();
        });
      });
      content.querySelectorAll('[data-action="ignore"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const processKey = btn.getAttribute('data-process-key');
          const guideKey = btn.getAttribute('data-guide-key');
          const current = flattenGuides(loadDb()).find(row => row.processRecord.key === processKey && (row.guide.guideId || row.guide.number) === guideKey);
          updateGuideManual(processKey, guideKey, { ignored: !(current && current.guide.manual && current.guide.manual.ignored) });
          render();
        });
      });
    }

    searchInput.addEventListener('input', render);
    filterSelect.addEventListener('change', render);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    render();

    if (focusProcessKey) {
      const db = loadDb();
      const processRecord = db.processes[focusProcessKey];
      if (processRecord) {
        searchInput.value = processRecord.shortNumber || processRecord.cnj || processRecord.processId || '';
        render();
      }
    }
  }

  function isHomePage(doc = document) {
    const areaTitle = textOf(doc.querySelector('.area h2'));
    return /Área do Advogado/i.test(areaTitle);
  }

  function onMessage(event) {
    const data = event && event.data;
    if (!data || data.type !== MSG_OPEN_MANAGER) return;
    openManager(data.focusProcessKey || '');
  }

  function scheduleEvaluate(delay = 120) {
    clearTimeout(state.timer);
    state.timer = setTimeout(evaluate, delay);
  }

  function evaluate() {
    ensureStyles();
    clearDynamicUi();
    state.homeMounted = false;
    state.processMounted = false;
    state.guidesMounted = false;
    const homePage = isHomePage(document);
    if (homePage && !state.wasHomePage) state.homeAlertShown = false;
    state.wasHomePage = homePage;

    if (isGuidesPage(document)) {
      mountGuidesCard();
      return;
    }
    if (extractProcessPageContext(document)) {
      mountProcessCard();
      return;
    }
    if (homePage) {
      mountHomePanel();
    }
  }

  function destroy() {
    clearTimeout(state.timer);
    if (isTopWindow()) window.removeEventListener('message', onMessage);
    clearDynamicUi();
    const overlay = document.getElementById('pj-guides-manager-overlay');
    if (overlay) overlay.remove();
    const toastHost = document.getElementById('pj-guides-toast-host');
    if (toastHost) toastHost.remove();
  }

  function init() {
    ensureStyles();
    registerMenu();
    registerHeaderMenuEntry();
    evaluate();
    scheduleEvaluate(700);
    if (isTopWindow()) window.addEventListener('message', onMessage);
    window[INSTANCE_KEY] = { destroy, openManager };
  }

  init();
})();
