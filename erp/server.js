'use strict';
/*
 * Potato ERP: servidor local (Node 22+, sem dependências).
 *   - recebe os eventos do simulador 3D em POST /api/ingest e grava em SQLite (dados/erp.db)
 *   - responde as consultas analíticas em /api/q/<nome> (cada uma devolve também o SQL usado)
 *   - empurra avisos em tempo real para as telas via Server-Sent Events (/api/stream)
 *   - serve a interface do ERP em "/" e o simulador 3D em "/sim/"
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SIM = path.join(__dirname, '..', 'simulacao-3d');
const DB_PATH = path.join(__dirname, 'dados', 'erp.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ───────────────────────── Banco de dados ─────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, iniciado_em TEXT, ultimo_ts INTEGER, ultimo_recebimento INTEGER);

CREATE TABLE IF NOT EXISTS dim_fornecedores (
  fornecedor_id TEXT PRIMARY KEY, nome TEXT);

CREATE TABLE IF NOT EXISTS eventos (
  run_id TEXT, batata_id TEXT, event_ts INTEGER, linha_id TEXT, lote_id TEXT, fornecedor_id TEXT, turno TEXT, operador_id TEXT,
  peso_g REAL, diametro_mm REAL, cor_matiz REAL, area_defeito_pct REAL, velocidade_esteira REAL,
  classificacao TEXT, confianca REAL, tipo_defeito TEXT, corpo_estranho INTEGER, sensor_id TEXT,
  classificacao_final TEXT, inspetor_id TEXT, rotulo_ts INTEGER,
  PRIMARY KEY (run_id, batata_id));
CREATE INDEX IF NOT EXISTS ix_eventos_ts ON eventos(run_id, event_ts);
CREATE INDEX IF NOT EXISTS ix_eventos_lote ON eventos(run_id, lote_id);

CREATE TABLE IF NOT EXISTS compras (
  run_id TEXT, lote_id TEXT, fornecedor_id TEXT, ts INTEGER, caixas INTEGER, batatas INTEGER,
  PRIMARY KEY (run_id, lote_id));

CREATE TABLE IF NOT EXISTS expedicao (
  run_id TEXT, seq INTEGER, carga_id INTEGER, ts INTEGER, tipo TEXT, volumes INTEGER,
  PRIMARY KEY (run_id, seq));

CREATE TABLE IF NOT EXISTS manutencao (
  run_id TEXT, os_id INTEGER, tipo TEXT, inicio_ts INTEGER, fim_ts INTEGER,
  PRIMARY KEY (run_id, os_id));

CREATE TABLE IF NOT EXISTS sensor_saude (
  run_id TEXT, seq INTEGER, ts INTEGER, sensor_id TEXT, calibracao REAL,
  PRIMARY KEY (run_id, seq));

CREATE TABLE IF NOT EXISTS estoque_snap (
  run_id TEXT, seq INTEGER, ts INTEGER, mp_caixas INTEGER, tremonha INTEGER, expedicao INTEGER, estoque INTEGER, caminhao INTEGER,
  PRIMARY KEY (run_id, seq));
`);
for (const [tab, col] of [['dim_fornecedores', 'preco_kg'], ['compras', 'custo'], ['expedicao', 'receita'], ['manutencao', 'custo']]) {
  if (db.prepare(`PRAGMA table_info(${tab})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${tab} DROP COLUMN ${col}`);
}
db.exec('DROP TABLE IF EXISTS financeiro');
// fornecedores conhecidos do simulador: cadastro garantido mesmo que o simulador já estivesse aberto antes do ERP
for (const [id, nome] of [['F-01', 'Fazenda Sol'], ['F-02', 'Agro Vale'], ['F-03', 'Terra Boa']]) db.prepare('INSERT OR IGNORE INTO dim_fornecedores (fornecedor_id, nome) VALUES (?,?)').run(id, nome);
// colunas novas da manutenção (banco criado antes dos setores novos é migrado)
for (const [col, tipo] of [['chamado_ts', 'INTEGER'], ['chegada_ts', 'INTEGER'], ['peca', 'TEXT'], ['espera_peca_min', 'INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(manutencao)').all().some(c => c.name === col)) db.exec(`ALTER TABLE manutencao ADD COLUMN ${col} ${tipo}`);
}
// tabelas dos setores novos: a chave do corpo do POST, o nome, as colunas (nome, tipo) e a chave primária (além de run_id)
const GEN = [
  { k: 'lab', tabela: 'lab_analises', pk: ['lote_id'], cols: [['lote_id', 'TEXT'], ['fornecedor_id', 'TEXT'], ['ts', 'INTEGER'], ['materia_seca_pct', 'REAL'], ['acucar_pct', 'REAL'], ['umidade_pct', 'REAL'], ['resultado', 'TEXT']] },
  { k: 'armazem', tabela: 'armazem_temp', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['temp_c', 'REAL'], ['compressor', 'INTEGER'], ['falha', 'INTEGER'], ['caixas', 'INTEGER'], ['idade_max_min', 'INTEGER'], ['deterioracao_max', 'REAL'], ['caixas_descartadas', 'INTEGER']] },
  { k: 'perdas', tabela: 'armazem_perdas', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['lote_id', 'TEXT'], ['fornecedor_id', 'TEXT'], ['batatas', 'INTEGER'], ['motivo', 'TEXT']] },
  { k: 'rastreio', tabela: 'rastreio', pk: ['seq'], cols: [['seq', 'INTEGER'], ['palete_id', 'INTEGER'], ['carga_id', 'INTEGER'], ['lote_id', 'TEXT'], ['tipo', 'TEXT'], ['batatas', 'INTEGER'], ['volumes', 'INTEGER'], ['formado_ts', 'INTEGER'], ['carregado_ts', 'INTEGER']] },
  { k: 'utilidades', tabela: 'utilidades', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['setor', 'TEXT'], ['kwh', 'REAL'], ['agua_l', 'REAL']] },
  { k: 'pecas', tabela: 'pecas', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['peca', 'TEXT'], ['evento', 'TEXT'], ['estoque', 'INTEGER']] },
  { k: 'residuos', tabela: 'residuos', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['destino', 'TEXT'], ['kg', 'REAL'], ['origem', 'TEXT'], ['tipo', 'TEXT']] },
  { k: 'processamento', tabela: 'processamento', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['lote_id', 'TEXT'], ['batata_id', 'TEXT'], ['entrada_g', 'REAL'], ['casca_g', 'REAL'], ['apara_g', 'REAL'], ['saida_g', 'REAL']] },
  { k: 'pedidos', tabela: 'pedidos', pk: ['pedido_id'], cols: [['pedido_id', 'TEXT'], ['cliente', 'TEXT'], ['criado_ts', 'INTEGER'], ['prazo_ts', 'INTEGER'], ['paletes', 'INTEGER'], ['atendidos', 'INTEGER'], ['status', 'TEXT'], ['fechado_ts', 'INTEGER']] },
  { k: 'entregas', tabela: 'entregas', pk: ['seq'], cols: [['seq', 'INTEGER'], ['pedido_id', 'TEXT'], ['carga_id', 'INTEGER'], ['ts', 'INTEGER'], ['paletes', 'INTEGER'], ['atraso_min', 'INTEGER']] },
  { k: 'escala', tabela: 'escala', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['turno', 'TEXT'], ['inspetores', 'INTEGER'], ['operador_id', 'TEXT']] },
  { k: 'recalls', tabela: 'recalls', pk: ['seq'], cols: [['seq', 'INTEGER'], ['ts', 'INTEGER'], ['lote_id', 'TEXT'], ['paletes_na_fabrica', 'INTEGER'], ['paletes_expedidos', 'INTEGER'], ['cargas', 'TEXT']] },
];
for (const g of GEN) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${g.tabela} (run_id TEXT, ${g.cols.map(([n, ty]) => n + ' ' + ty).join(', ')}, PRIMARY KEY (run_id, ${g.pk.join(', ')}))`);
  g.stmt = db.prepare(`INSERT OR REPLACE INTO ${g.tabela} (run_id, ${g.cols.map(c => c[0]).join(', ')}) VALUES (?${',?'.repeat(g.cols.length)})`);
}
const TABELAS = ['eventos', 'compras', 'expedicao', 'manutencao', 'sensor_saude', 'estoque_snap', ...GEN.map(g => g.tabela), 'dim_fornecedores', 'runs'];

const P = {
  run: db.prepare(`INSERT INTO runs(run_id, iniciado_em, ultimo_ts, ultimo_recebimento) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET ultimo_ts = MAX(ultimo_ts, excluded.ultimo_ts), ultimo_recebimento = excluded.ultimo_recebimento`),
  forn: db.prepare('INSERT OR REPLACE INTO dim_fornecedores (fornecedor_id, nome) VALUES (?,?)'),
  evento: db.prepare(`INSERT OR REPLACE INTO eventos (run_id, batata_id, event_ts, linha_id, lote_id, fornecedor_id, turno, operador_id, peso_g, diametro_mm,
    cor_matiz, area_defeito_pct, velocidade_esteira, classificacao, confianca, tipo_defeito, corpo_estranho, sensor_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  rotulo: db.prepare('UPDATE eventos SET classificacao_final = ?, inspetor_id = ?, rotulo_ts = ? WHERE run_id = ? AND batata_id = ?'),
  compra: db.prepare('INSERT OR REPLACE INTO compras (run_id, lote_id, fornecedor_id, ts, caixas, batatas) VALUES (?,?,?,?,?,?)'),
  exped: db.prepare('INSERT OR REPLACE INTO expedicao (run_id, seq, carga_id, ts, tipo, volumes) VALUES (?,?,?,?,?,?)'),
  manut: db.prepare('INSERT OR REPLACE INTO manutencao (run_id, os_id, tipo, inicio_ts, fim_ts, chamado_ts, chegada_ts, peca, espera_peca_min) VALUES (?,?,?,?,?,?,?,?,?)'),
  sensor: db.prepare('INSERT OR REPLACE INTO sensor_saude VALUES (?,?,?,?,?)'),
  estoque: db.prepare('INSERT OR REPLACE INTO estoque_snap VALUES (?,?,?,?,?,?,?,?)'),
};
const arr = x => Array.isArray(x) ? x : [];
const num = v => (v === null || v === undefined || v === '') ? null : +v;

function ingest(b) {
  const run = String(b.run_id || '').slice(0, 40);
  if (!run) throw new Error('run_id obrigatório');
  db.exec('BEGIN');
  try {
    P.run.run(run, b.iniciado_em || null, num(b.ts) || 0, Date.now());
    for (const f of arr(b.dim && b.dim.fornecedores)) P.forn.run(f.fornecedor_id, f.nome);
    for (const e of arr(b.eventos)) {
      P.evento.run(run, e.batata_id, num(e.event_timestamp), e.linha_id, e.lote_id, e.fornecedor_id, e.turno, e.operador_id, num(e.peso_g), num(e.diametro_mm),
        num(e.cor_matiz), num(e.area_defeito_pct), num(e.velocidade_esteira), e.classificacao, num(e.confianca), e.tipo_defeito, e.corpo_estranho ? 1 : 0, e.sensor_id);
    }
    for (const r of arr(b.rotulos)) P.rotulo.run(r.classificacao_final, r.inspetor_id, num(r.decisao_ts), run, r.batata_id);
    for (const c of arr(b.compras)) P.compra.run(run, c.lote_id, c.fornecedor_id, num(c.ts), num(c.caixas), num(c.batatas));
    for (const x of arr(b.expedicao)) P.exped.run(run, num(x.seq), num(x.carga_id), num(x.ts), x.tipo, num(x.volumes));
    for (const m of arr(b.manutencao)) P.manut.run(run, num(m.os_id), m.tipo, num(m.inicio_ts), num(m.fim_ts), num(m.chamado_ts), num(m.chegada_ts), m.peca ?? null, num(m.espera_peca_min));
    for (const g of GEN) for (const r of arr(b[g.k])) g.stmt.run(run, ...g.cols.map(([n, ty]) => ty === 'TEXT' ? (r[n] ?? null) : num(r[n])));
    for (const s of arr(b.sensor)) P.sensor.run(run, num(s.seq), num(s.ts), s.sensor_id, num(s.calibracao));
    for (const s of arr(b.estoque)) P.estoque.run(run, num(s.seq), num(s.ts), num(s.mp_caixas), num(s.tremonha), num(s.expedicao), num(s.estoque), num(s.caminhao));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { run, eventos: arr(b.eventos).length };
}

// ───────────────────────── Consultas analíticas ─────────────────────────
// Cada pergunta de negócio vira uma consulta SQL; a resposta devolve o SQL junto, para a tela poder mostrá-lo.
const REFUGO = `(classificacao = 'RUIM' OR classificacao_final = 'RUIM')`;
const BOM = `((classificacao = 'BOA' AND COALESCE(classificacao_final, 'BOA') = 'BOA') OR classificacao_final = 'BOA')`;
const bucket = (col, b) => `(${col} / ${b * 60000}) * ${b * 60000}`;
const QUERIES = {
  producao_tempo: ({ b }) => `
SELECT ${bucket('event_ts', b)} AS t, turno,
       SUM(classificacao = 'BOA') AS boa, SUM(classificacao = 'SUSPEITA') AS suspeita, SUM(classificacao = 'RUIM') AS ruim, COUNT(*) AS total
FROM eventos WHERE run_id = ? GROUP BY t, turno ORDER BY t`,
  producao_turno: () => `
SELECT turno, COUNT(*) AS total,
       ROUND(100.0 * SUM(classificacao = 'BOA') / COUNT(*), 1) AS pct_boa,
       ROUND(100.0 * SUM(classificacao = 'SUSPEITA') / COUNT(*), 1) AS pct_suspeita,
       ROUND(100.0 * SUM(classificacao = 'RUIM') / COUNT(*), 1) AS pct_ruim
FROM eventos WHERE run_id = ? GROUP BY turno ORDER BY turno`,
  paradas: () => `
SELECT os_id, tipo, inicio_ts, fim_ts, ROUND((fim_ts - inicio_ts) / 60000.0, 1) AS duracao_min, chamado_ts, chegada_ts, peca, espera_peca_min
FROM manutencao WHERE run_id = ? ORDER BY inicio_ts`,
  refugo_lote: () => `
SELECT lote_id, fornecedor_id, MIN(event_ts) AS t0, COUNT(*) AS n,
       ROUND(100.0 * SUM(CASE WHEN ${REFUGO} THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_refugo,
       ROUND(100.0 * SUM(classificacao = 'SUSPEITA') / COUNT(*), 1) AS pct_suspeita
FROM eventos WHERE run_id = ? GROUP BY lote_id, fornecedor_id HAVING n >= 5 ORDER BY t0`,
  confusao_suspeitas: () => `
SELECT CASE WHEN confianca < 0.5 THEN '< 0,50' WHEN confianca < 0.6 THEN '0,50 a 0,60' ELSE '>= 0,60' END AS faixa,
       classificacao_final AS rotulo_final, COUNT(*) AS n
FROM eventos WHERE run_id = ? AND classificacao = 'SUSPEITA' AND classificacao_final IS NOT NULL GROUP BY faixa, rotulo_final`,
  aprovacao_tempo: ({ b }) => `
SELECT ${bucket('event_ts', b)} AS t, COUNT(*) AS n, SUM(classificacao_final = 'BOA') AS aprovadas,
       ROUND(100.0 * SUM(classificacao_final = 'BOA') / COUNT(*), 1) AS pct_aprovadas
FROM eventos WHERE run_id = ? AND classificacao = 'SUSPEITA' AND classificacao_final IS NOT NULL GROUP BY t ORDER BY t`,
  calibracao: () => `SELECT ts, calibracao FROM sensor_saude WHERE run_id = ? ORDER BY ts`,
  fornecedores: () => `
SELECT e.fornecedor_id, d.nome, COUNT(*) AS n,
       ROUND(SUM(e.peso_g) / 1000.0, 2) AS kg,
       ROUND(SUM(CASE WHEN ${REFUGO.replace(/classificacao/g, 'e.classificacao')} THEN e.peso_g ELSE 0 END) / 1000.0, 2) AS kg_refugo,
       ROUND(SUM(CASE WHEN ${BOM.replace(/classificacao/g, 'e.classificacao')} THEN e.peso_g ELSE 0 END) / 1000.0, 2) AS kg_aproveitado,
       ROUND(100.0 * SUM(CASE WHEN ${REFUGO.replace(/classificacao/g, 'e.classificacao')} THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_refugo,
       ROUND(100.0 * SUM(e.classificacao = 'SUSPEITA') / COUNT(*), 1) AS pct_suspeita,
       ROUND(100.0 * SUM(e.corpo_estranho) / COUNT(*), 1) AS pct_corpo,
       ROUND(100.0 * SUM(CASE WHEN ${BOM.replace(/classificacao/g, 'e.classificacao')} THEN e.peso_g ELSE 0 END) / SUM(e.peso_g), 1) AS pct_aproveitado
FROM eventos e JOIN dim_fornecedores d ON d.fornecedor_id = e.fornecedor_id WHERE e.run_id = ? GROUP BY e.fornecedor_id ORDER BY pct_aproveitado DESC`,
  rendimento_tempo: ({ b }) => `
SELECT ${bucket('event_ts', b)} AS t, COUNT(*) AS n, ROUND(SUM(peso_g) / 1000.0, 2) AS kg,
       ROUND(SUM(CASE WHEN ${BOM} THEN peso_g ELSE 0 END) / 1000.0, 2) AS kg_aproveitado,
       ROUND(SUM(CASE WHEN ${REFUGO} THEN peso_g ELSE 0 END) / 1000.0, 2) AS kg_refugo,
       ROUND(100.0 * SUM(CASE WHEN ${BOM} THEN peso_g ELSE 0 END) / SUM(peso_g), 1) AS pct_aproveitado
FROM eventos WHERE run_id = ? GROUP BY t ORDER BY t`,
  expedicao_tempo: ({ b }) => `
SELECT ${bucket('ts', b)} AS t, COUNT(*) AS paletes, SUM(volumes) AS volumes,
       SUM(CASE WHEN tipo = 'sacos' THEN volumes ELSE 0 END) AS sacos, SUM(CASE WHEN tipo = 'caixas' THEN volumes ELSE 0 END) AS caixas
FROM expedicao WHERE run_id = ? GROUP BY t ORDER BY t`,
  sensor_cor: ({ b }) => `
SELECT ${bucket('event_ts', b)} AS t, COUNT(*) AS n, ROUND(AVG(cor_matiz), 2) AS media,
       ROUND(SQRT(MAX(0, AVG(cor_matiz * cor_matiz) - AVG(cor_matiz) * AVG(cor_matiz))), 2) AS desvio
FROM eventos WHERE run_id = ? AND tipo_defeito = 'nenhum' AND corpo_estranho = 0 GROUP BY t HAVING n >= 3 ORDER BY t`,
  compras_lista: () => `
SELECT c.lote_id, c.fornecedor_id, d.nome, c.ts, c.caixas, c.batatas,
       (SELECT COUNT(*) FROM eventos e WHERE e.run_id = c.run_id AND e.lote_id = c.lote_id) AS processadas
FROM compras c JOIN dim_fornecedores d ON d.fornecedor_id = c.fornecedor_id WHERE c.run_id = ? ORDER BY c.ts DESC LIMIT 100`,
  expedicao_lista: () => `
SELECT carga_id, MIN(ts) AS ts, COUNT(*) AS paletes, SUM(volumes) AS volumes,
       SUM(CASE WHEN tipo = 'sacos' THEN volumes ELSE 0 END) AS sacos, SUM(CASE WHEN tipo = 'caixas' THEN volumes ELSE 0 END) AS caixas
FROM expedicao WHERE run_id = ? GROUP BY carga_id ORDER BY carga_id DESC`,
  estoque_tempo: () => `SELECT ts, mp_caixas, tremonha, expedicao, estoque, caminhao FROM estoque_snap WHERE run_id = ? ORDER BY ts`,

  // ── Laboratório
  lab_lotes: () => `
SELECT l.lote_id, l.fornecedor_id, d.nome, l.ts, l.materia_seca_pct, l.acucar_pct, l.umidade_pct, l.resultado,
       (SELECT COUNT(*) FROM eventos e WHERE e.run_id = l.run_id AND e.lote_id = l.lote_id) AS n,
       (SELECT ROUND(100.0 * SUM(CASE WHEN ${REFUGO.replace(/classificacao/g, 'e.classificacao')} THEN 1 ELSE 0 END) / COUNT(*), 1) FROM eventos e WHERE e.run_id = l.run_id AND e.lote_id = l.lote_id) AS pct_refugo
FROM lab_analises l JOIN dim_fornecedores d ON d.fornecedor_id = l.fornecedor_id WHERE l.run_id = ? ORDER BY l.ts`,
  lab_fornecedor: () => `
SELECT l.fornecedor_id, d.nome, COUNT(*) AS lotes, ROUND(AVG(l.materia_seca_pct), 2) AS materia_seca, ROUND(AVG(l.acucar_pct), 3) AS acucar, ROUND(AVG(l.umidade_pct), 2) AS umidade,
       SUM(l.resultado = 'APROVADO') AS aprovados, SUM(l.resultado = 'RESSALVA') AS ressalvas, SUM(l.resultado = 'REPROVADO') AS reprovados
FROM lab_analises l JOIN dim_fornecedores d ON d.fornecedor_id = l.fornecedor_id WHERE l.run_id = ? GROUP BY l.fornecedor_id ORDER BY acucar`,

  // ── Armazém frio
  armazem_tempo: () => `SELECT ts, temp_c, compressor, falha, caixas, idade_max_min, deterioracao_max, caixas_descartadas FROM armazem_temp WHERE run_id = ? ORDER BY ts`,
  armazem_perdas: () => `SELECT seq, ts, lote_id, fornecedor_id, batatas, motivo FROM armazem_perdas WHERE run_id = ? ORDER BY ts DESC`,
  armazem_resumo: () => `
SELECT ROUND(AVG(temp_c), 1) AS temp_media, ROUND(MAX(temp_c), 1) AS temp_max, ROUND(100.0 * SUM(temp_c > 9) / COUNT(*), 1) AS pct_tempo_acima_9,
       MAX(idade_max_min) AS idade_max_min, ROUND(MAX(deterioracao_max), 2) AS deterioracao_max, MAX(caixas_descartadas) AS caixas_descartadas
FROM armazem_temp WHERE run_id = ?`,

  // ── Rastreabilidade (use ?lote=L-005)
  rastreio_lotes: () => `
SELECT lote_id, COUNT(DISTINCT palete_id) AS paletes, COUNT(DISTINCT carga_id) AS cargas, SUM(batatas) AS batatas, MIN(carregado_ts) AS primeira_saida, MAX(carregado_ts) AS ultima_saida
FROM rastreio WHERE run_id = ? GROUP BY lote_id ORDER BY lote_id`,
  rastreio_lote: () => `
SELECT palete_id, carga_id, tipo, batatas, volumes, formado_ts, carregado_ts
FROM rastreio WHERE run_id = ? AND lote_id = :lote ORDER BY carregado_ts`,
  rastreio_cargas: () => `
SELECT carga_id, COUNT(DISTINCT palete_id) AS paletes, COUNT(DISTINCT lote_id) AS lotes, GROUP_CONCAT(DISTINCT lote_id) AS lista_lotes, MIN(carregado_ts) AS ts
FROM rastreio WHERE run_id = ? GROUP BY carga_id ORDER BY carga_id DESC`,
  recalls_lista: () => `SELECT ts, lote_id, paletes_na_fabrica, paletes_expedidos, cargas FROM recalls WHERE run_id = ? ORDER BY ts DESC`,

  // ── Utilidades
  util_setor: () => `
SELECT setor, ROUND(SUM(kwh), 2) AS kwh, ROUND(SUM(agua_l), 0) AS agua_l FROM utilidades WHERE run_id = ? GROUP BY setor ORDER BY kwh DESC`,
  util_tempo: ({ b }) => `
SELECT ${bucket('ts', b)} AS t, ROUND(SUM(kwh), 2) AS kwh, ROUND(SUM(agua_l), 0) AS agua_l FROM utilidades WHERE run_id = ? GROUP BY t ORDER BY t`,
  util_eficiencia: ({ b }) => `
SELECT u.t, ROUND(u.kwh, 2) AS kwh, ROUND(u.agua_l, 0) AS agua_l, ROUND(e.kg, 2) AS kg,
       ROUND(u.kwh / NULLIF(e.kg, 0), 3) AS kwh_por_kg, ROUND(u.agua_l / NULLIF(e.kg, 0), 2) AS l_por_kg
FROM (SELECT ${bucket('ts', b)} AS t, SUM(kwh) AS kwh, SUM(agua_l) AS agua_l FROM utilidades WHERE run_id = ? GROUP BY t) u
JOIN (SELECT ${bucket('event_ts', b)} AS t, SUM(peso_g) / 1000.0 AS kg FROM eventos WHERE run_id = ? GROUP BY t) e ON e.t = u.t ORDER BY u.t`,

  // ── Oficina e peças
  manut_kpi: () => `
SELECT tipo, COUNT(*) AS ocorrencias,
       ROUND((MAX(inicio_ts) - MIN(inicio_ts)) / 60000.0 / NULLIF(COUNT(*) - 1, 0), 0) AS mtbf_min,
       ROUND(AVG((fim_ts - inicio_ts) / 60000.0), 1) AS mttr_min,
       ROUND(AVG((chamado_ts - inicio_ts) / 60000.0), 1) AS deteccao_min,
       ROUND(AVG((chegada_ts - chamado_ts) / 60000.0), 1) AS deslocamento_min,
       ROUND(AVG(espera_peca_min), 1) AS espera_peca_min,
       ROUND(AVG((fim_ts - chegada_ts) / 60000.0), 1) AS reparo_min
FROM manutencao WHERE run_id = ? AND fim_ts IS NOT NULL GROUP BY tipo ORDER BY mttr_min DESC`,
  pecas_eventos: () => `SELECT ts, peca, evento, estoque FROM pecas WHERE run_id = ? ORDER BY ts`,
  pecas_consumo: () => `
SELECT peca, SUM(evento = 'consumo') AS usadas, SUM(evento = 'pedido') AS pedidos, SUM(evento = 'chegada') AS chegadas, MIN(estoque) AS estoque_minimo
FROM pecas WHERE run_id = ? GROUP BY peca ORDER BY usadas DESC`,

  // ── Resíduos
  residuos_destino: () => `
SELECT destino, ROUND(SUM(CASE WHEN tipo = 'geracao' THEN kg ELSE 0 END), 2) AS kg, SUM(tipo = 'coleta') AS coletas FROM residuos WHERE run_id = ? GROUP BY destino ORDER BY kg DESC`,
  residuos_origem: () => `
SELECT origem, destino, ROUND(SUM(kg), 2) AS kg FROM residuos WHERE run_id = ? AND tipo = 'geracao' GROUP BY origem, destino ORDER BY kg DESC`,
  residuos_tempo: ({ b }) => `
SELECT ${bucket('ts', b)} AS t, destino, ROUND(SUM(kg), 2) AS kg FROM residuos WHERE run_id = ? AND tipo = 'geracao' GROUP BY t, destino ORDER BY t`,

  // ── Processamento (descasque e corte)
  proc_etapas: () => `
SELECT COUNT(*) AS batatas, ROUND(SUM(entrada_g) / 1000.0, 2) AS entrada_kg, ROUND(SUM(casca_g) / 1000.0, 2) AS casca_kg, ROUND(SUM(apara_g) / 1000.0, 2) AS apara_kg,
       ROUND(SUM(saida_g) / 1000.0, 2) AS saida_kg, ROUND(100.0 * SUM(casca_g) / SUM(entrada_g), 1) AS pct_casca, ROUND(100.0 * SUM(apara_g) / SUM(entrada_g), 1) AS pct_apara,
       ROUND(100.0 * SUM(saida_g) / SUM(entrada_g), 1) AS rendimento
FROM processamento WHERE run_id = ?`,
  proc_lote: () => `
SELECT p.lote_id, d.nome, COUNT(*) AS batatas, ROUND(SUM(p.entrada_g) / 1000.0, 2) AS entrada_kg, ROUND(100.0 * SUM(p.casca_g + p.apara_g) / SUM(p.entrada_g), 1) AS pct_perda,
       ROUND(100.0 * SUM(p.saida_g) / SUM(p.entrada_g), 1) AS rendimento
FROM processamento p JOIN (SELECT DISTINCT lote_id, fornecedor_id FROM eventos WHERE run_id = ?) x ON x.lote_id = p.lote_id JOIN dim_fornecedores d ON d.fornecedor_id = x.fornecedor_id
WHERE p.run_id = ? GROUP BY p.lote_id ORDER BY p.lote_id`,
  proc_tempo: ({ b }) => `
SELECT ${bucket('ts', b)} AS t, COUNT(*) AS batatas, ROUND(SUM(entrada_g) / 1000.0, 2) AS entrada_kg, ROUND(SUM(saida_g) / 1000.0, 2) AS saida_kg,
       ROUND(SUM(casca_g + apara_g) / 1000.0, 2) AS perda_kg FROM processamento WHERE run_id = ? GROUP BY t ORDER BY t`,

  // ── Turnos e pessoas
  turno_resumo: () => `
SELECT turno, COUNT(*) AS batatas, ROUND(1.0 * COUNT(*) / COUNT(DISTINCT event_ts / 3600000), 1) AS vazao_h,
       ROUND(100.0 * SUM(CASE WHEN ${REFUGO} THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_refugo, ROUND(100.0 * SUM(classificacao = 'SUSPEITA') / COUNT(*), 1) AS pct_suspeita,
       SUM(classificacao_final IS NOT NULL) AS inspecionadas,
       ROUND(100.0 * SUM(classificacao_final = 'RUIM') / NULLIF(SUM(classificacao_final IS NOT NULL), 0), 1) AS pct_reprovadas
FROM eventos WHERE run_id = ? GROUP BY turno ORDER BY turno`,
  turno_inspetor: () => `
SELECT turno, inspetor_id, COUNT(*) AS inspecoes, ROUND(100.0 * SUM(classificacao_final = 'RUIM') / COUNT(*), 1) AS pct_reprovadas
FROM eventos WHERE run_id = ? AND classificacao_final IS NOT NULL GROUP BY turno, inspetor_id ORDER BY turno, inspetor_id`,
  turno_paradas: () => `
SELECT CASE WHEN CAST(strftime('%H', inicio_ts / 1000, 'unixepoch') AS INTEGER) BETWEEN 6 AND 13 THEN 'A' WHEN CAST(strftime('%H', inicio_ts / 1000, 'unixepoch') AS INTEGER) BETWEEN 14 AND 21 THEN 'B' ELSE 'C' END AS turno,
       COUNT(*) AS paradas, ROUND(SUM((fim_ts - inicio_ts) / 60000.0), 1) AS minutos_parados
FROM manutencao WHERE run_id = ? GROUP BY turno ORDER BY turno`,
  escala_lista: () => `SELECT ts, turno, inspetores, operador_id FROM escala WHERE run_id = ? ORDER BY ts DESC LIMIT 30`,

  // ── Pedidos e entregas
  pedidos_lista: () => `
SELECT pedido_id, cliente, criado_ts, prazo_ts, paletes, atendidos, status, fechado_ts,
       CASE WHEN fechado_ts IS NOT NULL THEN MAX(0, ROUND((fechado_ts - prazo_ts) / 60000.0)) END AS atraso_min
FROM pedidos WHERE run_id = ? ORDER BY criado_ts DESC LIMIT 100`,
  otif_resumo: () => `
SELECT COUNT(*) AS pedidos, SUM(status = 'entregue') AS entregues, SUM(status = 'entregue' AND fechado_ts <= prazo_ts) AS no_prazo,
       ROUND(100.0 * SUM(status = 'entregue' AND fechado_ts <= prazo_ts) / NULLIF(SUM(status = 'entregue'), 0), 1) AS pct_no_prazo,
       ROUND(AVG(CASE WHEN status = 'entregue' AND fechado_ts > prazo_ts THEN (fechado_ts - prazo_ts) / 60000.0 END), 0) AS atraso_medio_min,
       SUM(status = 'atrasado') AS atrasados_abertos
FROM pedidos WHERE run_id = ?`,
  pedidos_cliente: () => `
SELECT cliente, COUNT(*) AS pedidos, SUM(status = 'entregue') AS entregues, SUM(status = 'entregue' AND fechado_ts <= prazo_ts) AS no_prazo,
       ROUND(100.0 * SUM(status = 'entregue' AND fechado_ts <= prazo_ts) / NULLIF(SUM(status = 'entregue'), 0), 1) AS pct_no_prazo
FROM pedidos WHERE run_id = ? GROUP BY cliente ORDER BY pedidos DESC`,
  pedidos_backlog: () => `
WITH h AS (SELECT DISTINCT (ts / 3600000) * 3600000 AS t FROM estoque_snap WHERE run_id = ?)
SELECT h.t, (SELECT COUNT(*) FROM pedidos p WHERE p.run_id = ? AND p.criado_ts <= h.t AND (p.fechado_ts IS NULL OR p.fechado_ts > h.t)) AS abertos,
       (SELECT COUNT(*) FROM pedidos p WHERE p.run_id = ? AND p.prazo_ts < h.t AND (p.fechado_ts IS NULL OR p.fechado_ts > h.t)) AS atrasados
FROM h ORDER BY h.t`,
  entregas_lista: () => `SELECT carga_id, ts, pedido_id, paletes, atraso_min FROM entregas WHERE run_id = ? ORDER BY ts DESC LIMIT 100`,
};
function runQuery(name, run, q) {
  const f = QUERIES[name]; if (!f) return null;
  const b = Math.min(1440, Math.max(5, parseInt(q.get('b')) || 60));
  const lote = /^L-\d{3}$/.test(q.get('lote') || '') ? q.get('lote') : 'L-000';
  const sql = f({ b }).trim().replace(/:lote/g, "'" + lote + "'");
  const n = (sql.match(/\?/g) || []).length;
  return { sql, rows: db.prepare(sql).all(...Array(n).fill(run)) };
}
function kpis(run) {
  const one = (s, ...p) => db.prepare(s).get(...p) || {};
  const ev = one(`SELECT COUNT(*) n, SUM(classificacao='BOA') boa, SUM(classificacao='RUIM') ruim, SUM(classificacao='SUSPEITA') susp, SUM(corpo_estranho) corpo,
                  MIN(event_ts) t0, MAX(event_ts) t1, SUM(CASE WHEN ${REFUGO} THEN 1 ELSE 0 END) refugo FROM eventos WHERE run_id=?`, run);
  const ult = one(`SELECT COUNT(*) n FROM eventos WHERE run_id=? AND event_ts > ?`, run, (ev.t1 || 0) - 3600000);
  const pesos = one(`SELECT ROUND(SUM(peso_g)/1000.0,1) kg, ROUND(SUM(CASE WHEN ${BOM} THEN peso_g ELSE 0 END)/1000.0,1) aproveitado,
                     ROUND(SUM(CASE WHEN ${REFUGO} THEN peso_g ELSE 0 END)/1000.0,1) refugo FROM eventos WHERE run_id=?`, run);
  const cal = one(`SELECT calibracao c FROM sensor_saude WHERE run_id=? ORDER BY seq DESC LIMIT 1`, run).c;
  const est = one(`SELECT * FROM estoque_snap WHERE run_id=? ORDER BY seq DESC LIMIT 1`, run);
  const os = one(`SELECT COUNT(*) n, ROUND(COALESCE(SUM((fim_ts-inicio_ts)/60000.0),0),1) min FROM manutencao WHERE run_id=?`, run);
  const exp = one(`SELECT COUNT(*) paletes, COALESCE(SUM(volumes),0) volumes, COUNT(DISTINCT carga_id) cargas FROM expedicao WHERE run_id=?`, run);
  const frio = one(`SELECT temp_c, compressor, falha, caixas_descartadas FROM armazem_temp WHERE run_id=? ORDER BY seq DESC LIMIT 1`, run);
  const util = one(`SELECT ROUND(SUM(kwh),1) kwh, ROUND(SUM(agua_l),0) agua FROM utilidades WHERE run_id=?`, run);
  const ped = one(`SELECT COUNT(*) total, COALESCE(SUM(status='entregue'),0) entregues, COALESCE(SUM(status='entregue' AND fechado_ts<=prazo_ts),0) no_prazo, COALESCE(SUM(status='atrasado'),0) atrasados FROM pedidos WHERE run_id=?`, run);
  const res = one(`SELECT ROUND(COALESCE(SUM(CASE WHEN tipo='geracao' THEN kg ELSE 0 END),0),1) kg FROM residuos WHERE run_id=?`, run);
  const lab = one(`SELECT COUNT(*) n, COALESCE(SUM(resultado='REPROVADO'),0) reprovados FROM lab_analises WHERE run_id=?`, run);
  const proc = one(`SELECT COUNT(*) n, ROUND(100.0*SUM(saida_g)/NULLIF(SUM(entrada_g),0),1) rendimento FROM processamento WHERE run_id=?`, run);
  return { eventos: ev, ultima_hora: ult.n, pesos, calibracao: cal ?? null, estoque: est, manutencao: os, expedicao: exp, frio, util, pedidos: ped, residuos: res, lab, proc };
}
function runSql(text) {
  let s = String(text || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) throw new Error('Só consultas SELECT/WITH são permitidas.');
  if (s.includes(';')) throw new Error('Envie uma consulta por vez.');
  if (s.length > 4000) throw new Error('Consulta muito longa.');
  const ro = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    ro.exec('PRAGMA query_only = 1');
    const rows = ro.prepare(`SELECT * FROM (${s}) LIMIT 500`).all();
    return { rows, colunas: rows[0] ? Object.keys(rows[0]) : [] };
  } finally { ro.close(); }
}

// ───────────────────────── HTTP ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const clients = new Set();
let notifyTimer = null, lastRun = null;
function notify() {                                          // avisa as telas abertas (no máximo ~1 vez por segundo)
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const msg = `data: ${JSON.stringify({ tipo: 'dados', run: lastRun, em: Date.now() })}\n\n`;
    for (const c of clients) c.write(msg);
  }, 900);
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 8e6) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { fail(new Error('corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}
function serveFile(res, base, rel) {
  let file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end('proibido'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('não encontrado'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
function latestRun() { return (db.prepare('SELECT run_id FROM runs ORDER BY ultimo_recebimento DESC LIMIT 1').get() || {}).run_id || null; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (p === '/api/ingest' && req.method === 'POST') {
      const r = ingest(JSON.parse(await readBody(req))); lastRun = r.run; notify();
      return json(res, 200, { ok: true, ...r });
    }
    if (p === '/api/health') return json(res, 200, { ok: true, db: path.basename(DB_PATH), run: latestRun() });
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/api/runs') {
      return json(res, 200, db.prepare(`SELECT r.run_id, r.iniciado_em, r.ultimo_ts, r.ultimo_recebimento,
        (SELECT COUNT(*) FROM eventos e WHERE e.run_id = r.run_id) AS eventos FROM runs r ORDER BY r.ultimo_recebimento DESC`).all());
    }
    const run = url.searchParams.get('run') || latestRun();
    if (p === '/api/kpis') return json(res, 200, kpis(run));
    if (p.startsWith('/api/q/')) {
      const r = runQuery(p.slice(7), run, url.searchParams);
      return r ? json(res, 200, { run, ...r }) : json(res, 404, { erro: 'consulta desconhecida' });
    }
    if (p === '/api/tabelas') return json(res, 200, TABELAS.map(t => ({ tabela: t, linhas: db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n })));
    if (p.startsWith('/api/tabela/')) {
      const t = p.slice(12); if (!TABELAS.includes(t)) return json(res, 404, { erro: 'tabela desconhecida' });
      const lim = Math.min(500, parseInt(url.searchParams.get('limit')) || 100);
      const hasRun = !['dim_fornecedores', 'runs'].includes(t);
      const rows = hasRun ? db.prepare(`SELECT * FROM ${t} WHERE run_id = ? ORDER BY rowid DESC LIMIT ${lim}`).all(run) : db.prepare(`SELECT * FROM ${t} LIMIT ${lim}`).all();
      return json(res, 200, { tabela: t, rows });
    }
    if (p === '/api/sql' && req.method === 'POST') {
      try { return json(res, 200, runSql(JSON.parse(await readBody(req)).sql)); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    if (p === '/api/limpar' && req.method === 'POST') {
      for (const t of TABELAS.filter(t => t !== 'dim_fornecedores')) db.exec(`DELETE FROM ${t}`);
      notify(); return json(res, 200, { ok: true });
    }
    if (p === '/sim') { res.writeHead(302, { Location: '/sim/' }); return res.end(); }
    if (p.startsWith('/sim/')) return serveFile(res, SIM, p.slice(5));
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    console.error('erro:', e.message);
    json(res, 500, { erro: e.message });
  }
});
server.listen(PORT, () => {
  console.log(`\n  Potato ERP rodando em   http://localhost:${PORT}/`);
  console.log(`  Simulador 3D integrado  http://localhost:${PORT}/sim/`);
  console.log(`  Banco de dados          ${DB_PATH}\n`);
});
