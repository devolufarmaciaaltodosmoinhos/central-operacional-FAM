import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createStore, reducer, initialState } from "../src/store.js";

describe("store — imutabilidade", () => {
  test("o estado inicial está congelado", () => {
    assert.equal(Object.isFrozen(initialState), true);
  });

  test("dispatch nunca muta o estado anterior", () => {
    const store = createStore(reducer, initialState);
    const before = store.getState();
    store.dispatch({ type: "SET_SEARCH", query: "abc" });
    const after = store.getState();
    assert.notEqual(before, after);
    assert.equal(before.searchQuery, "");
    assert.equal(after.searchQuery, "abc");
    assert.equal(Object.isFrozen(after), true);
  });

  test("ADD_SERVICO produz um novo array sem alterar o antigo", () => {
    const store = createStore(reducer, initialState);
    const arrAntes = store.getState().servicos;
    store.dispatch({ type: "ADD_SERVICO", servico: { id: 1, nome: "X" } });
    const arrDepois = store.getState().servicos;
    assert.equal(arrAntes.length, 0);
    assert.equal(arrDepois.length, 1);
    assert.notEqual(arrAntes, arrDepois);
  });

  test("os subscritores são notificados com o novo estado", () => {
    const store = createStore(reducer, initialState);
    let recebido = null;
    store.subscribe((state) => { recebido = state; });
    store.dispatch({ type: "SET_SORT", sortBy: "nome" });
    assert.equal(recebido.sortBy, "nome");
  });

  test("uma ação desconhecida devolve o mesmo objeto de estado (sem notificar)", () => {
    const store = createStore(reducer, initialState);
    let chamadas = 0;
    store.subscribe(() => { chamadas++; });
    store.dispatch({ type: "ACAO_INEXISTENTE" });
    assert.equal(chamadas, 0);
  });
});

describe("reducer — REORDER_SERVICOS", () => {
  test("reordena e reindexa o campo ordem", () => {
    const state = { ...initialState, servicos: [{ id: 1, ordem: 0 }, { id: 2, ordem: 1 }, { id: 3, ordem: 2 }] };
    const next = reducer(state, { type: "REORDER_SERVICOS", fromId: 1, toId: 3 });
    assert.deepEqual(next.servicos.map(s => s.id), [2, 3, 1]);
    assert.deepEqual(next.servicos.map(s => s.ordem), [0, 1, 2]);
  });
});

describe("reducer — REORDER_CATEGORIAS", () => {
  test("reordena apenas entre categorias irmãs (mesmo parentId)", () => {
    const state = {
      ...initialState,
      categorias: [
        { id: "a", parentId: null, ordem: 0 },
        { id: "b", parentId: null, ordem: 1 },
        { id: "c", parentId: null, ordem: 2 }
      ]
    };
    const next = reducer(state, { type: "REORDER_CATEGORIAS", fromId: "a", toId: "c" });
    assert.deepEqual(next.categorias.map(c => c.id), ["b", "c", "a"]);
    assert.deepEqual(next.categorias.map(c => c.ordem), [0, 1, 2]);
  });

  test("ignora o arrasto entre categorias de níveis diferentes (parentId distinto)", () => {
    const state = {
      ...initialState,
      categorias: [
        { id: "a", parentId: null, ordem: 0 },
        { id: "a1", parentId: "a", ordem: 0 }
      ]
    };
    const next = reducer(state, { type: "REORDER_CATEGORIAS", fromId: "a", toId: "a1" });
    assert.equal(next, state, "estado deve permanecer inalterado quando os pais diferem");
  });
});

describe("reducer — REMOVE_CATEGORIA", () => {
  test("reatribui serviços órfãos e reajusta o scope se necessário", () => {
    const state = {
      ...initialState,
      categorias: [{ id: "a", nome: "A", parentId: null, ordem: 0 }],
      servicos: [{ id: 1, categoriaId: "a" }],
      scope: { tipo: "categoria-direta", categoriaId: "a" }
    };
    const next = reducer(state, { type: "REMOVE_CATEGORIA", id: "a" });
    assert.equal(next.categorias.length, 0);
    assert.equal(next.servicos[0].categoriaId, "cat_indefinida");
    assert.deepEqual(next.scope, { tipo: "home" });
  });
});
