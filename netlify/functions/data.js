/**
 * netlify/functions/data.js — API mínima que expõe o estado partilhado da
 * Central (serviços, categorias, configurações) guardado no Netlify Blobs.
 *
 * Isto substitui o IndexedDB (armazenamento local, por computador) por um
 * armazenamento central: qualquer posto de trabalho que abra o site lê e
 * escreve sempre o MESMO blob, por isso as alterações passam a aparecer em
 * todos os computadores.
 *
 * Não é necessária nenhuma variável de ambiente manual (BLOBS_STORE_NAME,
 * NETLIFY_AUTH_TOKEN, etc.) — o `getStore()` deteta automaticamente o
 * contexto do site quando a função corre dentro do runtime do Netlify.
 * Essas variáveis, se as tiver configurado manualmente numa tentativa
 * anterior, podem ser removidas em segurança (não têm efeito aqui).
 *
 * Rota exposta: /api/data (ver `config.path` abaixo e o `netlify.toml`).
 *   GET  /api/data  -> devolve o estado atual em JSON
 *   PUT  /api/data  -> substitui o estado atual pelo corpo JSON enviado
 */
import { getStore } from "@netlify/blobs";

const STORE_NAME = "central-farmacia";
const BLOB_KEY = "estado";

const ESTADO_VAZIO = {
  servicos: [],
  categorias: [],
  config: {}
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export default async (request) => {
  return handleRequest(request, getStore);
};

export const config = { path: "/api/data" };

/**
 * Lógica do pedido isolada da obtenção da store, para ser testável sem
 * depender do runtime real do Netlify (ver tests/function.test.js).
 */
export async function handleRequest(request, getStoreImpl) {
  let store;
  try {
    store = getStoreImpl(STORE_NAME);
  } catch (err) {
    return jsonResponse({ error: "Netlify Blobs não está disponível neste ambiente.", detail: String(err) }, 500);
  }

  if (request.method === "GET") {
    try {
      const estado = await store.get(BLOB_KEY, { type: "json" });
      return jsonResponse(estado || ESTADO_VAZIO);
    } catch (err) {
      return jsonResponse({ error: "Falha ao ler o estado.", detail: String(err) }, 500);
    }
  }

  if (request.method === "PUT") {
    try {
      const body = await request.json();
      if (!body || typeof body !== "object" || !Array.isArray(body.servicos) || !Array.isArray(body.categorias)) {
        return jsonResponse({ error: "Corpo inválido: esperado { servicos: [], categorias: [], config: {} }." }, 400);
      }
      const payload = { servicos: body.servicos, categorias: body.categorias, config: body.config || {} };
      await store.setJSON(BLOB_KEY, payload);
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: "Falha ao gravar o estado.", detail: String(err) }, 500);
    }
  }

  return jsonResponse({ error: "Método não suportado." }, 405);
}
