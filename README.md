# Central Operacional — Farmácia Alto dos Moinhos

Ambiente de orquestração de serviços internos da farmácia (SOE — *Service
Orchestration Environment*). Front-end estático (sem passo de build), com
um pequeno backend serverless: os dados (serviços, categorias,
configurações) vivem no **Netlify Blobs**, partilhados por todos os
computadores que acedem ao site — não há armazenamento local por PC.

## Arquitetura

```
index.html                  shell da aplicação (sidebar + conteúdo principal + modais)
assets/
  styles.css                 folha de estilos única (tokens de design + componentes)
  dev-logo.png                logótipo fixo da assinatura "Desenvolvido por"
src/
  vdom.js                    motor de Virtual DOM leve (mount + diff/patch com keys)
  store.js                   store imutável (reducer puro + Object.freeze)
  actions.js                 única camada com efeitos assíncronos (dispatch + API partilhada)
  db.js                      cliente da API /api/data (Netlify Blobs) + migração de dados antigos
  domain.js                  regras de negócio puras (árvore de categorias, filtros, stats)
  events.js                  bus de eventos efémeros (toasts)
  icons.js                   conjunto de ícones SVG inline (zero dependências externas)
  utils.js                   funções puras auxiliares
  ui/
    sidebar.js                barra lateral: marca, estatísticas, árvore de categorias
    main-content.js            cartões de categoria + grelha de serviços (via vdom.js)
    modals.js                  modal de configurações (geral/serviços/categorias/dados)
    palette.js                 paleta de comandos (Ctrl+K)
    toast.js                   notificações
netlify/functions/
  data.js                     função serverless: GET/PUT /api/data (lê/escreve no Netlify Blobs)
tests/                       testes unitários e de integração (Node test runner)
sw.js                         service worker (cache do app-shell; NUNCA cacheia /api/*)
netlify.toml                  rotas, cabeçalhos de cache/segurança e config das funções
```

### Fluxo de dados

1. **UI** dispara uma ação (`actions.criarServico(...)`, `actions.setScope(...)`).
2. **actions.js** despacha uma ação pura para o `store` (estado novo,
   imutável, refletido de imediato na UI — "otimista") e agenda a
   persistência assíncrona (`scheduleSync`, *debounce* de 350ms) para o
   servidor via `db.js` → `PUT /api/data`.
3. A função `netlify/functions/data.js` grava esse JSON num blob único no
   Netlify Blobs. Qualquer outro computador que peça `GET /api/data` a
   partir desse momento já vê a alteração.
4. O `store` notifica os subscritores; `app.js` volta a renderizar a
   sidebar, a barra de navegação e o conteúdo principal a partir do novo
   estado.
5. A grelha de categorias/serviços é desenhada através do mini Virtual DOM
   (`vdom.js`), que faz *diffing* com *keys* para não recriar o DOM inteiro
   a cada pesquisa ou alteração.

### Sincronização entre computadores

Como não há WebSockets, a atualização entre postos de trabalho acontece:
- **ao carregar a página** (sempre vai buscar o estado mais recente);
- **ao voltar a esta aba** depois de estar em segundo plano;
- **a cada ~25 segundos**, em fundo, desde que não haja uma escrita
  pendente nem o modal de configurações aberto (para nunca interromper
  uma edição em curso);
- **no botão "Atualizar"** da barra superior, a pedido.

Não há resolução de conflitos sofisticada: a última escrita vence. Para o
uso normal de uma farmácia (poucas pessoas, edições pouco frequentes) isto
é suficiente e mantém o sistema simples.

### Porquê sem framework de build

A app corre diretamente como módulos ES nativos (`<script type="module">`),
sem passo de *bundling* no lado do site estático. Isto simplifica o
deployment no Netlify. O mini Virtual DOM e o `store` imutável dão os
benefícios de uma arquitetura reativa moderna sem essa complexidade
adicional. A única peça com um "build" implícito é a função serverless
(o Netlify empacota automaticamente as suas dependências, como
`@netlify/blobs`, a partir do `package.json`).

## Testes

```bash
npm install
npm test
```

Cobrem:
- `tests/domain.test.js` — árvore de categorias, filtros, prevenção de
  ciclos entre categoria/subcategoria, reatribuição ao eliminar categorias.
- `tests/store.test.js` — imutabilidade do estado, reducer puro, incluindo
  a reordenação de categorias (só entre irmãs do mesmo nível).
- `tests/vdom.test.js` — *mount*, *diffing* com *keys*, componentes
  funcionais, gestão de *listeners*, e um teste de regressão para o bug de
  conteúdo `html` a desaparecer em patches sucessivos.
- `tests/function.test.js` — lógica da função `/api/data` (GET/PUT,
  validação, códigos de erro), com uma implementação falsa do Blobs Store.
- `tests/integration.test.js` — ciclo de vida completo via `db.js` +
  `actions.js` contra uma API simulada, incluindo sincronização entre
  "computadores" e a migração automática de dados antigos (IndexedDB de
  versões anteriores) para o servidor partilhado.

## Desenvolvimento local

O front-end (`npm run dev`) serve os ficheiros estáticos, mas **não**
corre a função serverless — sem ela, `/api/data` não responde. Para testar
tudo localmente, incluindo a função, use a CLI do Netlify:

```bash
npm install -g netlify-cli   # uma vez
netlify dev                  # serve o site + as funções em localhost
```

## Deployment

### GitHub → Netlify (recomendado)

1. Faça *push* deste repositório para o GitHub.
2. Em [app.netlify.com](https://app.netlify.com), **Add new site → Import
   an existing project** e escolha o repositório.
3. Build command: deixe em branco (ou `true`). Publish directory: `.`
   — já está definido em `netlify.toml`, tal como a pasta das funções.
4. Deploy. O Netlify instala automaticamente `@netlify/blobs` (está no
   `package.json`) e cria a store do Blobs na primeira chamada à função.
5. **Não é preciso configurar nenhuma variável de ambiente.** Se tiver
   adicionado manualmente `BLOBS_STORE_NAME` ou `NETLIFY_AUTH_TOKEN` numa
   tentativa anterior, pode removê-las — o `getStore()` deteta o contexto
   do site automaticamente quando a função corre no Netlify.

### Deployment manual (arrastar e largar)

Arraste a pasta do projeto para
[app.netlify.com/drop](https://app.netlify.com/drop). As funções em
`netlify/functions/` são publicadas automaticamente.

## Notas de desempenho/rede

- **Zero dependências de terceiros** no front-end: sem CDN de fontes ou
  ícones (SVG inline em `src/icons.js`).
- **Service worker** (`sw.js`) com *cache* do *app-shell*: HTML em
  *network-first*, CSS/JS em *stale-while-revalidate*. O endpoint
  `/api/data` está explicitamente excluído do cache do service worker,
  para nunca mostrar dados desatualizados.
- **Cabeçalhos** (`netlify.toml`): CSP estrita, `Cache-Control` ajustado
  por tipo de ficheiro, `/api/*` sempre `no-store`.
- **Escritas otimistas e agrupadas**: as alterações aparecem de imediato
  na interface e são persistidas no servidor de forma assíncrona e
  agrupada (*debounce*), com indicador de sincronização na sidebar.

## Esquema de dados (Netlify Blobs)

Um único blob (`estado`, na store `central-farmacia`) com:

```json
{
  "servicos": [ { "id", "nome", "descricao", "tipo", "url"|"htmlContent",
                  "imagemBase64"|"imagemUrl", "categoriaId", "tags[]",
                  "favorito", "status", "ordem", "criadoEm", "atualizadoEm",
                  "ultimoAcesso", "contadorAcessos" } ],
  "categorias": [ { "id", "nome", "cor", "imagem", "parentId", "ordem" } ],
  "config": { "logo": "...", "nomeFarmacia": "..." }
}
```

`parentId` permite subcategorias ilimitadas. Serviços cuja categoria foi
eliminada ficam com `categoriaId: "cat_indefinida"` ("Categoria
Indefinida"). A vinheta "Desenvolvido por" (logótipo e nome) já não faz
parte deste esquema — está fixa no código (`src/ui/sidebar.js` +
`assets/dev-logo.png`), não é editável pela farmácia.

### Migração automática de dados antigos

Se este computador tiver dados de uma versão anterior (guardados em
IndexedDB, local ao browser) e o servidor ainda estiver vazio, esses dados
são enviados automaticamente para o Netlify Blobs na primeira abertura —
uma única vez — para não perder trabalho já feito. Depois disso, a app
passa a usar sempre o servidor partilhado.
