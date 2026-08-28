import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { makeDataStore, initRemote, migrarDadosLocaisSeNecessario, __resetCacheForTests } from "../src/db.js";
import { createStore, reducer, initialState } from "../src/store.js";
import { createActions } from "../src/actions.js";
import { CATEGORIA_INDEFINIDA_ID, CATEGORIAS_PADRAO } from "../src/domain.js";

/**
 * Simula os endpoints /api/data e /api/asset/:key (as funções Netlify) em
 * memória, para testar db.js e actions.js exatamente como se comunicam com
 * o servidor real, sem precisar de infraestrutura do Netlify nestes testes.
 */
function mockApiServidor(estadoInicial = { servicos: [], categorias: [], config: {} }) {
  let estado = structuredClone(estadoInicial);
  const assets = new Map();
  const chamadas = { get: 0, put: 0, assetGet: 0, assetPut: 0, assetDelete: 0 };
  global.fetch = async (url, opts) => {
    const urlStr = String(url);
    const method = opts?.method || "GET";

    if (urlStr.includes("/api/asset/")) {
      const key = decodeURIComponent(urlStr.split("/api/asset/")[1]);
      if (method === "GET") {
        chamadas.assetGet++;
        if (!assets.has(key)) return { ok: false, status: 404, json: async () => ({ error: "Não encontrado." }) };
        return { ok: true, status: 200, json: async () => ({ content: assets.get(key) }) };
      }
      if (method === "PUT") {
        chamadas.assetPut++;
        const body = JSON.parse(opts.body);
        assets.set(key, body.content);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (method === "DELETE") {
        chamadas.assetDelete++;
        assets.delete(key);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error("Método inesperado (asset): " + method);
    }

    if (!urlStr.includes("/api/data")) throw new Error("URL inesperada: " + urlStr);
    if (method === "GET") {
      chamadas.get++;
      return { ok: true, status: 200, json: async () => estado };
    }
    if (method === "PUT") {
      chamadas.put++;
      const body = JSON.parse(opts.body);
      estado = { servicos: body.servicos || [], categorias: body.categorias || [], config: body.config || {} };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error("Método inesperado: " + method);
  };
  return { getEstado: () => estado, getAssets: () => assets, chamadas };
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

describe("integração — conteúdo HTML em blob próprio (REGRESSÃO do limite de tamanho)", () => {
  test("criar serviço HTML grava o conteúdo no blob próprio, NUNCA no payload de /api/data", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const conteudoGrande = "<html>" + "x".repeat(50000) + "</html>";
    const novo = await actions.criarServico({ nome: "Formulário Grande", tipo: "html", htmlContent: conteudoGrande, categoriaId: catId });
    await actions.flushSync("t");

    const noServidor = servidor.getEstado().servicos.find(s => s.id === novo.id);
    assert.equal(noServidor.htmlContent, undefined, "o payload de /api/data nunca deve incluir htmlContent");
    assert.equal(servidor.getAssets().get(`servico-html:${novo.id}`), conteudoGrande, "o conteúdo tem de estar no blob próprio");
  });

  test("REGRESSÃO: editar um serviço HTML sem carregar novo ficheiro NÃO apaga o conteúdo existente", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const conteudoOriginal = "<html>conteúdo original</html>";
    const novo = await actions.criarServico({ nome: "Formulário", tipo: "html", htmlContent: conteudoOriginal, categoriaId: catId });

    // edição que só muda o nome, sem fornecer htmlContent (como faz modals.js quando não se escolhe novo ficheiro)
    await actions.atualizarServico(novo.id, { nome: "Formulário Renomeado", descricao: "", tipo: "html", url: null, imagemBase64: null, imagemUrl: null, categoriaId: catId, tags: [], favorito: false, status: "ativo" });

    assert.equal(servidor.getAssets().get(`servico-html:${novo.id}`), conteudoOriginal, "o conteúdo HTML não pode ter sido apagado por uma edição que não o tocou");
    const atualizado = store.getState().servicos.find(s => s.id === novo.id);
    assert.equal(atualizado.nome, "Formulário Renomeado");
    assert.equal(atualizado.tipo, "html", "o tipo tem de continuar 'html', nunca deve ter virado 'url'");
  });

  test("editar um serviço HTML COM novo ficheiro substitui o conteúdo no blob", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const novo = await actions.criarServico({ nome: "Formulário", tipo: "html", htmlContent: "<html>v1</html>", categoriaId: catId });
    await actions.atualizarServico(novo.id, { nome: "Formulário", tipo: "html", htmlContent: "<html>v2</html>", url: null, imagemBase64: null, imagemUrl: null, categoriaId: catId, tags: [], favorito: false, status: "ativo" });
    assert.equal(servidor.getAssets().get(`servico-html:${novo.id}`), "<html>v2</html>");
  });

  test("eliminar um serviço HTML remove também o seu conteúdo do servidor", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const catId = store.getState().categorias[0].id;
    const novo = await actions.criarServico({ nome: "Formulário", tipo: "html", htmlContent: "<html>x</html>", categoriaId: catId });
    await actions.removerServico(novo.id);
    await new Promise(r => setTimeout(r, 0)); // deixa o delete "fire-and-forget" terminar
    assert.equal(servidor.getAssets().has(`servico-html:${novo.id}`), false);
  });

  test("abrir um serviço HTML cujo conteúdo não está em memória vai buscá-lo ao blob (outro computador)", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    // simula um serviço já existente no servidor (criado por outro computador), tal como chega via GET /api/data
    servidor.getEstado().servicos.push({ id: "srv_outro", nome: "Vindo de outro PC", tipo: "html", categoriaId: "cat_geral", ordem: 0, favorito: false, status: "ativo", tags: [], contadorAcessos: 0 });
    servidor.getAssets().set("servico-html:srv_outro", "<html>conteúdo remoto</html>");
    await actions.recarregarDoServidor();

    const servicoEmMemoria = store.getState().servicos.find(s => s.id === "srv_outro");
    assert.equal(servicoEmMemoria.htmlContent, undefined, "o estado geral não traz o htmlContent");

    // window/Blob/URL não existem no Node — simulamos apenas a parte de obtenção do conteúdo
    const { makeDataStore } = await import("../src/db.js");
    const conteudo = await makeDataStore().getAsset(`servico-html:${servicoEmMemoria.id}`);
    assert.equal(conteudo, "<html>conteúdo remoto</html>");
  });

  test("exportarDados inclui o htmlContent mesmo quando só existe no servidor (não em memória)", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    servidor.getEstado().servicos.push({ id: "srv_outro", nome: "Vindo de outro PC", tipo: "html", categoriaId: "cat_geral", ordem: 0, favorito: false, status: "ativo", tags: [], contadorAcessos: 0 });
    servidor.getAssets().set("servico-html:srv_outro", "<html>conteúdo remoto</html>");
    await actions.recarregarDoServidor();

    // capta o Blob criado por exportarDados sem depender das APIs de DOM/URL do browser
    let payloadExportado = null;
    global.Blob = class { constructor(parts) { payloadExportado = JSON.parse(parts[0]); } };
    global.URL.createObjectURL = () => "blob:fake";
    global.document = {
      createElement: () => ({ click() {}, remove() {}, set href(v) {}, set download(v) {} }),
      body: { appendChild() {} }
    };
    await actions.exportarDados();

    const servicoExportado = payloadExportado.servicos.find(s => s.id === "srv_outro");
    assert.equal(servicoExportado.htmlContent, "<html>conteúdo remoto</html>");
  });

  test("importarDados guarda o htmlContent no blob próprio, não no payload de /api/data", async () => {
    const { store, actions, servidor } = await novoAmbiente({ servicos: [], categorias: CATEGORIAS_PADRAO, config: {} });
    const ficheiroImportado = {
      servicos: [{ id: "srv_importado", nome: "Importado", tipo: "html", htmlContent: "<html>importado</html>", categoriaId: "cat_geral", ordem: 0, favorito: false, status: "ativo", tags: [], contadorAcessos: 0 }],
      categorias: CATEGORIAS_PADRAO
    };
    const file = { text: async () => JSON.stringify(ficheiroImportado) };
    await actions.importarDados(file);

    assert.equal(servidor.getAssets().get("servico-html:srv_importado"), "<html>importado</html>");
    const noServidor = servidor.getEstado().servicos.find(s => s.id === "srv_importado");
    assert.equal(noServidor.htmlContent, undefined, "o payload principal não deve incluir o htmlContent importado");
    const emMemoria = store.getState().servicos.find(s => s.id === "srv_importado");
    assert.equal(emMemoria.htmlContent, "<html>importado</html>", "em memória, nesta sessão, o conteúdo fica disponível de imediato");
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
