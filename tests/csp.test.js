import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const netlifyToml = readFileSync(join(__dirname, "..", "netlify.toml"), "utf-8");

function extrairCSP(toml) {
  const linha = toml.split("\n").find(l => l.includes("Content-Security-Policy"));
  const match = linha && linha.match(/=\s*"(.*)"/);
  return match ? match[1] : null;
}

describe("REGRESSÃO: CSP não pode voltar a bloquear serviços HTML carregados", () => {
  const csp = extrairCSP(netlifyToml);

  test("netlify.toml define uma CSP", () => {
    assert.ok(csp, "não encontrei a linha Content-Security-Policy em netlify.toml");
  });

  test("style-src permite 'unsafe-inline' (senão o <style> dos HTML carregados fica todo bloqueado)", () => {
    // Bug real: serviços do tipo HTML são abertos como blob:, que HERDA a CSP
    // do site (não tem resposta HTTP própria). Sem 'unsafe-inline' em
    // style-src, qualquer <style> ou style="" inline no documento carregado
    // é ignorado pelo browser e o documento aparece completamente
    // desformatado (só texto em coluna, sem cores nem layout).
    const styleSrc = csp.match(/style-src ([^;]+)/)[1];
    assert.match(styleSrc, /'unsafe-inline'/);
  });

  test("script-src permite 'unsafe-inline' (para documentos HTML carregados com <script> inline)", () => {
    const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
    assert.match(scriptSrc, /'unsafe-inline'/);
  });

  test("img-src continua a aceitar data:/blob: (imagens embutidas nos HTML carregados)", () => {
    const imgSrc = csp.match(/img-src ([^;]+)/)[1];
    assert.match(imgSrc, /data:/);
    assert.match(imgSrc, /blob:/);
  });
});
