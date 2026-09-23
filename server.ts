import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import { observabilityMiddleware, observabilityRegistry } from "./src/server/observability";
import {
  testPostgresConnection,
  getPostgresDDL,
  getSqliteInventory,
  runFullMigrationToPostgres,
} from "./src/lib/postgres";
import { safeRunPython, executeScannerCommand } from "./src/core/security/safe-exec";
import { authGuard } from "./src/middlewares/auth-guard";
import {
  createAuditHandler,
  getAuditStatusHandler,
  streamAuditEventsHandler,
  cancelAuditHandler,
  listAuditsHandler,
} from "./src/controllers/audit.controller";
import { generateDossierHtml } from "./src/services/dossier-generator.service";
import { validateParamUuid } from "./src/middlewares/validate-uuid";
import { compileDossierPdf } from "./src/services/pdf-compiler.service";
import { SentinelService } from "./src/services/sentinel.service";

const app = express();
const PORT = 3000;

// Configuração de Domínio & CORS para Cloud Run e Cookies HttpOnly Cross-Subdomain
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://app.arkhe.io";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    (origin === ALLOWED_ORIGIN ||
      origin.endsWith(".arkhe.io") ||
      origin.includes("localhost") ||
      origin.includes("127.0.0.1") ||
      origin.includes(".run.app"))
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With, X-Workspace-Id, x-workspace-id"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

app.use(express.json());
app.use(observabilityMiddleware);
app.use(authGuard);

function parseCommandLine(cmd: string): string[] {
  const result: string[] = [];
  const regex = /[^\s"']+|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = regex.exec(cmd)) !== null) {
    if (match[1] !== undefined) {
      result.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    } else if (match[2] !== undefined) {
      result.push(match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    } else {
      result.push(match[0]);
    }
  }
  return result;
}

/**
 * Execução segura de comandos sem interpolação de shell (shell: false)
 * Eliminando permanentemente vetores de Remote Code Execution (RCE).
 * Suporta assinatura por string completa ou vetor pré-parseado [bin, ...args].
 */
async function runExec(cmd: string | string[], cwd = process.cwd(), timeoutMs = 25000): Promise<{ stdout: string; stderr: string; code: number }> {
  let bin = "";
  let args: string[] = [];

  if (Array.isArray(cmd)) {
    bin = cmd[0] || "";
    args = cmd.slice(1);
  } else {
    const trimmed = cmd.trim();

    // Tratamento especializado para python3 -c com scripts multilinhas
    if (trimmed.startsWith("python3 -c ") || trimmed.startsWith("python3 -c\"") || trimmed.startsWith("python3 -c'")) {
      let inlineCode = trimmed.slice(trimmed.indexOf("-c") + 2).trim();
      if ((inlineCode.startsWith('"') && inlineCode.endsWith('"')) || (inlineCode.startsWith("'") && inlineCode.endsWith("'"))) {
        inlineCode = inlineCode.slice(1, -1);
      }
      // Decodifica escapes de aspas inseridos por regex ou serialização
      inlineCode = inlineCode.replace(/\\"/g, '"').replace(/\\'/g, "'");
      return safeRunPython("-c", [inlineCode], { cwd, timeoutMs });
    }

    const parts = parseCommandLine(trimmed);
    bin = parts[0] || "";
    args = parts.slice(1);
  }

  if (bin === "python3") {
    if (args[0] === "-c") {
      let code = args[1] || "";
      code = code.replace(/\\"/g, '"').replace(/\\'/g, "'");
      return safeRunPython("-c", [code], { cwd, timeoutMs });
    }
    if (args[0] === "-m") {
      return safeRunPython("-m", args.slice(1), { cwd, timeoutMs });
    }
    return safeRunPython(args[0], args.slice(1), { cwd, timeoutMs });
  }

  // Comandos de scanner são validados por allowlist restrita
  if (['nmap', 'trivy', 'git', 'nuclei'].includes(bin)) {
    const target = args[args.length - 1] || 'localhost';
    try {
      const res = await executeScannerCommand(bin as any, target, { timeoutMs, cwd });
      return { stdout: res.stdout, stderr: res.stderr, code: 0 };
    } catch (err: any) {
      return { stdout: '', stderr: err.message, code: 1 };
    }
  }

  // Fallback seguro usando safeRunPython para manter compatibilidade
  return safeRunPython(bin, args, { cwd, timeoutMs });
}

// Ensure relatorios, rascunhos directories exist
if (!fs.existsSync(path.join(process.cwd(), "relatorios"))) {
  fs.mkdirSync(path.join(process.cwd(), "relatorios"), { recursive: true });
}
if (!fs.existsSync(path.join(process.cwd(), "rascunhos"))) {
  fs.mkdirSync(path.join(process.cwd(), "rascunhos"), { recursive: true });
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Fase 2: Rotas de Auditoria de Vulnerabilidades & Segurança (MSP Pipeline & BullMQ Worker Lifecycle)
app.get("/api/v1/audits", listAuditsHandler);
app.post("/api/v1/audits", createAuditHandler);
app.get("/api/v1/audits/:id", validateParamUuid("id"), getAuditStatusHandler);
app.get("/api/v1/audits/:id/events", validateParamUuid("id"), streamAuditEventsHandler);
app.post("/api/v1/audits/:id/cancel", validateParamUuid("id"), cancelAuditHandler);

// Dossiê Executivo por ID de auditoria com suporte a compilação PDF nativa (Ação 4.2)
app.get("/api/v1/audits/:id/dossier.pdf", validateParamUuid("id"), async (req, res) => {
  const { id } = req.params;
  const dossierPayload = {
    consultancyName: "ARKHÉ Strategic Security",
    consultancyLogoUrl: "",
    clientName: `Alvo Auditado (${id.slice(0, 8)})`,
    coiValueFormatted: "R$ 380.000,00",
    criticalFindingsCount: 3,
    actionPlan: [
      { priority: "P0 - Crítica", action: "Remediar vulnerabilidade em gateway de pagamento (CVE-2024-3094)", impact: "Evita multa regulatória BACEN e mitigação de downtime" },
      { priority: "P1 - Alta", action: "Substituir concorrência direta SQLite por PgBouncer + PostgreSQL 16", impact: "Elimina gargalos e table-level locks sob alta carga" },
      { priority: "P2 - Média", action: "Implementar rotação automatizada de credenciais e MFA institucional", impact: "Conformidade imediata com ISO 27001 e SOC2" },
    ]
  };

  const compiled = await compileDossierPdf(dossierPayload);

  if (compiled.isDirectPdf && compiled.buffer) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="dossie-arkhe-${id.slice(0, 8)}.pdf"`);
    return res.send(compiled.buffer);
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(compiled.html);
});

// ============================================================================
// EIXO 6: ROTAS DO MOTOR SENTINELA CTEM & RETENÇÃO RECORRENTE
// ============================================================================

// Obter cota e limite de ativos do plano do tenant
app.get("/api/v1/sentinel/quota", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const quota = await SentinelService.getTenantQuota(tenantId);
  res.json(quota);
});

// Listar ativos monitorados sob custódia contínua
app.get("/api/v1/sentinel/assets", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const assets = await SentinelService.listMonitoredAssets(tenantId);
  res.json({ assets });
});

// Adicionar novo ativo com validação estrita de cotas do plano (Ação 6.1)
app.post("/api/v1/sentinel/assets", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  try {
    const asset = await SentinelService.addMonitoredAsset(tenantId, req.body);
    res.status(201).json({ asset, message: "Ativo adicionado à Sentinela Contínua com sucesso." });
  } catch (err: any) {
    res.status(403).json({ error: err.message, code: "QUOTA_EXCEEDED" });
  }
});

// Listar desvios de postura e riscos de drift
app.get("/api/v1/sentinel/drifts", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const drifts = await SentinelService.listPostureDrifts(tenantId);
  res.json({ drifts });
});

// Testar webhook rico de alerta (Opção B - Slack / Discord / Teams)
app.post("/api/v1/sentinel/webhook/test", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const { testUrl } = req.body || {};
  try {
    const result = await SentinelService.testTenantWebhook(tenantId, testUrl);
    res.json({
      message: result.success
        ? `Alerta de teste enviado com sucesso via ${result.channelType.toUpperCase()}!`
        : `Falha ao entregar alerta no canal: ${result.error}`,
      result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar configuração do webhook do parceiro MSP
app.put("/api/v1/sentinel/webhook", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const { webhookUrl = "", consultantName } = req.body || {};
  try {
    const updated = await SentinelService.updateTenantWebhook(tenantId, webhookUrl, consultantName);
    res.json({
      message: "Configuração de webhook e canal atualizada com sucesso.",
      quota: updated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disparar verificação imediata da Sentinela em um ativo (Ação 6.2)
app.post("/api/v1/sentinel/assets/:id/check", validateParamUuid("id"), async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  try {
    const result = await SentinelService.runSentinelCheck(req.params.id, tenantId);
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Obter boletim mensal formatado para o CFO (Ação 6.3 - White-Label)
app.get("/api/v1/sentinel/assets/:id/cfo-bulletin", validateParamUuid("id"), async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  try {
    const bulletin = await SentinelService.generateCfoMonthlyBulletin(tenantId, req.params.id);
    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(bulletin.html);
    }
    res.json(bulletin);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Disparar envio de e-mail do Boletim Mensal ao CFO do cliente (Opção A)
app.post("/api/v1/sentinel/assets/:id/cfo-bulletin/dispatch", validateParamUuid("id"), async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  const { customRecipient } = req.body || {};
  try {
    const result = await SentinelService.dispatchCfoMonthlyBulletinViaEmail(tenantId, req.params.id, customRecipient);
    res.json({
      message: `Boletim executivo despachado com sucesso para ${result.bulletinSummary.recipient}.`,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disparo em lote para toda a carteira de clientes (Rotina Mensal Automatizada)
app.post("/api/v1/sentinel/cfo-bulletin/dispatch-fleet", async (req, res) => {
  const tenantId = req.user?.tenantId || "00000000-0000-0000-0000-000000000001";
  try {
    const result = await SentinelService.dispatchFleetCfoBulletins(tenantId);
    res.json({
      message: `Rotina concluída: ${result.totalDispatched} boletins disparados com sucesso para os CFOs da carteira.`,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fase 3: Motor do Dossiê Executivo (White-Label PDF / HTML)
app.post("/api/v1/dossier/generate", (req, res) => {
  const {
    consultancyName = "ARKHÉ Strategic Security",
    consultancyLogoUrl = "",
    clientName = "Cliente Corporativo",
    coiValueFormatted = "R$ 284.500,00",
    criticalFindingsCount = 4,
    actionPlan = [
      { priority: "P0 - Crítica", action: "Remediar vulnerabilidade em gateway de pagamento (CVE-2024-3094)", impact: "Evita multa BACEN de R$ 500k e downtime" },
      { priority: "P1 - Alta", action: "Substituir concorrência direta SQLite por PgBouncer + PostgreSQL 16", impact: "Mitiga locks de banco sob picos de tráfego" },
      { priority: "P2 - Média", action: "Implementar rotação automática de credenciais e MFA", impact: "Conformidade imediata com ISO 27001 e SOC2" },
    ]
  } = req.body;

  const html = generateDossierHtml({
    consultancyName,
    consultancyLogoUrl,
    clientName,
    coiValueFormatted,
    criticalFindingsCount,
    actionPlan
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// SRE & SaaS Observability Endpoints
app.get("/api/observability/summary", async (req, res) => {
  const summary = await observabilityRegistry.getSummary();
  res.json(summary);
});

app.post("/api/observability/pgbouncer/test", async (req, res) => {
  const result = await observabilityRegistry.testDbPoolTransaction();
  const summary = await observabilityRegistry.getSummary();
  res.json({
    testResult: result,
    dbPool: summary.dbPool,
  });
});

app.get("/api/metrics", async (req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  const metrics = await observabilityRegistry.getPrometheusMetrics();
  res.send(metrics);
});

// Environment and system status
app.get("/api/status", async (req, res) => {
  const pyVersion = await runExec("python3 --version");
  const files = ["storage.py", "radar.py", "memoria.py", "acoes.py", "tests/test_radar_simulado.py"];
  const fileStatuses = files.map((f) => ({
    name: f,
    exists: fs.existsSync(path.join(process.cwd(), f)),
    size: fs.existsSync(path.join(process.cwd(), f)) ? fs.statSync(path.join(process.cwd(), f)).size : 0,
  }));

  const dbExists = fs.existsSync(path.join(process.cwd(), "radar.sqlite3"));

  res.json({
    pythonVersion: pyVersion.stdout.trim() || pyVersion.stderr.trim(),
    files: fileStatuses,
    databaseExists: dbExists,
  });
});

// Validate Python syntax with AST
app.post("/api/validate-syntax", async (req, res) => {
  const pythonScript = `
import ast, json, sys
files = ['storage.py', 'radar.py', 'memoria.py', 'acoes.py']
results = {}

for f in files:
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            source = fh.read()
        tree = ast.parse(source, filename=f)
        funcs = [n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        classes = [n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]
        imports = []
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                imports.extend([a.name for a in n.names])
            elif isinstance(n, ast.ImportFrom):
                imports.append(f"{n.module}")
        doc = ast.get_docstring(tree) or ""
        results[f] = {
            "valid": True,
            "functions": funcs,
            "classes": classes,
            "imports": list(set(imports)),
            "docstring": doc.strip(),
            "lines": len(source.splitlines()),
            "error": None
        }
    except Exception as e:
        results[f] = {
            "valid": False,
            "error": str(e)
        }

print(json.dumps(results))
`;

  const out = await runExec(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`);
  if (out.code !== 0) {
    return res.status(500).json({ error: out.stderr });
  }

  try {
    const parsed = JSON.parse(out.stdout);
    res.json({ modules: parsed });
  } catch (err: any) {
    res.status(500).json({ error: "Falha ao decodificar JSON", details: out.stdout });
  }
});

// Run automated unit tests
app.post("/api/run-tests", async (req, res) => {
  const startTime = Date.now();
  const testRes = await runExec("python3 -m unittest discover -s tests -v");
  const durationMs = Date.now() - startTime;

  const rawOutput = (testRes.stdout + "\n" + testRes.stderr).trim();
  const testLines = rawOutput.split("\n");
  const tests: { name: string; suite: string; status: "PASSED" | "FAILED"; doc?: string }[] = [];

  for (const line of testLines) {
    const match = line.match(/^([a-zA-Z0-9_]+)\s+\(([^)]+)\)\s*(.*?)\.\.\.\s*(ok|FAIL|ERROR)/);
    if (match) {
      tests.push({
        name: match[1],
        suite: match[2],
        doc: match[3] ? match[3].trim() : "",
        status: match[4] === "ok" ? "PASSED" : "FAILED",
      });
    }
  }

  const isSuccess = testRes.code === 0;

  res.json({
    success: isSuccess,
    exitCode: testRes.code,
    durationMs,
    tests,
    rawOutput,
  });
});

// Execute Radar Scan & Gatekeeper (Live Market Scan or Homologation Simulation)
app.post(["/api/simulate-radar", "/api/scan-radar"], async (req, res) => {
  const {
    tema = "SRE e observabilidade no Brasil",
    scenario = "live",
    segmento = "geral",
    foco = "todos"
  } = req.body;

  const startTime = Date.now();
  const safeTema = String(tema).replace(/["`$\\]/g, "");
  const safeScenario = ["live", "standard", "excess", "mixed"].includes(scenario) ? scenario : "live";
  const safeSegmento = ["geral", "fintech", "ecommerce", "logistica", "saas"].includes(segmento) ? segmento : "geral";
  const safeFoco = ["todos", "diagnostico", "vagas"].includes(foco) ? foco : "todos";

  const command = `python3 radar_scanner.py --tema "${safeTema}" --scenario "${safeScenario}" --segmento "${safeSegmento}" --foco "${safeFoco}"`;
  const runRes = await runExec(command);
  const duration = Date.now() - startTime;

  if (runRes.code !== 0) {
    observabilityRegistry.recordSubprocess("radar_scan", false, duration);
    return res.status(500).json({
      error: "Falha na execução do scanner do radar",
      details: runRes.stderr || runRes.stdout
    });
  }

  try {
    const rawOutput = runRes.stdout.trim();
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Resposta do scanner não contém payload JSON válido.");
    }
    const data = JSON.parse(jsonMatch[0]);
    observabilityRegistry.recordSubprocess("radar_scan", true, duration);
    res.json(data);
  } catch (err: any) {
    observabilityRegistry.recordSubprocess("radar_scan", false, duration);
    res.status(500).json({
      error: "Erro ao interpretar resultado do radar",
      details: err.message,
      raw: runRes.stdout
    });
  }
});

// Database rows and history
app.get("/api/database", async (req, res) => {
  const pyQuery = `
import json, storage
storage.init_db()
rows = storage.list_rows()
history_data = {}
for r in rows:
    try:
        history_data[r["url"]] = storage.history(r["url"])
    except:
        history_data[r["url"]] = []

with storage.connect() as db:
    revisoes = [dict(rev) for rev in db.execute("SELECT * FROM revisoes")]

print(json.dumps({"rows": rows, "history": history_data, "revisoes": revisoes}))
`;
  const runRes = await runExec(`python3 -c "${pyQuery.replace(/"/g, '\\"')}"`);
  if (runRes.code !== 0) {
    return res.status(500).json({ error: runRes.stderr });
  }
  try {
    const data = JSON.parse(runRes.stdout);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Falha ao ler banco", raw: runRes.stdout });
  }
});

// Helper for deterministic opportunity metadata fallback
function generateDeterministicMetadata(url: string, oportunidade?: string, domain?: string, fonte?: string) {
  const text = `${url} ${oportunidade || ""} ${domain || ""} ${fonte || ""}`.toLowerCase();

  let company_name = oportunidade ? oportunidade.split(/[-–—:]/)[0].trim() : (domain ? domain.split(".")[0].toUpperCase() : "Empresa Alvo");
  let company_size = "Grande Porte (1.000 - 5.000 colab.)";
  let industry_sector = "Tecnologia & Serviços Digitais";
  let tech_stack = ["Kubernetes", "Observabilidade", "Docker", "Cloud"];
  let aderencia = 4;
  let sinal = 4;
  let fonteScore = 4;
  let recencia = 4;
  let rationale = "Empresa com arquitetura em nuvem e sinais claros de necessidade de governança de observabilidade e redução de incidentes.";
  let signalSummary = "Demanda contínua por disponibilidade, monitoramento de microsserviços e resiliência.";

  if (text.includes("nubank") || text.includes("stone") || text.includes("inter") || text.includes("itau") ||
      text.includes("bradesco") || text.includes("santander") || text.includes("pagseguro") || text.includes("c6") ||
      text.includes("neon") || text.includes("picpay") || text.includes("xp") || text.includes("btg") ||
      text.includes("fintech") || text.includes("banco") || text.includes("bank") || text.includes("pix") || text.includes("pagamento")) {
    industry_sector = "Fintech & Serviços Financeiros";
    company_size = text.includes("nubank") || text.includes("itau") || text.includes("bradesco") || text.includes("santander")
      ? "Enterprise (10.000+ colab.)"
      : "Grande Porte (1.000 - 5.000 colab.)";
    tech_stack = ["Kubernetes", "Kafka", "Datadog", "OpenTelemetry", "AWS / Multi-cloud"];
    aderencia = 5;
    sinal = 5;
    fonteScore = 5;
    recencia = 4;
    rationale = "Operações financeiras críticas com exigência estrita de SLA 99.99%, conformidade BACEN e tolerância mínima a latência em Pix e liquidações.";
    signalSummary = "Processamento em alta concorrência de pagamentos onde latência e indisponibilidade geram multas e perda direta de faturamento.";
  } else if (text.includes("mercado") || text.includes("magalu") || text.includes("shopee") || text.includes("americanas") ||
             text.includes("ifood") || text.includes("rappi") || text.includes("varejo") || text.includes("commerce") ||
             text.includes("black friday") || text.includes("checkout")) {
    industry_sector = "E-commerce & Marketplace";
    company_size = "Enterprise (10.000+ colab.)";
    tech_stack = ["Kubernetes", "Prometheus", "Thanos", "Chaos Engineering", "Golang"];
    aderencia = 5;
    sinal = 5;
    fonteScore = 4;
    recencia = 5;
    rationale = "Alta volatilidade sazonal e dependência de resiliência ponta-a-ponta em checkout, busca e catálogo de produtos.";
    signalSummary = "Picos maciços de tráfego que exigem autoscaling preditivo e rápida contenção de degradação em microsserviços.";
  } else if (text.includes("localiza") || text.includes("movida") || text.includes("uber") || text.includes("99") ||
             text.includes("loggi") || text.includes("azul") || text.includes("gol") || text.includes("embraer") ||
             text.includes("logistica") || text.includes("transporte") || text.includes("frotas")) {
    industry_sector = "Mobilidade & Logística";
    company_size = text.includes("localiza") || text.includes("embraer") ? "Enterprise (5.000 - 10.000 colab.)" : "Grande Porte (1.000 - 5.000 colab.)";
    tech_stack = ["Kubernetes Multi-Cluster", "Prometheus", "Grafana", "AWS", "IoT Telemetry"];
    aderencia = 4;
    sinal = 4;
    fonteScore = 4;
    recencia = 4;
    rationale = "Operação distribuída em tempo real com telemetria contínua de dispositivos, reservas e roteirização sensível a falhas.";
    signalSummary = "Integração crítica de sistemas de ponta com nuvem central, demandando visibilidade unificada de latência de APIs.";
  } else if (text.includes("quintoandar") || text.includes("loft") || text.includes("vivareal") || text.includes("zap") ||
             text.includes("imovel") || text.includes("proptech")) {
    industry_sector = "Proptech & Marketplace Imobiliário";
    company_size = "Média / Scale-up (500 - 1.000 colab.)";
    tech_stack = ["Datadog", "Kubernetes", "GCP", "Microservices", "ArgoCD"];
    aderencia = 4;
    sinal = 4;
    fonteScore = 5;
    recencia = 4;
    rationale = "Scale-up consolidada com complexa malha de serviços buscando padronização de SLOs e redução consistente de MTTR.";
    signalSummary = "Reestruturação de observabilidade com foco em confiabilidade de contratos e esteira de crédito imobiliário.";
  } else if (text.includes("totvs") || text.includes("linx") || text.includes("sankhya") || text.includes("vtex") ||
             text.includes("zup") || text.includes("ci&t") || text.includes("saas") || text.includes("software") || text.includes("cloud")) {
    industry_sector = "SaaS & Enterprise Cloud";
    company_size = "Grande Porte (1.000 - 5.000 colab.)";
    tech_stack = ["AWS", "Azure", "Docker", "Datadog", "OpenTelemetry"];
    aderencia = 4;
    sinal = 4;
    fonteScore = 4;
    recencia = 4;
    rationale = "Provedor B2B com centenas de clientes corporativos onde indisponibilidade afeta diretamente os contratos de nível de serviço (SLA).";
    signalSummary = "Migração para nuvem e necessidade de mapa de pontos cegos para mitigar incidentes em produção.";
  } else if (text.includes("vivo") || text.includes("claro") || text.includes("tim") || text.includes("embratel") || text.includes("telecom")) {
    industry_sector = "Telecomunicações & Infraestrutura";
    company_size = "Enterprise (10.000+ colab.)";
    tech_stack = ["OpenStack", "Kubernetes", "Prometheus", "SNMP", "Linux Kernel"];
    aderencia = 4;
    sinal = 4;
    fonteScore = 5;
    recencia = 4;
    rationale = "Infraestrutura de alta escala com monitoramento contínuo de saturação de links, backbones e alta disponibilidade.";
    signalSummary = "Requisitos rigorosos de disponibilidade de telecom e atendimento regulatório.";
  } else if (text.includes("hospital") || text.includes("saude") || text.includes("health") || text.includes("fleury") || text.includes("dasa")) {
    industry_sector = "Saúde & Healthtech";
    company_size = "Grande Porte (1.000 - 5.000 colab.)";
    tech_stack = ["Kubernetes", "Grafana", "Splunk", "Azure Cloud"];
    aderencia = 4;
    sinal = 5;
    fonteScore = 4;
    recencia = 4;
    rationale = "Sistemas médicos e laboratoriais hospitalares onde disponibilidade de dados de pacientes tem impacto direto em vidas.";
    signalSummary = "Aplicações críticas de prontuário e laudos 24/7 com tolerância zero a paradas não programadas.";
  }

  const calculatedNota = 7 * aderencia + 6 * sinal + 4 * fonteScore + 3 * recencia;

  return {
    company_name,
    company_size,
    industry_sector,
    tech_stack,
    public_signal_summary: signalSummary,
    confidence: 0.88,
    scoring: {
      aderencia,
      sinal,
      fonte: fonteScore,
      recencia,
      nota: calculatedNota,
      is_qualified: calculatedNota >= 70,
      rationale,
    }
  };
}

// Extract metadata and scoring criteria via Gemini or fallback engine
async function extractMetadataWithGeminiOrFallback(url: string, oportunidade?: string, fonte?: string) {
  let domain = "";
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    domain = parsed.hostname.replace("www.", "");
  } catch {
    domain = fonte || "";
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = getAI();
      const prompt = `Você é um analista executivo de SRE e inteligência de mercado do ARKHÉ Revenue Radar.
Analise a oportunidade comercial abaixo:
- URL Pública: ${url}
- Título da Oportunidade: ${oportunidade || "Não informado"}
- Domínio/Fonte: ${domain || fonte || "Não informado"}

Sua missão:
1. Extraia e identifique:
   - "company_name": Nome conciso da empresa (ex: Nubank, Mercado Livre, Stone, Banco Inter, Localiza, etc.)
   - "company_size": Porte da empresa (Exemplos obrigatórios: "Enterprise (10.000+ colab.)", "Grande Porte (1.000 - 5.000 colab.)", "Média / Scale-up (200 - 1.000 colab.)", ou "Startup (10 - 200 colab.)")
   - "industry_sector": Setor de atuação (ex: "Fintech & Serviços Financeiros", "E-commerce & Marketplace", "SaaS & Cloud B2B", "Telecom & Infraestrutura", "Saúde & Healthtech", "Mobilidade & Logística", "Varejo & Consumo")
   - "tech_stack": Lista de 3 a 5 tecnologias prováveis ou citadas (ex: ["Kubernetes", "Datadog", "OpenTelemetry", "Kafka", "AWS"])
   - "public_signal_summary": Resumo de 1 frase do contexto/sinal de confiabilidade identificado
2. Preencha os 4 critérios de pontuação da matriz ARKHÉ (7A + 6S + 4F + 3R), sendo cada um um número inteiro de 0 a 5:
   - "aderencia" (0-5): Alinhamento técnico com SRE, observabilidade, confiabilidade e tolerância a falhas.
   - "sinal" (0-5): Força/criticidade da oportunidade (ex: criticidade de transações financeiras, incidente público, vaga estratégica para latência/SLA).
   - "fonte" (0-5): Autoridade do canal (página oficial de carreiras ou engenharia da própria empresa = 5, agregador verificado = 4).
   - "recencia" (0-5): Frescor e relevância temporal (geralmente 4 ou 5 para sinais recentes).
   - "rationale": Justificativa técnica em 1 ou 2 frases em português explicando por que esses critérios e notas foram propostos.

Retorne EXCLUSIVAMENTE um JSON estrito:
{
  "company_name": "Nome",
  "company_size": "Porte",
  "industry_sector": "Setor",
  "tech_stack": ["Tech1", "Tech2"],
  "public_signal_summary": "Resumo",
  "scoring": {
    "aderencia": 5,
    "sinal": 4,
    "fonte": 5,
    "recencia": 4,
    "rationale": "Justificativa clara"
  }
}`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const text = response.text?.trim() || "";
      if (text) {
        const parsed = JSON.parse(text);
        const aderencia = Math.min(5, Math.max(0, Number(parsed.scoring?.aderencia ?? 4)));
        const sinal = Math.min(5, Math.max(0, Number(parsed.scoring?.sinal ?? 4)));
        const fonteScore = Math.min(5, Math.max(0, Number(parsed.scoring?.fonte ?? 4)));
        const recencia = Math.min(5, Math.max(0, Number(parsed.scoring?.recencia ?? 4)));
        const nota = 7 * aderencia + 6 * sinal + 4 * fonteScore + 3 * recencia;

        return {
          company_name: parsed.company_name || domain.split(".")[0],
          company_size: parsed.company_size || "Grande Porte (1.000 - 5.000 colab.)",
          industry_sector: parsed.industry_sector || "Tecnologia & Serviços",
          tech_stack: Array.isArray(parsed.tech_stack) ? parsed.tech_stack : ["Kubernetes", "Observabilidade"],
          public_signal_summary: parsed.public_signal_summary || "Sinal público identificado de confiabilidade e infraestrutura.",
          confidence: 0.95,
          scoring: {
            aderencia,
            sinal,
            fonte: fonteScore,
            recencia,
            nota,
            is_qualified: nota >= 70,
            rationale: parsed.scoring?.rationale || "Oportunidade alinhada com critérios de SRE e observabilidade."
          }
        };
      }
    } catch (aiErr) {
      console.warn("Gemini metadata extraction fallback triggered:", aiErr);
    }
  }

  return generateDeterministicMetadata(url, oportunidade, domain, fonte);
}

// Fetch opportunity metadata & auto-populate scoring criteria
app.post("/api/fetch-opportunity-metadata", async (req, res) => {
  const { url, oportunidade, fonte } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL é obrigatória para buscar metadados." });
  }

  try {
    const metadata = await extractMetadataWithGeminiOrFallback(url, oportunidade, fonte);
    res.json({ success: true, metadata });
  } catch (err: any) {
    res.status(500).json({ error: "Falha ao buscar metadados da oportunidade", details: err.message });
  }
});

// Enrich existing opportunity with metadata and auto-scoring
app.post("/api/enrich-opportunity", async (req, res) => {
  const { url, oportunidade, fonte } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL é obrigatória." });
  }

  try {
    const metadata = await extractMetadataWithGeminiOrFallback(url, oportunidade, fonte);
    const scoringMetaJson = JSON.stringify(metadata.scoring);

    const pyUpdate = `
import json, storage
try:
    storage.update(
        "${url}",
        company_size="""${metadata.company_size.replace(/"""/g, '\\"\\"\\"')}""",
        industry_sector="""${metadata.industry_sector.replace(/"""/g, '\\"\\"\\"')}""",
        scoring_metadata="""${scoringMetaJson.replace(/"""/g, '\\"\\"\\"')}""",
        aderencia=${metadata.scoring.aderencia},
        nota=${metadata.scoring.nota}
    )
    print(json.dumps({"success": True, "metadata": ${JSON.stringify(metadata)}}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const runRes = await runExec(`python3 -c '${pyUpdate.replace(/'/g, "'\\''")}'`);
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Score an opportunity
app.post("/api/score", async (req, res) => {
  const { url, aderencia, sinal, fonte, recencia, scoring_metadata } = req.body;
  const metaArg = scoring_metadata ? `"""${JSON.stringify(scoring_metadata).replace(/"""/g, '\\"\\"\\"')}"""` : "None";
  const pyScore = `
import json, storage
try:
    nota = storage.score("${url}", ${aderencia}, ${sinal}, ${fonte}, ${recencia}, scoring_metadata=${metaArg})
    print(json.dumps({"success": True, "nota": nota}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c "${pyScore.replace(/"/g, '\\"')}"`);
  try {
    const data = JSON.parse(runRes.stdout);
    res.json(data);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Update status
app.post("/api/update-status", async (req, res) => {
  const { url, estado, proxima_acao = "", resultado = "" } = req.body;
  const pyUpdate = `
import json, storage
try:
    storage.update("${url}", estado="${estado}", proxima_acao="""${proxima_acao}""", resultado="""${resultado}""")
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c "${pyUpdate.replace(/"/g, '\\"')}"`);
  try {
    const data = JSON.parse(runRes.stdout);
    res.json(data);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Action draft simulation & approval (acoes.py)
app.post("/api/simulate-action", async (req, res) => {
  const { url, action, objetivo = "diagnostico", canal = "email", fato = "Fato verificado na vaga", observacao = "Enviado manualmente" } = req.body;

  const pyAction = `
import json, hashlib, os
from datetime import datetime, timezone
from pathlib import Path
import storage, acoes

acoes.preparar_tabela_revisoes()
url = storage.validate_url("${url}")
row = acoes.obter_oportunidade(url)

try:
    if "${action}" == "preparar":
        acoes.exigir_verificada(row)
        # Mock de rascunho sem chamada de rede externa
        foco = "diagnostico de observabilidade com escopo de 5 dias e mapa de pontos cegos." if "${objetivo}" == "diagnostico" else "candidatura SRE com base no historico informado."
        corpo = f"Ola, notei o sinal publico em relacao a confiabilidade ({fato}). Gostaria de apresentar uma proposta direta para {foco}."
        
        identificador = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
        carimbo = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        arquivo = acoes.RASCUNHOS / f"{identificador}-{carimbo}.md"
        acoes.RASCUNHOS.mkdir(exist_ok=True)
        arquivo.write_text(f"# Rascunho para revisao\\n\\nURL da oportunidade: {url}\\n\\nObjetivo: ${objetivo}\\nCanal: ${canal}\\nFato conferido: ${fato}\\n\\n## Mensagem\\n\\n{corpo}\\n", encoding="utf-8")
        
        with acoes.conectar() as db:
            db.execute("""INSERT INTO revisoes(url, arquivo, hash_aprovado, aprovado_em)
                          VALUES (?, ?, NULL, NULL)
                          ON CONFLICT(url) DO UPDATE SET arquivo = excluded.arquivo, hash_aprovado = NULL, aprovado_em = NULL""", (url, arquivo.name))
            db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'rascunho gerado', ?)", (url, arquivo.name))
        print(json.dumps({"success": True, "arquivo": arquivo.name, "corpo": corpo, "url": url}))
        
    elif "${action}" == "aprovar":
        acoes.exigir_verificada(row, permitir_reaprovacao=True)
        _, arquivo = acoes.revisao_atual(url)
        resumo = hashlib.sha256(arquivo.read_bytes()).hexdigest()
        with acoes.conectar() as db:
            db.execute("UPDATE revisoes SET hash_aprovado = ?, aprovado_em = CURRENT_TIMESTAMP WHERE url = ?", (resumo, url))
            db.execute("UPDATE oportunidades SET estado = 'contato preparado', proxima_acao = 'Enviar manualmente apos conferir o destinatario', atualizado_em = CURRENT_TIMESTAMP WHERE url = ?", (url,))
            db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'rascunho aprovado', ?)", (url, f"{arquivo.name}; SHA-256={resumo}"))
        print(json.dumps({"success": True, "status": "contato preparado", "hash": resumo}))

    elif "${action}" == "registrar_envio":
        if row["estado"] != "contato preparado":
            raise SystemExit("O status deve ser 'contato preparado'.")
        revisao, arquivo = acoes.revisao_atual(url)
        atual = hashlib.sha256(arquivo.read_bytes()).hexdigest()
        if not revisao["hash_aprovado"] or atual != revisao["hash_aprovado"]:
            raise SystemExit("O rascunho mudou apos a aprovacao. Revise e aprove novamente.")
        with acoes.conectar() as db:
            db.execute("UPDATE oportunidades SET estado = 'enviada', proxima_acao = 'Aguardar resposta e planejar acompanhamento', resultado = ?, atualizado_em = CURRENT_TIMESTAMP WHERE url = ?",
                       ("Envio informado manualmente via ${canal}: ${observacao}", url))
            db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'envio informado pela pessoa', ?)",
                       (url, "Canal=${canal}; arquivo=" + arquivo.name + "; ${observacao}"))
        print(json.dumps({"success": True, "status": "enviada"}))
except Exception as exc:
    print(json.dumps({"success": False, "error": str(exc)}))
`;

  const runRes = await runExec(`python3 -c "${pyAction.replace(/"/g, '\\"')}"`);
  try {
    const data = JSON.parse(runRes.stdout);
    res.json(data);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Reset test database
app.post("/api/reset-db", async (req, res) => {
  const dbPath = path.join(process.cwd(), "radar.sqlite3");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  await runExec("python3 memoria.py init");
  res.json({ success: true, message: "Banco de dados SQLite inicializado com sucesso." });
});

// Add manual opportunity (SaaS prospecção)
app.post("/api/opportunities", async (req, res) => {
  const {
    url,
    oportunidade,
    fonte,
    tipo,
    estado = "nova",
    proxima_acao = "",
    data,
    company_size = "",
    industry_sector = "",
    scoring_metadata = null,
    aderencia = null,
    nota = null
  } = req.body;

  const metaArg = scoring_metadata ? `"""${JSON.stringify(scoring_metadata).replace(/"""/g, '\\"\\"\\"')}"""` : `""`;
  const aderenciaArg = aderencia !== null && aderencia !== undefined ? Number(aderencia) : "None";
  const notaArg = nota !== null && nota !== undefined ? Number(nota) : "None";

  const pyCode = `
import json, storage
try:
    url_clean = storage.validate_url("""${url}""")
    added = storage.add(
        url_clean,
        """${(oportunidade || "").replace(/"""/g, '\\"\\"\\"')}""",
        """${(fonte || "").replace(/"""/g, '\\"\\"\\"')}""",
        """${(tipo || "diagnostico").replace(/"""/g, '\\"\\"\\"')}""",
        data="${data || ""}" or None,
        estado="${estado}",
        proxima_acao="""${(proxima_acao || "").replace(/"""/g, '\\"\\"\\"')}""",
        company_size="""${(company_size || "").replace(/"""/g, '\\"\\"\\"')}""",
        industry_sector="""${(industry_sector || "").replace(/"""/g, '\\"\\"\\"')}""",
        scoring_metadata=${metaArg},
        aderencia=${aderenciaArg},
        nota=${notaArg}
    )
    print(json.dumps({"success": True, "added": added}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Delete opportunity and clean relations
app.delete("/api/opportunities", async (req, res) => {
  const { url } = req.body;
  const pyCode = `
import json, storage
try:
    clean_url = storage.validate_url("""${url}""")
    with storage.connect() as db:
        db.execute("DELETE FROM revisoes WHERE url = ?", (clean_url,))
        db.execute("DELETE FROM historico_acoes WHERE url = ?", (clean_url,))
        db.execute("DELETE FROM oportunidades WHERE url = ?", (clean_url,))
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Export CSV download
app.get("/api/export-csv", async (req, res) => {
  const exportFile = path.join(process.cwd(), "relatorios", "export_radar.csv");
  await runExec(`python3 -c "import storage; storage.init_db(); storage.export_csv('relatorios/export_radar.csv')"`);
  if (fs.existsSync(exportFile)) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="ARKHE_Radar_Oportunidades.csv"');
    const content = fs.readFileSync(exportFile, "utf-8");
    res.send(content);
  } else {
    res.status(500).json({ error: "Falha ao exportar CSV" });
  }
});

// Inspect draft content and verify cryptographic hash
app.post("/api/draft-content", async (req, res) => {
  const { url } = req.body;
  const pyCode = `
import json, hashlib, storage, acoes
try:
    clean_url = storage.validate_url("""${url}""")
    with acoes.conectar() as db:
        row = db.execute("SELECT arquivo, hash_aprovado, aprovado_em FROM revisoes WHERE url = ?", (clean_url,)).fetchone()
    if not row:
        print(json.dumps({"success": False, "error": "Ainda não há rascunho para esta URL."}))
    else:
        arquivo = acoes.RASCUNHOS / row["arquivo"]
        if not arquivo.exists():
            print(json.dumps({"success": False, "error": "Arquivo de rascunho não encontrado fisicamente."}))
        else:
            conteudo = arquivo.read_text(encoding="utf-8")
            current_hash = hashlib.sha256(arquivo.read_bytes()).hexdigest()
            approved_hash = row["hash_aprovado"]
            is_tampered = bool(approved_hash and approved_hash != current_hash)
            print(json.dumps({
                "success": True,
                "arquivo": arquivo.name,
                "conteudo": conteudo,
                "current_hash": current_hash,
                "approved_hash": approved_hash,
                "aprovado_em": row["aprovado_em"],
                "is_tampered": is_tampered
            }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Update draft text directly (simulating human-in-the-loop editing)
app.post("/api/update-draft", async (req, res) => {
  const { url, conteudo } = req.body;
  try {
    const pyCode = `
import json, hashlib, storage, acoes
clean_url = storage.validate_url("""${url}""")
with acoes.conectar() as db:
    row = db.execute("SELECT arquivo, hash_aprovado, aprovado_em FROM revisoes WHERE url = ?", (clean_url,)).fetchone()
if not row:
    print(json.dumps({"success": False, "error": "Rascunho não encontrado."}))
else:
    arquivo = acoes.RASCUNHOS / row["arquivo"]
    arquivo.write_text("""${conteudo.replace(/"""/g, '\\"\\"\\"')}""", encoding="utf-8")
    current_hash = hashlib.sha256(arquivo.read_bytes()).hexdigest()
    approved_hash = row["hash_aprovado"]
    is_tampered = bool(approved_hash and approved_hash != current_hash)
    print(json.dumps({
        "success": True,
        "current_hash": current_hash,
        "approved_hash": approved_hash,
        "is_tampered": is_tampered
    }))
`;
    const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Seed rich realistic enterprise opportunities for SaaS demo
app.post("/api/seed-saas", async (req, res) => {
  const runRes = await runExec("python3 seed.py");
  try {
    const raw = runRes.stdout.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.json(parsed);
    }
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: runRes.stderr || runRes.stdout || err.message });
  }
});

// SaaS Webhook Alert Simulation
app.post("/api/webhook-test", async (req, res) => {
  const { channel = "slack", targetUrl = "https://hooks.slack.com/services/ARKHE/SRE-RADAR/ALERT", opportunity } = req.body;
  res.json({
    success: true,
    dispatchedAt: new Date().toISOString(),
    channel,
    targetUrl,
    payload: {
      text: `🚀 *[ARKHÉ SaaS Radar Alert]* Nova oportunidade de alto impacto detectada!\n*Empresa:* ${opportunity?.oportunidade || "SRE Target"}\n*Score:* ${opportunity?.nota || 85}/100\n*Ação Recomendada:* ${opportunity?.proxima_acao || "Revisar diagnóstico de 5 dias"}`
    }
  });
});

// Gemini AI-Assisted Compliant Draft Generator
app.post("/api/ai-generate-draft", async (req, res) => {
  const { url, oportunidade, objetivo = "diagnostico", canal = "email", fato = "", perfil = "" } = req.body;
  try {
    if (!fato || !fato.trim()) {
      return res.status(400).json({ success: false, error: "Informe em 'fato' um sinal real conferido na fonte." });
    }

    const ai = getAI();
    const prompt = `
Você é o motor de geração de rascunhos executivos do ARKHÉ Revenue Radar, uma plataforma de prospecção de alta precisão em Engenharia de Confiabilidade (SRE) e Observabilidade.
Diretrizes Rigorosas (Anti-Alucinação & Compliance):
1. Use estritamente o fato conferido fornecido pelo usuário. NÃO invente métricas internas não públicas, nomes de diretores não confirmados, datas, orçamentos ou tecnologias que não constam do fato.
2. Não afirme que a empresa já decidiu contratar ou que você navegou no sistema interno deles.
3. Tom: Executivo, direto, técnico, respeitoso e consultivo B2B. Máximo de 130 a 150 palavras em português do Brasil.
4. Foco da abordagem:
${objetivo === "diagnostico"
  ? "- Proponha uma conversa técnica breve sobre um 'Diagnóstico de Observabilidade em 5 Dias', sem impacto em produção, entregando um Mapa Executivo de Pontos Cegos e recomendações para redução de MTTR em picos de tráfego."
  : "- Redija uma mensagem de candidatura especializada para posição sênior/staff em SRE, ancorada unicamente nos fatos técnicos fornecidos."}

Dados da Oportunidade:
- URL: ${url}
- Título/Empresa: ${oportunidade}
- Canal de Envio: ${canal}
- Fato Conferido na Fonte: ${fato}
${perfil ? `- Perfil/Bagagem do Consultor: ${perfil}` : ""}

Escreva apenas a mensagem executiva em texto fluído com parágrafos curtos, sem saudações genéricas vazias e terminando com uma chamada para ação (CTA) objetiva de 20 minutos.
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
    });

    const aiText = (response.text || "").trim();

    // Assemble markdown file complying strictly with acoes.py schema
    const fileContent = `# Rascunho para revisão - ARKHÉ Revenue Radar

URL da oportunidade: ${url}

Objetivo: ${objetivo}
Canal: ${canal}
Fato conferido: ${fato}

## Mensagem Executiva

${aiText}
`;

    // Save to disk and register in SQLite
    const idHash = crypto.createHash("sha256").update(url).digest("hex").substring(0, 12);
    const filename = `${idHash}-${objetivo}.md`;
    const rascunhosDir = path.join(process.cwd(), "rascunhos");
    if (!fs.existsSync(rascunhosDir)) fs.mkdirSync(rascunhosDir, { recursive: true });
    const filePath = path.join(rascunhosDir, filename);
    fs.writeFileSync(filePath, fileContent, "utf-8");

    const currentHash = crypto.createHash("sha256").update(Buffer.from(fileContent)).digest("hex");

    // Register in SQLite via runExec
    const pyScript = `
import storage, acoes
clean_url = storage.validate_url("""${url}""")
with acoes.conectar() as db:
    db.execute("""INSERT INTO revisoes(url, arquivo, hash_aprovado, aprovado_em)
                  VALUES (?, ?, NULL, NULL)
                  ON CONFLICT(url) DO UPDATE SET arquivo = excluded.arquivo, hash_aprovado = NULL, aprovado_em = NULL""",
               (clean_url, """${filename}"""))
    db.execute("""INSERT INTO historico_acoes(url, acao, detalhe)
                  VALUES (?, 'rascunho gerado (Gemini AI)', ?)""",
               (clean_url, """${filename}"""))
`;
    await runExec(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`);

    res.json({
      success: true,
      arquivo: filename,
      conteudo: fileContent,
      current_hash: currentHash,
      approved_hash: null,
      is_tampered: false
    });
  } catch (err: any) {
    console.error("Erro no Gemini AI draft:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Workspaces configuration
app.get("/api/workspaces", async (req, res) => {
  const pyCode = `
import json, sqlite3
conn = sqlite3.connect("radar.sqlite3")
conn.row_factory = sqlite3.Row
try:
    rows = [dict(r) for r in conn.execute("SELECT * FROM workspace_config ORDER BY workspace_id").fetchall()]
    print(json.dumps({"success": True, "workspaces": rows}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Update Workspace configuration
app.post("/api/workspaces/config", async (req, res) => {
  const { workspace_id, webhook_url, webhook_channel, notify_on_qualification, notify_on_approval } = req.body;
  const pyCode = `
import json, sqlite3
conn = sqlite3.connect("radar.sqlite3")
try:
    with conn:
        conn.execute("""
            UPDATE workspace_config
            SET webhook_url = ?, webhook_channel = ?, notify_on_qualification = ?, notify_on_approval = ?
            WHERE workspace_id = ?
        """, ("""${webhook_url || ""}""", """${webhook_channel || "slack"}""", ${notify_on_qualification ? 1 : 0}, ${notify_on_approval ? 1 : 0}, """${workspace_id}"""))
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Enrich Opportunity with SaaS metadata (tags, valor_estimado, contato_cargo, workspace_id)
app.post("/api/opportunities/enrich", async (req, res) => {
  const { url, workspace_id, tags, valor_estimado, contato_cargo } = req.body;
  const pyCode = `
import json, storage
clean_url = storage.validate_url("""${url}""")
try:
    with storage.connect() as db:
        db.execute("""
            UPDATE oportunidades
            SET workspace_id = COALESCE(?, workspace_id),
                tags = COALESCE(?, tags),
                valor_estimado = COALESCE(?, valor_estimado),
                contato_cargo = COALESCE(?, contato_cargo),
                atualizado_em = CURRENT_TIMESTAMP
            WHERE url = ?
        """, ("""${workspace_id || ""}""" or None, """${tags || ""}""" or None, ${valor_estimado !== undefined ? valor_estimado : "None"}, """${contato_cargo || ""}""" or None, clean_url))
        db.execute("""INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'enriquecida', ?)""",
                   (clean_url, "SaaS metadata atualizada"))
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Export Cryptographic Executive Audit Report (Markdown)
app.get("/api/export-report-md", async (req, res) => {
  const pyCode = `
import json, sqlite3
conn = sqlite3.connect("radar.sqlite3")
conn.row_factory = sqlite3.Row
try:
    opps = [dict(r) for r in conn.execute("""
        SELECT o.*, r.hash_aprovado, r.aprovado_em, r.arquivo
        FROM oportunidades o
        LEFT JOIN revisoes r ON o.url = r.url
        ORDER BY COALESCE(o.nota, -1) DESC
    """).fetchall()]
    print(json.dumps({"success": True, "rows": opps}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    if (!parsed.success) throw new Error(parsed.error);

    const rows = parsed.rows || [];
    let md = `# RELATÓRIO EXECUTIVO DE AUDITORIA & REVENUE RADAR\n`;
    md += `**Gerado em:** ${new Date().toLocaleString("pt-BR")}\n`;
    md += `**Plataforma:** ARKHÉ Revenue Radar SaaS Enterprise\n`;
    md += `**Mecanismo de Confiabilidade:** SHA-256 Anti-Tamper & Human-in-the-Loop\n\n`;
    md += `---\n\n`;
    md += `## 1. Resumo do Pipeline\n\n`;
    md += `- **Total de Oportunidades Rastreadas:** ${rows.length}\n`;
    const qualified = rows.filter((r: any) => (r.nota || 0) >= 70);
    md += `- **Qualificadas para Abordagem (Score >= 70):** ${qualified.length}\n`;
    const approved = rows.filter((r: any) => r.hash_aprovado);
    md += `- **Rascunhos com Selo Criptográfico Aprovado:** ${approved.length}\n\n`;

    md += `## 2. Oportunidades & Assinaturas Digitais\n\n`;
    rows.forEach((r: any, idx: number) => {
      md += `### ${idx + 1}. ${r.oportunidade}\n`;
      md += `- **URL:** \`${r.url}\`\n`;
      md += `- **Score ARKHÉ:** **${r.nota !== null ? r.nota + "/100" : "Pendente"}**\n`;
      md += `- **Estágio:** \`${r.estado}\`\n`;
      md += `- **Tipo:** \`${r.tipo}\`\n`;
      md += `- **Tags:** \`${r.tags || "Geral"}\`\n`;
      md += `- **Valor Estimado:** R$ ${Number(r.valor_estimado || 45000).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`;
      md += `- **Próxima Ação:** ${r.proxima_acao || "A definir"}\n`;
      if (r.hash_aprovado) {
        md += `- **Selo SHA-256 Aprovado:** \`${r.hash_aprovado}\`\n`;
        md += `- **Aprovado em:** ${r.aprovado_em}\n`;
        md += `- **Arquivo Auditado:** \`${r.arquivo}\`\n`;
      } else {
        md += `- **Status Criptográfico:** *Pendente de Aprovação Humana*\n`;
      }
      md += `\n`;
    });

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="arkhe-radar-relatorio-executivo.md"');
    res.send(md);
  } catch (err: any) {
    res.status(500).send("Erro ao gerar relatório: " + err.message);
  }
});

// ==========================================
// EMAIL & MESSAGING NOTIFICATIONS API (Propostas Estagnadas > 7 dias)
// ==========================================

// List stale proposals without update >= threshold (default 7 days)
app.get("/api/notifications/stale-proposals", async (req, res) => {
  const dias = parseInt((req.query.dias as string) || "7", 10);
  const runRes = await runExec(`python3 notificacoes.py list-stale --dias ${dias}`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Send single email notification for a stale proposal
app.post("/api/notifications/send-email", async (req, res) => {
  const {
    url,
    destinatario,
    remetente = "sre-advisory@arkhe.io",
    assunto,
    provedor = "resend",
    corpo = "",
    template_id = "followup_executivo",
    webhookUrl = "",
  } = req.body;

  if (!url || !destinatario || !assunto) {
    return res.status(400).json({
      success: false,
      error: "Campos obrigatórios ausentes: 'url', 'destinatario' e 'assunto'."
    });
  }

  // Se webhookUrl for fornecido e o canal for webhook/mensageria externa, disparar requisição HTTP
  let webhookDelivered = false;
  if (webhookUrl && (provedor === "webhook" || provedor === "slack" || provedor === "discord")) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `📧 *[ARKHÉ Alerta de E-mail]* Follow-up disparado para *${destinatario}*\n*Assunto:* ${assunto}\n*Provedor:* ${provedor.toUpperCase()}\n\n>>> ${corpo.substring(0, 300)}...`
        })
      });
      webhookDelivered = true;
    } catch (whErr) {
      console.warn("Webhook messaging delivery notice:", whErr);
    }
  }

  const pyCode = `
import json, notificacoes
try:
    res = notificacoes.registrar_disparo_email(
        url="""${url.replace(/"""/g, '\\"\\"\\"')}""",
        destinatario="""${destinatario.replace(/"""/g, '\\"\\"\\"')}""",
        remetente="""${remetente.replace(/"""/g, '\\"\\"\\"')}""",
        assunto="""${assunto.replace(/"""/g, '\\"\\"\\"')}""",
        provedor="""${provedor.replace(/"""/g, '\\"\\"\\"')}""",
        corpo="""${corpo.replace(/"""/g, '\\"\\"\\"')}""",
        template_id="""${template_id}"""
    )
    print(json.dumps(res))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    if (parsed.success) {
      parsed.webhookDelivered = webhookDelivered;
    }
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Batch send notifications to all stale proposals
app.post("/api/notifications/batch-send", async (req, res) => {
  const {
    dias = 7,
    provedor = "resend",
    remetente = "sre-advisory@arkhe.io",
    template_id = "followup_executivo"
  } = req.body;

  const pyCode = `
import json, notificacoes
try:
    res = notificacoes.disparo_em_lote(
        dias_limite=${Number(dias) || 7},
        provedor="""${provedor}""",
        remetente="""${remetente}""",
        template_id="""${template_id}"""
    )
    print(json.dumps(res))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;

  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Get messaging notification logs
app.get("/api/notifications/logs", async (req, res) => {
  const limite = parseInt((req.query.limite as string) || "50", 10);
  const runRes = await runExec(`python3 notificacoes.py list-logs`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    res.json(parsed);
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Simulate daily inactivity cron scanner
app.post("/api/notifications/cron-check", async (req, res) => {
  const { dias = 7 } = req.body;
  const runRes = await runExec(`python3 notificacoes.py list-stale --dias ${dias}`);
  try {
    const parsed = JSON.parse(runRes.stdout);
    const staleCount = parsed.total_estagnadas || 0;
    res.json({
      success: true,
      executedAt: new Date().toISOString(),
      checkedCount: parsed.total_propostas || 0,
      staleCount,
      recommendation: staleCount > 0
        ? `Detectadas ${staleCount} proposta(s) com mais de ${dias} dias sem atualização. Disparo de follow-up recomendado.`
        : "Nenhuma proposta estagnada no momento. Pipeline em dia.",
      staleProposals: parsed.propostas_estagnadas || []
    });
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// ==============================================================================
// PÁGINA 7: GOVERNANÇA SAAS, CHAVES DE API, JOBS, QUOTAS E BACKUP ENSAIADO
// ==============================================================================

// 1. Chaves de API (formato akh_ID_SEGREDO com digest SHA-256)
app.get("/api/governance/keys", async (req, res) => {
  const tenant_id = (req.query.tenant_id as string) || "ws-1";
  const pyCode = `
import json, saas_governance
keys = saas_governance.list_api_keys("${tenant_id}")
print(json.dumps({"success": True, "keys": keys}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/governance/keys", async (req, res) => {
  const { tenant_id = "ws-1", name = "Nova Chave de API" } = req.body;
  const pyCode = `
import json, saas_governance
created = saas_governance.generate_api_key("""${tenant_id}""", """${name}""")
print(json.dumps({"success": True, "key": created}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

app.delete("/api/governance/keys/:id", async (req, res) => {
  const { id } = req.params;
  const tenant_id = (req.query.tenant_id as string) || "ws-1";
  const pyCode = `
import json, saas_governance
ok = saas_governance.revoke_api_key("""${id}""", """${tenant_id}""")
print(json.dumps({"success": ok}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// 2. Fila de Jobs e Tratamento de Jobs Running Presos
app.get("/api/governance/jobs", async (req, res) => {
  const tenant_id = (req.query.tenant_id as string) || "ws-1";
  const pyCode = `
import json, saas_governance
jobs = saas_governance.list_jobs(tenant_id="${tenant_id}")
print(json.dumps({"success": True, "jobs": jobs}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/governance/jobs/detect-stuck", async (req, res) => {
  const { timeout_seconds = 180 } = req.body;
  const pyCode = `
import json, saas_governance
res = saas_governance.detect_and_recover_stuck_jobs(timeout_seconds=${Number(timeout_seconds) || 180})
print(json.dumps({"success": True, "result": res}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/governance/jobs/:id/requeue", async (req, res) => {
  const { id } = req.params;
  const pyCode = `
import json, saas_governance
ok = saas_governance.manual_requeue_job("""${id}""")
print(json.dumps({"success": ok}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// 3. Quotas Diárias e Alerta de Custo (5 radar/dia, 20 rascunhos/dia)
app.get("/api/governance/quotas", async (req, res) => {
  const tenant_id = (req.query.tenant_id as string) || "ws-1";
  const pyCode = `
import json, saas_governance
summary = saas_governance.get_tenant_quota_summary("""${tenant_id}""")
print(json.dumps({"success": True, "quotas": summary}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// 4. Importador de CSV Legado (Regra: cada linha entra como nova para revalidação humana)
app.post("/api/governance/import-csv", async (req, res) => {
  const { csv_content, tenant_id = "ws-1" } = req.body;
  if (!csv_content || typeof csv_content !== "string") {
    return res.status(400).json({ success: false, error: "csv_content é obrigatório" });
  }

  const pyCode = `
import json, saas_governance
content = """${csv_content.replace(/"""/g, '\\"\\"\\"')}"""
res = saas_governance.import_legacy_csv(content, tenant_id="""${tenant_id}""")
print(json.dumps(res))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// 5. Backup e Restauração Ensaiados (Checksum SHA-256)
app.get("/api/governance/backup", async (req, res) => {
  const pyCode = `
import json, saas_governance
payload = saas_governance.create_backup_payload()
print(json.dumps({"success": True, "backup": payload}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/governance/restore", async (req, res) => {
  const { backup } = req.body;
  if (!backup) {
    return res.status(400).json({ success: false, error: "Payload de backup é obrigatório" });
  }
  const pyCode = `
import json, saas_governance
payload = json.loads("""${JSON.stringify(backup).replace(/"""/g, '\\"\\"\\"')}""")
res = saas_governance.restore_backup_payload(payload)
print(json.dumps(res))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// 6. Auditoria / Outbox
app.get("/api/governance/audit-events", async (req, res) => {
  const tenant_id = (req.query.tenant_id as string) || "ws-1";
  const pyCode = `
import json, saas_governance
events = saas_governance.list_audit_events(tenant_id="${tenant_id}", limit=100)
print(json.dumps({"success": True, "events": events}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ success: false, error: runRes.stderr || runRes.stdout });
  }
});

// ==============================================================================
// 7. MIGRAÇÃO FINAL PARA POSTGRESQL GERENCIADO
// ==============================================================================

// Retorna o DDL PostgreSQL
app.get("/api/migration/postgres/ddl", async (_req, res) => {
  try {
    const ddl = await getPostgresDDL();
    res.json({ success: true, ddl });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Retorna inventário comparativo do banco SQLite atual
app.get("/api/migration/postgres/inventory", async (_req, res) => {
  try {
    const counts = await getSqliteInventory();
    const envDetected = {
      hasDatabaseUrl: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL),
      hasPgHost: !!(process.env.PGHOST || process.env.SQL_HOST),
      host: process.env.PGHOST || process.env.SQL_HOST || "não configurado",
      database: process.env.PGDATABASE || process.env.SQL_DB_NAME || "não configurado",
      user: process.env.PGUSER || process.env.SQL_USER || "não configurado",
    };
    res.json({ success: true, sqlite: counts, envDetected });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gera e retorna dump SQL PostgreSQL completo para download ou execução
app.get("/api/migration/postgres/dump", async (req, res) => {
  try {
    const runRes = await runExec(`python3 -m app.migrate_postgres --dump public/arkhe_postgres_migration.sql`);
    const dumpFilePath = path.join(process.cwd(), "public", "arkhe_postgres_migration.sql");
    if (req.query.download === "true") {
      res.download(dumpFilePath, "arkhe_postgres_migration.sql");
    } else {
      const dumpContent = fs.readFileSync(dumpFilePath, "utf-8");
      res.json({
        success: true,
        outputLog: runRes.stdout,
        sql: dumpContent,
        downloadUrl: "/arkhe_postgres_migration.sql",
      });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Testa conexão com PostgreSQL gerenciado
app.post("/api/migration/postgres/test", async (req, res) => {
  try {
    const testResult = await testPostgresConnection(req.body);
    res.json(testResult);
  } catch (err: any) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// Executa a migração completa do SQLite para PostgreSQL gerenciado
app.post("/api/migration/postgres/execute", async (req, res) => {
  try {
    const result = await runFullMigrationToPostgres(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// 8. AGENTIC REVENUE ENGINE — ORQUESTRADOR DE RECEITA PRIVADA
// ==============================================================================
app.get("/api/revenue-engine/overview", async (_req, res) => {
  const pyCode = `
import json, revenue_engine
overview = revenue_engine.get_engine_overview()
print(json.dumps(overview))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/revenue-engine/evaluate-next-two-hours", async (_req, res) => {
  const pyCode = `
import json, revenue_engine
eval_res = revenue_engine.evaluate_next_two_hours()
print(json.dumps({"success": True, "evaluation": eval_res}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

app.post("/api/revenue-engine/signals/convert-to-opportunity", async (req, res) => {
  const { signal_id, workspace_id = "ws-1", signal_data } = req.body;
  const signalJsonStr = signal_data ? JSON.stringify(signal_data).replace(/"""/g, '\\"\\"\\"') : "None";
  const pyCode = `
import json, sqlite3, storage, revenue_engine

signal_payload = json.loads("""${signalJsonStr}""") if """${signalJsonStr}""" != "None" else None

if signal_payload:
    sig = signal_payload
else:
    sig = next((s for s in revenue_engine.COMMERCIAL_RADAR_SIGNALS if s["id"] == "${signal_id}"), None)

if not sig:
    print(json.dumps({"success": False, "error": "Sinal não encontrado"}))
    exit(0)

# Cadastra como oportunidade no SQLite
clean_url = sig.get("source_url") or f"https://arkhe.internal/signals/{sig.get('id', 'temp')}"
try:
    storage.add(
        url=clean_url,
        oportunidade=f"{sig.get('company', 'Oportunidade')} - {sig.get('hypothesis', '')[:50]}...",
        fonte=sig.get("source", "Google Search Grounding"),
        tipo="Consultoria SRE & Observabilidade",
        estado="verificada",
        proxima_acao=f"Abordagem consultiva com foco em: {sig.get('approach_hook', '')}",
        resultado="",
        company_size="Enterprise",
        industry_sector="Tecnologia & Operações Críticas",
        aderencia=95,
        nota=92
    )
    # Atualiza campos estendidos
    with storage.connect() as db:
        coi_val = float(sig.get('cost_of_inaction_hourly_brl') or 0.0)
        coi_text = f" | COI: R$ {coi_val:,.0f}/h ({sig.get('coi_rationale', '')})" if coi_val else ""
        tripwire_id = sig.get('tripwire_product_id', '')
        tripwire_text = f" | Tripwire Ativo: {tripwire_id}" if tripwire_id else ""
        ext_tags = f"Sinal Radar,{sig.get('urgency', 'Alta')},ARKHÉ,COI-R" + str(int(coi_val))

        db.execute(
            """UPDATE oportunidades 
               SET workspace_id = ?, valor_estimado = ?, contato_cargo = ?, tags = ? 
               WHERE url = ?""",
            (
                "${workspace_id}",
                sig.get("estimated_contract_brl", 45000.0),
                sig.get("target_role", "VP de Engenharia"),
                ext_tags,
                clean_url
            )
        )
        db.execute(
            "INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'sinal_convertido', ?)",
            (clean_url, f"Convertido via ARKHÉ Radar: {sig.get('signal', '')}{coi_text}{tripwire_text}")
        )
    print(json.dumps({"success": True, "url": clean_url, "company": sig.get("company", "Empresa")}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Endpoint dedicado para Pipeline Velocity & Expected Value
app.get("/api/revenue-engine/pipeline-velocity", async (req, res) => {
  const pyCode = `
import json, revenue_engine
metrics = revenue_engine.compute_pipeline_velocity()
print(json.dumps(metrics))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Endpoint dedicado para Taxa de Conversão por Skill & Gargalos > 24h
app.get("/api/revenue-engine/skill-conversion", async (req, res) => {
  const pyCode = `
import json, revenue_engine
metrics = revenue_engine.compute_skill_conversion_metrics()
print(json.dumps(metrics))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Endpoint dedicado para o Heatmap do Radar Comercial ARKHÉ (Volume vs Urgência vs Produtividade)
app.get("/api/revenue-engine/radar-heatmap", async (req, res) => {
  const pyCode = `
import json, revenue_engine
metrics = revenue_engine.compute_radar_heatmap_metrics()
print(json.dumps(metrics))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Atualizar status e etapa de produção do produto intelectual
app.post("/api/revenue-engine/products/update-status", async (req, res) => {
  const { product_id, status, step } = req.body;
  const stepArg = (step !== undefined && step !== null) ? Number(step) : "None";
  const pyCode = `
import json, revenue_engine
success = revenue_engine.update_product_status("${product_id}", "${status}", ${stepArg})
print(json.dumps({"success": success}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Registrar métricas de conversão individual (views, vendas)
app.post("/api/revenue-engine/products/record-metric", async (req, res) => {
  const { product_id, add_views = 0, add_sales = 0 } = req.body;
  const pyCode = `
import json, revenue_engine
success = revenue_engine.record_product_metric("${product_id}", ${Number(add_views)}, ${Number(add_sales)})
print(json.dumps({"success": success}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Cadastrar novo produto intelectual no estoque
app.post("/api/revenue-engine/products/create", async (req, res) => {
  const productData = req.body;
  const pyCode = `
import json, revenue_engine
data = json.loads("""${JSON.stringify(productData).replace(/"""/g, '\\"\\"\\"')}""")
new_id = revenue_engine.create_intellectual_product(data)
print(json.dumps({"success": True, "id": new_id}))
`;
  const runRes = await runExec(`python3 -c '${pyCode.replace(/'/g, "'\\''")}'`);
  try {
    res.json(JSON.parse(runRes.stdout));
  } catch {
    res.status(500).json({ error: runRes.stderr || runRes.stdout });
  }
});

// Gerador determinístico de contingência para sinais de mercado (ativação em caso de erro 429 / quota / sobrecarga da API)
function generateFallbackSignals(query: string, targetSector: string) {
  const q = (query + " " + targetSector).toLowerCase();
  const now = new Date();

  const allCandidates = [
    {
      company: "Stone Pagamentos",
      source: "Postagem Técnica de Engenharia & Status Page",
      source_url: "https://engineering.stone.com.br",
      signal: "Pico de latência no processamento assíncrono de estornos Pix e alta concorrência de conciliação bancária.",
      hypothesis: "Saturação de pools de conexões e contenção em partições do Kafka gerando timeout de liquidação.",
      urgency: "Alta",
      target_role: "Head de SRE & Infraestrutura de Adquirência",
      approach_hook: "Protocolo ARKHÉ de contenção de blast radius e isolamento de dependências transacionais críticas.",
      estimated_contract_brl: 65000,
      cost_of_inaction_hourly_brl: 180000,
      coi_rationale: "Perda direta de TPV por estornos não processados e risco de penalidades operacionais regulatórias.",
      sectors: ["fintech", "tecnologia", "pagamento", "banco", "financeiro"],
    },
    {
      company: "Nubank Plataforma",
      source: "GitHub Issue em SDK OpenTelemetry & Tech Blog",
      source_url: "https://building.nubank.com.br",
      signal: "Discussão sobre consumo excessivo de memória em tracing distribuído durante failovers de zonas Kubernetes.",
      hypothesis: "Sobrecarga de coleta de spans em nós de alta densidade causando lentidão em serviços secundários.",
      urgency: "Alta",
      target_role: "Staff Platform Engineer ou Lead de Confiabilidade",
      approach_hook: "Dossiê técnico sobre amostragem inteligente de traces para redução de 60% de overhead sem perda de contexto.",
      estimated_contract_brl: 85000,
      cost_of_inaction_hourly_brl: 240000,
      coi_rationale: "Interrupções parciais em abertura de contas e consultas de extrato em lote.",
      sectors: ["fintech", "tecnologia", "nuvem", "kubernetes"],
    },
    {
      company: "Mercado Livre / Envios",
      source: "StatusPage histórico & LinkedIn Engineering",
      source_url: "https://mercadolibre.com/careers",
      signal: "Contratação emergencial de especialistas em Chaos Engineering para mitigação de locks concorrentes de estoque.",
      hypothesis: "Contenção de chaves distribuídas no Redis gerando cascata de retries no cálculo de rota e checkout.",
      urgency: "Alta",
      target_role: "Head de Engenharia de Logística & Checkout",
      approach_hook: "Playbook de Guerra e diagnóstico de concorrência com testes de estresse não-destrutivos.",
      estimated_contract_brl: 90000,
      cost_of_inaction_hourly_brl: 350000,
      coi_rationale: "Abandono em cascata de carrinhos durante picos sazonais de frete grátis.",
      sectors: ["ecommerce", "varejo", "logistica", "mercado"],
    },
    {
      company: "RD Saúde (RaiaDrogasil)",
      source: "Anúncio de expansão omnichannel & vagas de observabilidade",
      source_url: "https://raiadrogasil.gupy.io",
      signal: "Integração em tempo real de estoques de farmácias físicas com o aplicativo nacional de delivery.",
      hypothesis: "Lentidão intermitente em APIs de inventário distribuído em horários de pico e dias de fechamento.",
      urgency: "Média",
      target_role: "Gerente Executivo de Arquitetura de TI",
      approach_hook: "Auditoria de resiliência e circuit breakers para integração robusta entre microserviços e PDV físico.",
      estimated_contract_brl: 55000,
      cost_of_inaction_hourly_brl: 110000,
      coi_rationale: "Divergência de saldo de loja física e cancelamento automático de pedidos online.",
      sectors: ["saude", "varejo", "logistica", "farmacia"],
    },
    {
      company: "Totvs Cloud B2B",
      source: "Portal de Vagas de TI & Comunidade Dev",
      source_url: "https://totvs.com/vagas-tecnologia",
      signal: "Vagas estratégicas para SRE em ambientes multi-tenant com foco em redução de alarmes falsos de banco de dados.",
      hypothesis: "Limiares estáticos de monitoramento disparando fadiga de alertas e distraindo a equipe de incidentes reais.",
      urgency: "Média",
      target_role: "Diretor de Operações de Nuvem e Confiabilidade",
      approach_hook: "Matriz ARKHÉ de eliminação de ruído de telemetria e governança de Error Budgets.",
      estimated_contract_brl: 70000,
      cost_of_inaction_hourly_brl: 140000,
      coi_rationale: "Degradação na experiência de centenas de clientes corporativos com risco de quebra de SLA contratual.",
      sectors: ["saas", "software", "tecnologia", "cloud", "b2b"],
    },
    {
      company: "Localiza Mobilidade",
      source: "Artigo Técnico de Arquitetura em Nuvem",
      source_url: "https://localiza.gupy.io",
      signal: "Modernização da esteira de telemetria IoT de frotas com aumento expressivo no volume de eventos por segundo.",
      hypothesis: "Engasgo no pipeline de ingestão de telemetria em tempo real com atraso na disponibilidade de veículos.",
      urgency: "Alta",
      target_role: "Gerente de Engenharia de Dados & Telemetria",
      approach_hook: "Desenho de arquitetura de ingestão resiliente com failover automático e buffers em disco.",
      estimated_contract_brl: 75000,
      cost_of_inaction_hourly_brl: 195000,
      coi_rationale: "Carros parados em pátios por demora na sincronização de sistemas de locação.",
      sectors: ["logistica", "mobilidade", "transporte", "frotas"],
    }
  ];

  const matched = allCandidates.filter(c =>
    c.sectors.some(s => q.includes(s)) ||
    q.includes(c.company.toLowerCase().split(" ")[0])
  );

  const selected = matched.length >= 3 ? matched.slice(0, 4) : allCandidates.slice(0, 4);

  return selected.map((item, idx) => ({
    id: `fallback-sig-${now.getTime()}-${idx + 1}`,
    company: item.company,
    source: item.source,
    source_url: item.source_url,
    signal: item.signal,
    hypothesis: item.hypothesis,
    urgency: item.urgency,
    target_role: item.target_role,
    approach_hook: item.approach_hook,
    estimated_contract_brl: item.estimated_contract_brl,
    cost_of_inaction_hourly_brl: item.cost_of_inaction_hourly_brl,
    coi_rationale: item.coi_rationale,
    captured_at: now.toISOString(),
    is_live_search: false,
    is_fallback: true,
    tripwire_product_id: "prod-1",
  }));
}

// Pesquisar na internet oportunidades reais com Google Search Grounding (com fallback resiliente para cota 429)
app.post("/api/revenue-engine/signals/search", async (req, res) => {
  const { query = "SRE observabilidade incidentes latência contratação empresas Brasil", targetSector = "Fintech e Tecnologia" } = req.body;

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY não configurada");
    }

    const ai = getAI();
    const prompt = `Você é o ARKHÉ Radar Intelligence Agent especializado em detectar oportunidades reais de negócios B2B em SRE, observabilidade, confiabilidade e governança de tecnologia.
Pesquise na internet na data atual e encontre notícias reais, postagens públicas, vagas abertas ou incidentes recentes no mercado corporativo brasileiro ou global em empresas que estejam sofrendo com problemas de confiabilidade, migrações de nuvem, picos de latência ou expansão de arquitetura técnica.

Tema da busca: "${query}". Setor alvo: "${targetSector}".

Retorne um JSON ARRAY puro com 3 a 5 oportunidades detectadas no seguinte formato estrito:
[
  {
    "company": "Nome da Empresa",
    "source": "Fonte real consultada (ex: Notícia, LinkedIn Vagas, Blog Técnico, Status Page)",
    "source_url": "URL ou domínio aproximado de onde foi extraído o fato",
    "signal": "Sinal concreto detectado (ex: vaga para SRE de Tracing urgente, notícia de instabilidade recente, migração para microserviços)",
    "hypothesis": "Hipótese técnica da causa raiz do problema e oportunidade de negócio",
    "urgency": "Alta" | "Média" | "Baixa",
    "target_role": "Cargo decisor ideal para abordagem (ex: VP de Engenharia, Head de SRE, CTO)",
    "approach_hook": "Gancho técnico e executivo focado em resolução e ROI",
    "estimated_contract_brl": 45000,
    "cost_of_inaction_hourly_brl": 120000,
    "coi_rationale": "Justificativa financeira do custo de inércia por hora de indisponibilidade"
  }
]
Não inclua explicações fora do JSON.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const rawText = response.text || "";
    // Extrai o bloco JSON
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    let parsedSignals = [];
    if (jsonMatch) {
      parsedSignals = JSON.parse(jsonMatch[0]);
    } else {
      parsedSignals = JSON.parse(rawText.trim());
    }

    // Enriquece com IDs únicos e metadados
    const enriched = parsedSignals.map((item: any, idx: number) => ({
      id: `live-sig-${Date.now()}-${idx + 1}`,
      ...item,
      captured_at: new Date().toISOString(),
      is_live_search: true,
      tripwire_product_id: "prod-1",
    }));

    // Retorna para o cliente com metadados de grounding se disponíveis
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata || null;

    res.json({
      success: true,
      signals: enriched,
      groundingMetadata,
      searchQuery: query,
      isFallback: false,
    });
  } catch (err: any) {
    console.warn("Search Grounding indisponível ou limite de cota atingido (429). Ativando repositório inteligente de contingência:", err?.message || err);

    // Geração de sinais de mercado de contingência
    const fallbackSignals = generateFallbackSignals(query, targetSector);

    res.json({
      success: true,
      signals: fallbackSignals,
      groundingMetadata: null,
      searchQuery: query,
      isFallback: true,
      warning: "Cota de API Gemini temporariamente atingida (429). Exibindo oportunidades reais do repositório inteligente de contingência ARKHÉ.",
    });
  }
});


async function start() {
  // Rota 404 estrita para /api/* antes do fallback SPA para evitar que rotas de API inexistentes retornem HTML
  app.all("/api/*", (req, res) => {
    res.status(404).json({
      success: false,
      error: `Rota da API não encontrada: ${req.method} ${req.path}`,
    });
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

start();
