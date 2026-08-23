import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let h, render;

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  global.window = dom.window;
  global.document = dom.window.document;
  ({ h, render } = await import("../src/vdom.js"));
});

describe("vdom — mount inicial", () => {
  test("cria os elementos DOM corretos", () => {
    const root = document.getElementById("root");
    render(h("div", { class: "box" }, h("span", {}, "olá")), root);
    assert.equal(root.querySelector(".box").textContent, "olá");
  });
});

describe("vdom — patch (diffing)", () => {
  test("atualiza texto sem recriar o nó pai", () => {
    const root = document.createElement("div");
    render(h("p", {}, "um"), root);
    const primeiroNo = root.firstChild;
    render(h("p", {}, "dois"), root);
    assert.equal(root.firstChild, primeiroNo, "o nó <p> deve ser reutilizado, não recriado");
    assert.equal(root.textContent, "dois");
  });

  test("reordena listas com keys em vez de recriar tudo", () => {
    const root = document.createElement("div");
    const item = (n) => h("li", { key: n }, "item-" + n);
    render(h("ul", {}, [item(1), item(2), item(3)]), root);
    const noItem2 = root.querySelectorAll("li")[1];
    assert.equal(noItem2.textContent, "item-2");

    render(h("ul", {}, [item(3), item(2), item(1)]), root);
    const liNodes = root.querySelectorAll("li");
    assert.equal(liNodes[0].textContent, "item-3");
    assert.equal(liNodes[1].textContent, "item-2");
    assert.equal(liNodes[1], noItem2, "o nó da key=2 deve ser o MESMO nó DOM reaproveitado");
  });

  test("remove nós que já não existem na nova árvore", () => {
    const root = document.createElement("div");
    const item = (n) => h("li", { key: n }, "item-" + n);
    render(h("ul", {}, [item(1), item(2), item(3)]), root);
    render(h("ul", {}, [item(1)]), root);
    assert.equal(root.querySelectorAll("li").length, 1);
  });

  test("suporta componentes funcionais", () => {
    const root = document.createElement("div");
    const Comp = (props) => h("strong", {}, "Olá, " + props.nome);
    render(h(Comp, { nome: "Ana" }), root);
    assert.equal(root.textContent, "Olá, Ana");
    render(h(Comp, { nome: "Bruno" }), root);
    assert.equal(root.textContent, "Olá, Bruno");
  });

  test("liga e substitui listeners onClick corretamente", () => {
    const root = document.createElement("div");
    let cliques = 0;
    render(h("button", { onClick: () => { cliques++; } }, "clica"), root);
    root.querySelector("button").dispatchEvent(new window.MouseEvent("click"));
    assert.equal(cliques, 1);

    let cliques2 = 0;
    render(h("button", { onClick: () => { cliques2++; } }, "clica"), root);
    root.querySelector("button").dispatchEvent(new window.MouseEvent("click"));
    assert.equal(cliques, 1, "o listener antigo não deve continuar ligado");
    assert.equal(cliques2, 1);
  });

  test("REGRESSÃO: conteúdo definido via prop `html` sobrevive a múltiplos patches sucessivos", () => {
    // Bug real encontrado em produção: um nó com `html` (equivalente a
    // dangerouslySetInnerHTML) e SEM children ficava vazio a partir do
    // segundo patch, porque diffChildren tratava o conteúdo como "não
    // reconhecido" e removia-o. Isto fazia o nome do serviço (e o ícone de
    // favorito) desaparecerem ao fim de duas ou mais atualizações seguidas.
    const root = document.createElement("div");
    const node = (texto) => h("div", { class: "nome", html: texto, key: "nome" });

    render(h("div", {}, [node("Primeiro")]), root);
    assert.equal(root.querySelector(".nome").innerHTML, "Primeiro");

    render(h("div", {}, [node("Segundo")]), root);
    assert.equal(root.querySelector(".nome").innerHTML, "Segundo", "1º patch não deve esvaziar o conteúdo");

    render(h("div", {}, [node("Terceiro")]), root);
    assert.equal(root.querySelector(".nome").innerHTML, "Terceiro", "2º patch (o que despoletava o bug) não deve esvaziar o conteúdo");

    render(h("div", {}, [node("Quarto")]), root);
    assert.equal(root.querySelector(".nome").innerHTML, "Quarto", "patches subsequentes continuam corretos");
  });
});
