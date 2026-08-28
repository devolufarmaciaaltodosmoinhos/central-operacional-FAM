import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeDataStore, __resetCacheForTests, initRemote } from "../src/db.js";

/** Simula /api/asset/:key em memória, incluindo os sub-caminhos ":part:N" e ":meta". */
function mockAssetServidor() {
  const blobs = new Map();
  const chamadasPUT = [];
  global.fetch = async (url, opts) => {
    const method = opts?.method || "GET";
    const key = decodeURIComponent(String(url).split("/api/asset/")[1]);
    if (method === "GET") {
      if (!blobs.has(key)) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
      return { ok: true, status: 200, json: async () => ({ content: blobs.get(key) }) };
    }
    if (method === "PUT") {
      chamadasPUT.push(key);
      const body = JSON.parse(opts.body);
      blobs.set(key, body.content);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (method === "DELETE") {
      blobs.delete(key);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error("método inesperado: " + method);
  };
  return { blobs, chamadasPUT };
}

describe("conteúdo fragmentado — REGRESSÃO: sem limite de tamanho para documentos grandes", () => {
  let servidor;
  beforeEach(() => { __resetCacheForTests(); servidor = mockAssetServidor(); });

  test("conteúdo pequeno é gravado de uma vez, sem fragmentação", async () => {
    const ds = makeDataStore();
    await ds.setAsset("servico-html:x", "<html>pequeno</html>");
    assert.equal(servidor.blobs.get("servico-html:x"), "<html>pequeno</html>");
    assert.equal(servidor.blobs.has("servico-html:x:meta"), false);
  });

  test("conteúdo grande (>2MB) é dividido em várias partes e reconstruído corretamente na leitura", async () => {
    const ds = makeDataStore();
    const conteudoGrande = "x".repeat(5 * 1024 * 1024 + 137); // > 2 pedaços de 2MB
    await ds.setAsset("servico-html:grande", conteudoGrande);

    assert.equal(servidor.blobs.has("servico-html:grande"), false, "não deve existir caminho simples");
    assert.equal(servidor.blobs.has("servico-html:grande:meta"), true, "deve existir um manifesto");
    const meta = JSON.parse(servidor.blobs.get("servico-html:grande:meta"));
    assert.equal(meta.totalParts, 3);

    const lido = await ds.getAsset("servico-html:grande");
    assert.equal(lido, conteudoGrande, "o conteúdo remontado tem de ser byte a byte igual ao original");
    assert.equal(lido.length, conteudoGrande.length);
  });

  test("conteúdo muito grande (>20MB, várias dezenas de partes) continua a funcionar sem limite artificial", async () => {
    const ds = makeDataStore();
    const conteudoEnorme = "abcdefghij".repeat(2.2 * 1024 * 1024); // ~22MB
    await ds.setAsset("servico-html:enorme", conteudoEnorme);
    const lido = await ds.getAsset("servico-html:enorme");
    assert.equal(lido, conteudoEnorme);
  });

  test("relata progresso por cada parte enviada", async () => {
    const ds = makeDataStore();
    const conteudo = "y".repeat(5 * 1024 * 1024);
    const progresso = [];
    await ds.setAsset("servico-html:p", conteudo, (parte, total) => progresso.push([parte, total]));
    assert.deepEqual(progresso, [[1, 3], [2, 3], [3, 3]]);
  });

  test("substituir conteúdo fragmentado por um MENOR (agora simples) limpa as partes antigas", async () => {
    const ds = makeDataStore();
    await ds.setAsset("servico-html:x", "z".repeat(5 * 1024 * 1024)); // fica fragmentado (3 partes)
    assert.equal(servidor.blobs.has("servico-html:x:part:0"), true);

    await ds.setAsset("servico-html:x", "conteúdo pequeno"); // agora cabe no caminho simples
    assert.equal(servidor.blobs.get("servico-html:x"), "conteúdo pequeno");
    assert.equal(servidor.blobs.has("servico-html:x:meta"), false, "o manifesto antigo tem de ser removido");
    assert.equal(servidor.blobs.has("servico-html:x:part:0"), false, "as partes antigas têm de ser removidas");
    assert.equal(servidor.blobs.has("servico-html:x:part:1"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:2"), false);
  });

  test("substituir conteúdo simples por um MAIOR (agora fragmentado) limpa o caminho simples antigo", async () => {
    const ds = makeDataStore();
    await ds.setAsset("servico-html:x", "pequeno");
    assert.equal(servidor.blobs.get("servico-html:x"), "pequeno");

    await ds.setAsset("servico-html:x", "w".repeat(5 * 1024 * 1024));
    assert.equal(servidor.blobs.has("servico-html:x"), false, "o caminho simples antigo tem de ser removido");
    assert.equal(JSON.parse(servidor.blobs.get("servico-html:x:meta")).totalParts, 3);
  });

  test("substituir por conteúdo fragmentado com MENOS partes limpa só as partes excedentes", async () => {
    const ds = makeDataStore();
    await ds.setAsset("servico-html:x", "a".repeat(9 * 1024 * 1024)); // 5 partes
    const metaAntigo = JSON.parse(servidor.blobs.get("servico-html:x:meta"));
    assert.equal(metaAntigo.totalParts, 5);

    await ds.setAsset("servico-html:x", "b".repeat(3 * 1024 * 1024)); // 2 partes
    assert.equal(JSON.parse(servidor.blobs.get("servico-html:x:meta")).totalParts, 2);
    assert.equal(servidor.blobs.has("servico-html:x:part:2"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:3"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:4"), false);
  });

  test("getAsset devolve null quando não existe nem no caminho simples nem fragmentado", async () => {
    const ds = makeDataStore();
    const lido = await ds.getAsset("servico-html:inexistente");
    assert.equal(lido, null);
  });

  test("deleteAsset remove o manifesto e todas as partes de um conteúdo fragmentado", async () => {
    const ds = makeDataStore();
    await ds.setAsset("servico-html:x", "c".repeat(5 * 1024 * 1024));
    await ds.deleteAsset("servico-html:x");
    assert.equal(servidor.blobs.has("servico-html:x:meta"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:0"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:1"), false);
    assert.equal(servidor.blobs.has("servico-html:x:part:2"), false);
  });
});
