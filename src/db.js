/**
 * db.js — camada de dados. Fala com a função Netlify (`/api/data`), que por
 * sua vez guarda tudo no Netlify Blobs. Isto substitui o antigo IndexedDB
 * (armazenamento local, por computador): agora todos os postos de trabalho
 * leem e escrevem o MESMO estado partilhado.
 *
 * Mantém deliberadamente a mesma "forma" de interface que a versão anterior
 * (getAll/putAll/getConfig/setConfig/clearAll) para que a camada de ações
 * (actions.js) não precise de saber de onde vêm os dados.
 */
const API_URL = "/api/data";
const OLD_INDEXEDDB_NAME = "FarmaciaAltoMoinhosDB";

let cache = null;
let cacheLoaded = false;

async function ensureLoaded() {
  if (cacheLoaded) return cache;
  const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Não foi possível ler os dados do servidor (HTTP ${res.status}).`);
  const data = await res.json();
  cache = { servicos: data.servicos || [], categorias: data.categorias || [], config: data.config || {} };
  cacheLoaded = true;
  return cache;
}

async function persist() {
  const res = await fetch(API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cache)
  });
  if (!res.ok) throw new Error(`Não foi possível gravar os dados no servidor (HTTP ${res.status}).`);
}

export function makeDataStore() {
  return {
    async getAll(storeName) {
      const c = await ensureLoaded();
      if (storeName === "servicos") return c.servicos;
      if (storeName === "categorias") return c.categorias;
      return [];
    },
    async putAll(storeName, items) {
      await ensureLoaded();
      if (storeName === "servicos") cache.servicos = items;
      else if (storeName === "categorias") cache.categorias = items;
      await persist();
    },
    async put() { /* "activity" deixou de ser persistida remotamente — ninguém a lê de volta */ },
    async delete() { /* idem */ },
    async getConfig(key) {
      const c = await ensureLoaded();
      return c.config && key in c.config ? c.config[key] : null;
    },
    async setConfig(key, value) {
      await ensureLoaded();
      cache.config = { ...(cache.config || {}), [key]: value };
      await persist();
    },
    async clearAll() {
      cache = { servicos: [], categorias: [], config: {} };
      cacheLoaded = true;
      await persist();
    },
    /** Força ir novamente ao servidor buscar o estado mais recente (usado no refresh manual e no polling). */
    async refresh() {
      cacheLoaded = false;
      return ensureLoaded();
    }
  };
}

/** Liga-se ao servidor pela primeira vez (equivalente ao antigo "abrir a base de dados"). */
export async function initRemote() {
  await ensureLoaded();
}

/** Usado apenas pelos testes automatizados, para isolar o cache do módulo entre casos de teste. */
export function __resetCacheForTests() {
  cache = null;
  cacheLoaded = false;
}

/**
 * Prepara o estado inicial do servidor, caso ainda esteja vazio:
 *  1. Se este computador tiver dados antigos no IndexedDB local (de uma
 *     versão anterior), são enviados uma única vez para o servidor.
 *  2. Caso contrário, e se o servidor não tiver NENHUMA categoria, semeia as
 *     categorias por omissão — assim todos os computadores partem do mesmo
 *     ponto, não apenas o primeiro a abrir a aplicação.
 */
export async function migrarDadosLocaisSeNecessario(dataStore, categoriasPadrao) {
  const remoto = await dataStore.getAll("servicos");
  const remotoCategorias = await dataStore.getAll("categorias");
  if (remoto.length > 0 || remotoCategorias.length > 0) return { migrado: false };

  const local = await lerIndexedDBAntigoSeExistir();
  if (local && (local.servicos.length || local.categorias.length)) {
    if (local.categorias.length) await dataStore.putAll("categorias", local.categorias);
    if (local.servicos.length) await dataStore.putAll("servicos", local.servicos);
    if (local.config.logo) await dataStore.setConfig("logo", local.config.logo);
    if (local.config.nomeFarmacia) await dataStore.setConfig("nomeFarmacia", local.config.nomeFarmacia);
    return { migrado: true, total: local.servicos.length };
  }

  if (categoriasPadrao && categoriasPadrao.length) await dataStore.putAll("categorias", categoriasPadrao);
  return { migrado: false, semeado: true };
}

function lerIndexedDBAntigoSeExistir() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolveOuter) => {
    (async () => {
      try {
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          if (!dbs.some(d => d.name === OLD_INDEXEDDB_NAME)) { resolveOuter(null); return; }
        }
      } catch (e) { /* API não suportada neste browser; tenta mesmo assim abrir */ }

      let resolved = false;
      const done = (val) => { if (!resolved) { resolved = true; resolveOuter(val); } };
      let req;
      try { req = indexedDB.open(OLD_INDEXEDDB_NAME); } catch (e) { done(null); return; }
      req.onerror = () => done(null);
      req.onupgradeneeded = () => { done(null); }; // base inexistente: não criar nada, abortar
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("servicos")) { db.close(); done(null); return; }
        try {
          const stores = ["servicos"];
          if (db.objectStoreNames.contains("categorias")) stores.push("categorias");
          if (db.objectStoreNames.contains("config")) stores.push("config");
          const tx = db.transaction(stores, "readonly");
          const reqS = tx.objectStore("servicos").getAll();
          const reqC = db.objectStoreNames.contains("categorias") ? tx.objectStore("categorias").getAll() : null;
          const reqCfg = db.objectStoreNames.contains("config") ? tx.objectStore("config").getAll() : null;
          tx.oncomplete = () => {
            const config = {};
            (reqCfg?.result || []).forEach(c => { config[c.key] = c.value; });
            db.close();
            done({ servicos: reqS.result || [], categorias: reqC?.result || [], config });
          };
          tx.onerror = () => { db.close(); done(null); };
        } catch (e) { db.close(); done(null); }
      };
    })();
  });
}
