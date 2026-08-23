import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCategoryTree, getDescendantIds, getAncestorPath, contarServicosNaCategoria,
  filtrarServicos, ordenarServicos, reatribuirAoEliminarCategoria, podeSerPai,
  getCategoriasRaiz, CATEGORIA_INDEFINIDA_ID
} from "../src/domain.js";

function cat(id, parentId = null, extra = {}) { return { id, nome: id, cor: "#2b7a4b", imagem: null, parentId, ordem: 0, ...extra }; }
function srv(id, categoriaId, extra = {}) { return { id, nome: `Serviço ${id}`, categoriaId, favorito: false, status: "ativo", ordem: id, contadorAcessos: 0, tags: [], ...extra }; }

describe("buildCategoryTree", () => {
  test("agrupa categorias de topo e filhas corretamente", () => {
    const categorias = [cat("a"), cat("b"), cat("a1", "a"), cat("a2", "a"), cat("a1x", "a1")];
    const tree = buildCategoryTree(categorias);
    assert.equal(tree.length, 2);
    const a = tree.find(n => n.id === "a");
    assert.equal(a.filhos.length, 2);
    const a1 = a.filhos.find(n => n.id === "a1");
    assert.equal(a1.filhos.length, 1);
    assert.equal(a1.filhos[0].id, "a1x");
  });
});

describe("getDescendantIds", () => {
  test("inclui o próprio id e todos os descendentes", () => {
    const categorias = [cat("a"), cat("a1", "a"), cat("a2", "a"), cat("a1x", "a1"), cat("b")];
    const ids = getDescendantIds(categorias, "a").sort();
    assert.deepEqual(ids.sort(), ["a", "a1", "a1x", "a2"]);
  });
  test("categoria folha devolve só o próprio id", () => {
    const categorias = [cat("a"), cat("a1", "a")];
    assert.deepEqual(getDescendantIds(categorias, "a1"), ["a1"]);
  });
});

describe("getAncestorPath", () => {
  test("devolve o caminho da raiz até à categoria", () => {
    const categorias = [cat("a"), cat("a1", "a"), cat("a1x", "a1")];
    const path = getAncestorPath(categorias, "a1x").map(c => c.id);
    assert.deepEqual(path, ["a", "a1", "a1x"]);
  });
});

describe("contarServicosNaCategoria", () => {
  test("conta apenas diretos quando incluirDescendentes=false", () => {
    const categorias = [cat("a"), cat("a1", "a")];
    const servicos = [srv(1, "a"), srv(2, "a1"), srv(3, "a1")];
    assert.equal(contarServicosNaCategoria(servicos, categorias, "a", false), 1);
  });
  test("conta descendentes quando incluirDescendentes=true", () => {
    const categorias = [cat("a"), cat("a1", "a")];
    const servicos = [srv(1, "a"), srv(2, "a1"), srv(3, "a1")];
    assert.equal(contarServicosNaCategoria(servicos, categorias, "a", true), 3);
  });
});

describe("podeSerPai (previne ciclos)", () => {
  test("uma categoria não pode ser pai de si própria", () => {
    const categorias = [cat("a")];
    assert.equal(podeSerPai(categorias, "a", "a"), false);
  });
  test("uma categoria não pode ser pai de um antepassado seu (evita ciclo)", () => {
    const categorias = [cat("a"), cat("a1", "a")];
    assert.equal(podeSerPai(categorias, "a", "a1"), false);
  });
  test("permite associação válida a um não-descendente", () => {
    const categorias = [cat("a"), cat("b")];
    assert.equal(podeSerPai(categorias, "a", "b"), true);
  });
});

describe("reatribuirAoEliminarCategoria", () => {
  test("serviços da categoria eliminada passam a Categoria Indefinida", () => {
    const categorias = [cat("a"), cat("b")];
    const servicos = [srv(1, "a"), srv(2, "b")];
    const { servicos: novos } = reatribuirAoEliminarCategoria(categorias, servicos, "a");
    assert.equal(novos.find(s => s.id === 1).categoriaId, CATEGORIA_INDEFINIDA_ID);
    assert.equal(novos.find(s => s.id === 2).categoriaId, "b");
  });
  test("subcategorias diretas sobem para o avô ao eliminar o pai", () => {
    const categorias = [cat("a"), cat("a1", "a"), cat("a1x", "a1")];
    const { categorias: novas } = reatribuirAoEliminarCategoria(categorias, [], "a1");
    const a1x = novas.find(c => c.id === "a1x");
    assert.equal(a1x.parentId, "a"); // avô de a1x era 'a' (pai de a1)
  });
});

describe("filtrarServicos", () => {
  const categorias = [cat("a"), cat("a1", "a")];
  const servicos = [
    srv(1, "a", { nome: "Rastreio Tensão" }),
    srv(2, "a1", { nome: "Questionário Nutricional" }),
    srv(3, "a1", { nome: "Outro serviço", favorito: true })
  ];

  test("pesquisa é global, ignora o âmbito de navegação", () => {
    const state = { servicos, categorias, searchQuery: "tensão", scope: { tipo: "categoria-direta", categoriaId: "a1" }, sortBy: "ordem" };
    const result = filtrarServicos(state);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
  });

  test("scope categoria-direta filtra apenas serviços diretos", () => {
    const state = { servicos, categorias, searchQuery: "", scope: { tipo: "categoria-direta", categoriaId: "a" }, sortBy: "ordem" };
    const result = filtrarServicos(state);
    assert.deepEqual(result.map(s => s.id), [1]);
  });

  test("scope categoria (com descendentes) inclui subcategorias", () => {
    const state = { servicos, categorias, searchQuery: "", scope: { tipo: "categoria", categoriaId: "a" }, sortBy: "ordem" };
    const result = filtrarServicos(state);
    assert.deepEqual(result.map(s => s.id).sort(), [1, 2, 3]);
  });

  test("scope favoritos só devolve favoritos", () => {
    const state = { servicos, categorias, searchQuery: "", scope: { tipo: "favoritos" }, sortBy: "ordem" };
    const result = filtrarServicos(state);
    assert.deepEqual(result.map(s => s.id), [3]);
  });
});

describe("ordenarServicos", () => {
  test("ordena por nome (A-Z, locale pt)", () => {
    const servicos = [srv(1, "a", { nome: "Zebra" }), srv(2, "a", { nome: "Abelha" })];
    const result = ordenarServicos(servicos, "nome");
    assert.deepEqual(result.map(s => s.nome), ["Abelha", "Zebra"]);
  });
  test("ordena por uso decrescente", () => {
    const servicos = [srv(1, "a", { contadorAcessos: 2 }), srv(2, "a", { contadorAcessos: 9 })];
    const result = ordenarServicos(servicos, "uso");
    assert.deepEqual(result.map(s => s.id), [2, 1]);
  });
});

describe("getCategoriasRaiz", () => {
  test("inclui Categoria Indefinida apenas se houver serviços órfãos", () => {
    const categorias = [cat("a")];
    const semOrfaos = getCategoriasRaiz(categorias, [srv(1, "a")]);
    assert.equal(semOrfaos.some(c => c.id === CATEGORIA_INDEFINIDA_ID), false);
    const comOrfaos = getCategoriasRaiz(categorias, [srv(1, CATEGORIA_INDEFINIDA_ID)]);
    assert.equal(comOrfaos.some(c => c.id === CATEGORIA_INDEFINIDA_ID), true);
  });
});
