import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../netlify/functions/asset.js";

function fakeStoreFactory() {
  const blobs = new Map();
  const getStoreImpl = () => ({
    async get(key) { return blobs.has(key) ? blobs.get(key) : null; },
    async set(key, value) { blobs.set(key, value); },
    async delete(key) { blobs.delete(key); }
  });
  return { getStoreImpl, blobs };
}

describe("função /api/asset/:key — GET", () => {
  test("devolve 404 quando a chave não existe", async () => {
    const { getStoreImpl } = fakeStoreFactory();
    const req = new Request("https://site.netlify.app/api/asset/servico-html:x", { method: "GET" });
    const res = await handleRequest(req, { params: { key: "servico-html:x" } }, getStoreImpl);
    assert.equal(res.status, 404);
  });

  test("devolve o conteúdo gravado", async () => {
    const { getStoreImpl, blobs } = fakeStoreFactory();
    blobs.set("asset:servico-html:x", "<html>conteúdo</html>");
    const req = new Request("https://site.netlify.app/api/asset/servico-html:x", { method: "GET" });
    const res = await handleRequest(req, { params: { key: "servico-html:x" } }, getStoreImpl);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { content: "<html>conteúdo</html>" });
  });

  test("400 quando a rota não tem chave", async () => {
    const { getStoreImpl } = fakeStoreFactory();
    const req = new Request("https://site.netlify.app/api/asset/", { method: "GET" });
    const res = await handleRequest(req, { params: {} }, getStoreImpl);
    assert.equal(res.status, 400);
  });
});

describe("função /api/asset/:key — PUT", () => {
  test("grava o conteúdo com sucesso", async () => {
    const { getStoreImpl, blobs } = fakeStoreFactory();
    const req = new Request("https://site.netlify.app/api/asset/servico-html:x", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "<p>olá</p>" })
    });
    const res = await handleRequest(req, { params: { key: "servico-html:x" } }, getStoreImpl);
    assert.equal(res.status, 200);
    assert.equal(blobs.get("asset:servico-html:x"), "<p>olá</p>");
  });

  test("rejeita corpo sem 'content' string (400)", async () => {
    const { getStoreImpl } = fakeStoreFactory();
    const req = new Request("https://site.netlify.app/api/asset/x", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ foo: "bar" })
    });
    const res = await handleRequest(req, { params: { key: "x" } }, getStoreImpl);
    assert.equal(res.status, 400);
  });

  test("REGRESSÃO: rejeita conteúdo demasiado grande com 413 (em vez de deixar o pedido geral falhar)", async () => {
    const { getStoreImpl } = fakeStoreFactory();
    const enorme = "a".repeat(7 * 1024 * 1024); // 7MB, acima do limite prático
    const req = new Request("https://site.netlify.app/api/asset/x", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: enorme })
    });
    const res = await handleRequest(req, { params: { key: "x" } }, getStoreImpl);
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.match(json.error, /grande/);
  });
});

describe("função /api/asset/:key — DELETE", () => {
  test("remove o conteúdo gravado", async () => {
    const { getStoreImpl, blobs } = fakeStoreFactory();
    blobs.set("asset:x", "conteúdo");
    const req = new Request("https://site.netlify.app/api/asset/x", { method: "DELETE" });
    const res = await handleRequest(req, { params: { key: "x" } }, getStoreImpl);
    assert.equal(res.status, 200);
    assert.equal(blobs.has("asset:x"), false);
  });
});

describe("função /api/asset/:key — outros métodos", () => {
  test("método não suportado devolve 405", async () => {
    const { getStoreImpl } = fakeStoreFactory();
    const req = new Request("https://site.netlify.app/api/asset/x", { method: "POST" });
    const res = await handleRequest(req, { params: { key: "x" } }, getStoreImpl);
    assert.equal(res.status, 405);
  });
});
