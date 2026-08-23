import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let deveAdiarRenderizacao;

before(async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  global.window = dom.window;
  global.document = dom.window.document;
  ({ deveAdiarRenderizacao } = await import("../src/utils.js"));
});

describe("deveAdiarRenderizacao — REGRESSÃO: botões não devem bloquear o refresh", () => {
  test("adia quando o foco está num campo de texto dentro do container", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    container.appendChild(input);
    assert.equal(deveAdiarRenderizacao(input, container), true);
  });

  test("NÃO adia quando o foco está num botão dentro do container (ex.: botão 'eliminar' acabado de clicar)", () => {
    const container = document.createElement("div");
    const btn = document.createElement("button");
    container.appendChild(btn);
    assert.equal(deveAdiarRenderizacao(btn, container), false);
  });

  test("NÃO adia quando o foco está num input de cor ou checkbox", () => {
    const container = document.createElement("div");
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    container.appendChild(colorInput);
    assert.equal(deveAdiarRenderizacao(colorInput, container), false);
  });

  test("NÃO adia quando o campo de texto focado está fora do container", () => {
    const container = document.createElement("div");
    const outroContainer = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    outroContainer.appendChild(input);
    assert.equal(deveAdiarRenderizacao(input, container), false);
  });

  test("NÃO adia quando não há nada focado", () => {
    const container = document.createElement("div");
    assert.equal(deveAdiarRenderizacao(null, container), false);
  });
});
