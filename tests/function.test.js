import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../netlify/functions/data.js";

/** Fake mínimo do Netlify Blobs Store, só com o que a função usa. */
function fakeStoreFactory(inicial = null) {
  let blob = inicial;
  const calls = [];
  const getStoreImpl = (name) => {
    calls.push(name);
    return {
      async get(key, opts) {
        if (key !== "estado") return null;
        return blob;
      },
      async setJSON(key, value) {
        if (key !== "estado") throw new Error("chave inesperada");
        blob = value;
      }
    };
  };
  return { getStoreImpl, getBlob: () => blob, calls };
}

describe("função /api/data — GET", () => {
  test("devolve estado vazio por omissão quando não há blob gravado", async () => {
    const { getStoreImpl } = fakeStoreFactory(null);
    const req = new Request("https://site.netlify.app/api/data", { method: "GET" });
    const res = await handleRequest(req, getStoreImpl);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { servicos: [], categorias: [], config: {} });
  });

  test("devolve o estado gravado tal como está", async () => {
    const seed = { servicos: [{ id: "1", nome: "X" }], categorias: [], config: { nomeFarmacia: "Y" } };
    const { getStoreImpl } = fakeStoreFactory(seed);
    const req = new Request("https://site.netlify.app/api/data", { method: "GET" });
    const res = await handleRequest(req, getStoreImpl);
    const json = await res.json();
    assert.deepEqual(json, seed);
  });
});

describe("função /api/data — PUT", () => {
  test("grava um corpo válido e devolve ok:true", async () => {
    const { getStoreImpl, getBlob } = fakeStoreFactory(null);
    const payload = { servicos: [{ id: "1" }], categorias: [{ id: "c1" }], config: { logo: "x" } };
    const req = new Request("https://site.netlify.app/api/data", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    const res = await handleRequest(req, getStoreImpl);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(getBlob(), payload);
  });

  test("rejeita corpo sem 'servicos'/'categorias' como arrays (400)", async () => {
    const { getStoreImpl } = fakeStoreFactory(null);
    const req = new Request("https://site.netlify.app/api/data", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ foo: "bar" })
    });
    const res = await handleRequest(req, getStoreImpl);
    assert.equal(res.status, 400);
  });

  test("config em falta no corpo é normalizada para objeto vazio", async () => {
    const { getStoreImpl, getBlob } = fakeStoreFactory(null);
    const req = new Request("https://site.netlify.app/api/data", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ servicos: [], categorias: [] })
    });
    await handleRequest(req, getStoreImpl);
    assert.deepEqual(getBlob().config, {});
  });
});

describe("função /api/data — outros métodos", () => {
  test("método não suportado devolve 405", async () => {
    const { getStoreImpl } = fakeStoreFactory(null);
    const req = new Request("https://site.netlify.app/api/data", { method: "DELETE" });
    const res = await handleRequest(req, getStoreImpl);
    assert.equal(res.status, 405);
  });
});

describe("função /api/data — falhas do Blobs", () => {
  test("erro ao obter a store devolve 500 com mensagem clara", async () => {
    const getStoreImpl = () => { throw new Error("sem contexto Netlify"); };
    const req = new Request("https://site.netlify.app/api/data", { method: "GET" });
    const res = await handleRequest(req, getStoreImpl);
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.ok(json.error);
  });
});
