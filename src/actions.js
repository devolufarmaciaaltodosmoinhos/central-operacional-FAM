/**
 * actions.js — única camada autorizada a misturar "store puro" com efeitos
 * assíncronos (chamadas à API partilhada, notificações). Os componentes de
 * UI nunca tocam em `dataStore` diretamente: chamam sempre uma função daqui.
 *
 * Estratégia de sincronização (cache inteligente):
 *  - toda a escrita atualiza primeiro o estado em memória (otimista);
 *  - a persistência real (para o servidor/Netlify Blobs, partilhado por
 *    todos os computadores) é "debounced" (350ms) para agrupar escritas
 *    rápidas consecutivas num só pedido à API;
 *  - o estado de sincronização (`syncStatus`) fica visível na sidebar;
 *  - `flushSync()` é forçado em `visibilitychange`/`beforeunload` para
 *    nunca perder a última alteração ao fechar ou trocar de separador;
 *  - `recarregarDoServidor()` vai buscar as alterações feitas por OUTROS
 *    computadores (chamado no arranque, ao voltar à aba, periodicamente,
 *    e no botão "Atualizar").
 */
import { bus } from "./events.js";
import { nowTs, uid } from "./utils.js";
import { CATEGORIA_INDEFINIDA_ID, CATEGORIAS_PADRAO } from "./domain.js";

function stripTransient(s) { const { blobUrl, ...rest } = s; return rest; }

export function createActions(store, dataStore) {
  let syncTimer = null;

  async function flushSync(reason) {
    clearTimeout(syncTimer);
    try {
      const st = store.getState();
      await dataStore.putAll("servicos", st.servicos.map(stripTransient));
      await dataStore.putAll("categorias", st.categorias);
      store.dispatch({ type: "SET_SYNC_STATUS", status: "synced" });
      bus.emit("sync:done", { reason });
    } catch (err) {
      console.error("Erro ao sincronizar dados:", err);
      store.dispatch({ type: "SET_SYNC_STATUS", status: "error" });
      bus.emit("toast:show", { type: "err", msg: "Falha ao guardar no servidor. As alterações ficam só neste separador até a ligação voltar." });
    }
  }
  function scheduleSync(reason) {
    store.dispatch({ type: "SET_SYNC_STATUS", status: "syncing" });
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => flushSync(reason), 350);
  }

  const actions = {
    async iniciar() {
      const [servicos, categorias, logoBase64, nomeFarmacia] = await Promise.all([
        dataStore.getAll("servicos"),
        dataStore.getAll("categorias"),
        dataStore.getConfig("logo"),
        dataStore.getConfig("nomeFarmacia")
      ]);
      store.dispatch({
        type: "INIT_STATE",
        payload: {
          servicos: servicos.map(s => ({ ...s, blobUrl: null })),
          categorias: categorias.length ? categorias : CATEGORIAS_PADRAO.slice(),
          logoBase64: logoBase64 || null,
          nomeFarmacia: nomeFarmacia || "Farmácia Alto dos Moinhos"
        }
      });
    },

    /**
     * Vai buscar o estado mais recente ao servidor e substitui o estado local
     * — usado para trazer alterações feitas noutros computadores. Só é
     * chamado quando é seguro (sem escrita pendente e fora do modal de
     * configurações), para nunca pisar uma edição a meio.
     */
    async recarregarDoServidor() {
      try {
        await dataStore.refresh();
        await actions.iniciar();
        bus.emit("sync:remote-refresh", {});
      } catch (err) {
        console.error("Erro ao atualizar a partir do servidor:", err);
        bus.emit("toast:show", { type: "err", msg: "Não foi possível contactar o servidor para atualizar." });
      }
    },

    setSearch(query) { store.dispatch({ type: "SET_SEARCH", query }); },
    setScope(scope) { store.dispatch({ type: "SET_SCOPE", scope }); },
    setSort(sortBy) { store.dispatch({ type: "SET_SORT", sortBy }); },
    setViewMode(viewMode) { store.dispatch({ type: "SET_VIEWMODE", viewMode }); },

    async setLogo(base64) {
      store.dispatch({ type: "SET_LOGO", logoBase64: base64 });
      await dataStore.setConfig("logo", base64);
      bus.emit("toast:show", { type: "ok", msg: "Logótipo atualizado." });
    },
    async setNomeFarmacia(nome) {
      store.dispatch({ type: "SET_NOME_FARMACIA", nome });
      await dataStore.setConfig("nomeFarmacia", nome);
    },

    async criarServico(dados) {
      const st = store.getState();
      const maxOrdem = st.servicos.reduce((m, s) => Math.max(m, s.ordem || 0), -1);
      const novo = {
        id: uid("srv"),
        nome: dados.nome, descricao: dados.descricao || "",
        tipo: dados.tipo, url: dados.tipo === "url" ? dados.url : null,
        htmlContent: dados.tipo === "html" ? dados.htmlContent : null,
        imagemBase64: dados.imagemBase64 || null, imagemUrl: dados.imagemUrl || null,
        categoriaId: dados.categoriaId || CATEGORIA_INDEFINIDA_ID,
        tags: dados.tags || [], favorito: !!dados.favorito, status: dados.status || "ativo",
        ordem: maxOrdem + 1, criadoEm: nowTs(), atualizadoEm: nowTs(), ultimoAcesso: null, contadorAcessos: 0
      };
      store.dispatch({ type: "ADD_SERVICO", servico: novo });
      scheduleSync("criar-servico");
      bus.emit("toast:show", { type: "ok", msg: `Serviço "${novo.nome}" adicionado.` });
      return novo;
    },

    async atualizarServico(id, dados) {
      store.dispatch({ type: "UPDATE_SERVICO", id, dados: { ...dados, atualizadoEm: nowTs() } });
      scheduleSync("atualizar-servico");
      const atualizado = store.getState().servicos.find(s => s.id === id);
      if (atualizado) bus.emit("toast:show", { type: "ok", msg: `Serviço "${atualizado.nome}" atualizado.` });
      return atualizado;
    },

    async removerServico(id) {
      const alvo = store.getState().servicos.find(s => s.id === id);
      store.dispatch({ type: "REMOVE_SERVICO", id });
      scheduleSync("remover-servico");
      if (alvo) bus.emit("toast:show", { type: "warn", msg: `Serviço "${alvo.nome}" removido.` });
    },

    async alternarFavorito(id) {
      store.dispatch({ type: "TOGGLE_FAVORITO", id });
      scheduleSync("favorito");
    },

    async reordenarServicos(fromId, toId) {
      store.dispatch({ type: "REORDER_SERVICOS", fromId, toId });
      scheduleSync("reordenar");
    },

    async registarAcesso(id) {
      store.dispatch({ type: "REGISTER_ACESSO", id });
      scheduleSync("acesso");
    },

    abrirEmNovaAba(id) {
      const st = store.getState();
      const serv = st.servicos.find(s => s.id === id);
      if (!serv) return;
      let url = null;
      if (serv.tipo === "url" && serv.url) {
        url = /^https?:\/\//i.test(serv.url) ? serv.url : "https://" + serv.url;
      } else if (serv.tipo === "html" && serv.htmlContent) {
        const blob = new Blob([serv.htmlContent], { type: "text/html" });
        url = URL.createObjectURL(blob);
      }
      if (url) { window.open(url, "_blank"); actions.registarAcesso(id); }
      else bus.emit("toast:show", { type: "err", msg: "Serviço sem conteúdo válido. Edite nas configurações." });
    },

    async criarCategoria(nome, cor, parentId = null, imagem = null) {
      const st = store.getState();
      const irmas = st.categorias.filter(c => c.parentId === parentId);
      const nova = { id: uid("cat"), nome, cor: cor || "#2b7a4b", imagem, parentId, ordem: irmas.length };
      store.dispatch({ type: "ADD_CATEGORIA", categoria: nova });
      scheduleSync("categoria-criada");
      bus.emit("toast:show", { type: "ok", msg: `Categoria "${nome}" criada.` });
      return nova;
    },
    async atualizarCategoria(id, dados) {
      store.dispatch({ type: "UPDATE_CATEGORIA", id, dados });
      scheduleSync("categoria-atualizada");
    },
    async removerCategoria(id) {
      store.dispatch({ type: "REMOVE_CATEGORIA", id });
      scheduleSync("categoria-removida");
      bus.emit("toast:show", { type: "warn", msg: "Categoria removida. Os serviços ficaram com 'Categoria Indefinida'." });
    },
    async reordenarCategorias(fromId, toId) {
      store.dispatch({ type: "REORDER_CATEGORIAS", fromId, toId });
      scheduleSync("categoria-reordenada");
    },

    exportarDados() {
      const st = store.getState();
      const payload = {
        versao: 4, exportadoEm: new Date().toISOString(),
        nomeFarmacia: st.nomeFarmacia, logoBase64: st.logoBase64,
        categorias: st.categorias, servicos: st.servicos.map(stripTransient)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `central-farmacia-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      bus.emit("toast:show", { type: "ok", msg: "Cópia de segurança exportada." });
    },

    async importarDados(file) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.servicos)) throw new Error("Ficheiro inválido.");
        const payload = {
          servicos: data.servicos,
          categorias: Array.isArray(data.categorias) && data.categorias.length ? data.categorias : store.getState().categorias,
          logoBase64: data.logoBase64 || store.getState().logoBase64,
          nomeFarmacia: data.nomeFarmacia || store.getState().nomeFarmacia
        };
        store.dispatch({ type: "IMPORT_DADOS", payload });
        await Promise.all([
          dataStore.putAll("servicos", payload.servicos),
          dataStore.putAll("categorias", payload.categorias),
          dataStore.setConfig("logo", payload.logoBase64),
          dataStore.setConfig("nomeFarmacia", payload.nomeFarmacia)
        ]);
        bus.emit("toast:show", { type: "ok", msg: "Dados importados com sucesso (visível em todos os computadores)." });
      } catch (err) {
        console.error("Erro ao importar:", err);
        bus.emit("toast:show", { type: "err", msg: "Erro ao importar ficheiro: " + err.message });
      }
    },

    async resetTudo() {
      await dataStore.clearAll();
      await dataStore.putAll("categorias", CATEGORIAS_PADRAO);
      store.dispatch({ type: "RESET_TUDO", categoriasPadrao: CATEGORIAS_PADRAO.slice() });
      bus.emit("toast:show", { type: "warn", msg: "Todos os dados foram repostos (em todos os computadores)." });
    },

    flushSync
  };

  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", () => { if (document.hidden && store.getState().syncStatus === "syncing") flushSync("visibilitychange"); });
    window.addEventListener("beforeunload", () => { if (store.getState().syncStatus === "syncing") flushSync("beforeunload"); });
  }

  return actions;
}
