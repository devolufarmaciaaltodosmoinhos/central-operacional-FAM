import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { makeDataStore, initRemote, migrarDadosLocaisSeNecessario, __resetCacheForTests } from "../src/db.js";
import { createStore, reducer, initialState } from "../src/store.js";
import { createActions } from "../src/actions.js";
import { CATEGORIA_INDEFINIDA_ID, CATEGORIAS_PADRAO } from "../src/domain.js";

/**
 * Simula o endpoint /api/data (a função Netlify) em memória, para testar
 * db.js e actions.js exatamente como se comunicam com o servidor real,
 * sem precisar de infraestrutura do Netlify nestes testes.
 */
function mockApiServidor(estadoInicial = { servicos: [], categorias: [], config: {} }) {
  let estado = structuredClone(estadoInicial);
  const chamadas = { get: 0, put: 0 };
  global.fetch = async (url, opts) => {
    if (!String(url).includes("/api/data")) throw new Error("URL inesperada: " + url);
    if (!opts || !opts.method || opts.method === "GET") {
      chamadas.get++;
      return { ok: true, status: 200, json: async () => estado };
    }
    if (opts.method === "PUT") {
      chamadas.put++;
      const body = JSON.parse(opts.body);
      estado = { servicos: body.servicos || [], categorias: body.categorias || [], config: body.config || {} };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error("Método inesperado: " + opts.method);
  };
  return { getEstado: () => estado, chamadas };
}

async function novoAmbiente(estadoInicial) {
  __resetCacheForTests();
  const servidor = mockApiServidor(estadoInicial);
  await initRemote();
  const dataStore = makeDataStore();
  const store = createStore(reducer, initialState);
  const actions = createActions(store, dataStore);
  await actions.iniciar();
  return { store, actions, dataStore, servidor };
}

describe("integração — arranque via /api/data", () => {
  test("estado vazio no servidor -> usa categorias padrão em memória", async () => {
    const { store } = await novoAmbiente();
    assert.ok(store.getState().categorias.length >= 5);
    assert.equal(store.getState().pronto, true);
  });

  test("estado existente no servidor é carregado tal como está", async () => {
    const seed = { servicos: [{ id: "s1", nome: "Já existia", categoriaId: "cat_geral", ordem: 0, favorito: false, status: "ativo", tags: [], contadorAcessos: 0 }], categorias: CATEGORIAS_PADRAO, config: {} };
    const { store } = await novoAmbiente(seed);
    assert.equal(store.getState().servicos.length, 1);
    assert.equal(store.getState().servicos[0].nome, "Já existia");
  });
});

describe("integração — ciclo de vida de um serviço (via API)", () => {
  test("criar -> otimista no estado, depois persistido no servidor (PUT)", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const novo = await actions.criarServico({ nome: "Rastreio Teste", tipo: "url", url: "https://example.com", categoriaId: catId });
    assert.equal(store.getState().servicos.length, 1, "atualização otimista imediata");

    await actions.flushSync("teste");
    assert.equal(servidor.getEstado().servicos.length, 1, "persistido no servidor após o flush");
    assert.equal(servidor.getEstado().servicos[0].nome, "Rastreio Teste");
    assert.equal(novo.id.startsWith("srv_"), true, "IDs agora são gerados no cliente (sem autoIncrement do IndexedDB)");
  });

  test("alternar favorito reflete-se no estado imediatamente (otimista)", async () => {
    const { store, actions } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const novo = await actions.criarServico({ nome: "X", tipo: "url", url: "https://x.com", categoriaId: catId });
    assert.equal(store.getState().servicos.find(s => s.id === novo.id).favorito, false);
    await actions.alternarFavorito(novo.id);
    assert.equal(store.getState().servicos.find(s => s.id === novo.id).favorito, true);
  });

  test("remover elimina do estado e (após flush) do servidor", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const novo = await actions.criarServico({ nome: "X", tipo: "url", url: "https://x.com", categoriaId: catId });
    await actions.flushSync("t1");
    await actions.removerServico(novo.id);
    await actions.flushSync("t2");
    assert.equal(store.getState().servicos.length, 0);
    assert.equal(servidor.getEstado().servicos.length, 0);
  });
});

describe("integração — categorias e reatribuição (via API)", () => {
  test("eliminar categoria com serviços marca-os como Categoria Indefinida", async () => {
    const { store, actions } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const cat = await actions.criarCategoria("Temporária", "#123456");
    const serv = await actions.criarServico({ nome: "Serv", tipo: "url", url: "https://x.com", categoriaId: cat.id });
    await actions.removerCategoria(cat.id);
    const atualizado = store.getState().servicos.find(s => s.id === serv.id);
    assert.equal(atualizado.categoriaId, CATEGORIA_INDEFINIDA_ID);
  });
});

describe("integração — recarregarDoServidor (sincronização entre computadores)", () => {
  test("traz alterações feitas por outro 'computador' (outro cliente a escrever no mesmo servidor)", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    // Simula outro computador a escrever diretamente no "servidor" partilhado.
    const estado = servidor.getEstado();
    estado.servicos.push({ id: "srv_outro_pc", nome: "Criado noutro PC", categoriaId: "cat_geral", ordem: 0, favorito: false, status: "ativo", tags: [], contadorAcessos: 0 });

    assert.equal(store.getState().servicos.length, 0, "este cliente ainda não sabe do novo serviço");
    await actions.recarregarDoServidor();
    assert.equal(store.getState().servicos.length, 1);
    assert.equal(store.getState().servicos[0].nome, "Criado noutro PC");
  });
});

describe("integração — migração de dados locais antigos (IndexedDB) para o servidor", () => {
  beforeEach(() => { global.indexedDB = new IDBFactory(); });

  test("servidor vazio + IndexedDB antiga com dados -> envia-os automaticamente uma vez", async () => {
    // Simula uma instalação antiga (v2/v3) com dados guardados localmente.
    const req = global.indexedDB.open("FarmaciaAltoMoinhosDB", 3);
    await new Promise((resolve, reject) => {
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("servicos", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("categorias", { keyPath: "id" });
        db.createObjectStore("config", { keyPath: "key" });
      };
      req.onsuccess = () => resolve();
      req.onerror = reject;
    });
    const db = req.result;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["servicos", "categorias", "config"], "readwrite");
      tx.objectStore("categorias").put({ id: "cat_geral", nome: "Geral", cor: "#2b7a4b", parentId: null, ordem: 0 });
      tx.objectStore("servicos").add({ nome: "Antigo Local", tipo: "url", url: "https://old.com", categoriaId: "cat_geral" });
      tx.objectStore("config").put({ key: "nomeFarmacia", value: "Farmácia Antiga" });
      tx.oncomplete = resolve; tx.onerror = reject;
    });
    db.close();

    __resetCacheForTests();
    mockApiServidor({ servicos: [], categorias: [], config: {} });
    await initRemote();
    const dataStore = makeDataStore();
    const resultado = await migrarDadosLocaisSeNecessario(dataStore, CATEGORIAS_PADRAO);

    assert.equal(resultado.migrado, true);
    const servicosNoServidor = await dataStore.getAll("servicos");
    assert.equal(servicosNoServidor.length, 1);
    assert.equal(servicosNoServidor[0].nome, "Antigo Local");
    assert.equal(await dataStore.getConfig("nomeFarmacia"), "Farmácia Antiga");
  });

  test("servidor vazio + sem IndexedDB antiga -> semeia categorias padrão", async () => {
    __resetCacheForTests();
    mockApiServidor({ servicos: [], categorias: [], config: {} });
    await initRemote();
    const dataStore = makeDataStore();
    const resultado = await migrarDadosLocaisSeNecessario(dataStore, CATEGORIAS_PADRAO);
    assert.equal(resultado.migrado, false);
    assert.equal(resultado.semeado, true);
    const categorias = await dataStore.getAll("categorias");
    assert.ok(categorias.length >= 5);
  });

  test("servidor já com dados -> não faz nada, mesmo havendo IndexedDB antiga", async () => {
    __resetCacheForTests();
    mockApiServidor({ servicos: [{ id: "s1", nome: "Já no servidor", categoriaId: "cat_geral", ordem: 0 }], categorias: CATEGORIAS_PADRAO, config: {} });
    await initRemote();
    const dataStore = makeDataStore();
    const resultado = await migrarDadosLocaisSeNecessario(dataStore, CATEGORIAS_PADRAO);
    assert.equal(resultado.migrado, false);
    const servicos = await dataStore.getAll("servicos");
    assert.equal(servicos.length, 1);
    assert.equal(servicos[0].nome, "Já no servidor");
  });
});
