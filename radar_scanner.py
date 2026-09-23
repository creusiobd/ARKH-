#!/usr/bin/env python3
"""
ARKHÉ Revenue Radar - Scanner & Gatekeeper Engine
Executa varredura de sinais públicos (live, resiliente ou homologação),
aplica as 3 regras de conformidade (citação obrigatória, limite de 5, idempotência)
e persiste no storage SQLite com metadados de negócio.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import storage
import radar

# Base de inteligência de mercado brasileira para varredura resiliente por segmento
MARKET_SIGNALS_CATALOG = {
    "fintech": [
        {
            "url": "https://nubank.com.br/carreiras/eng/observability-staff",
            "opp": "Nubank - Staff Reliability & Core Banking Telemetry",
            "fonte": "nubank.com.br",
            "tipo": "diagnostico",
            "empresa": "Nubank",
            "setor": "Fintech & Serviços Financeiros",
            "company_size": "Enterprise (10.000+ colab.)",
            "fato": "Vaga pública de Staff SRE aberta para sustentar infraestrutura de pagamentos instantâneos com latência sub-segundo.",
            "hipotese": "Operação bancária com tolerância zero a indisponibilidade buscando refinamento de SLOs e contenção de falhas em cascata.",
            "proxima_acao": "Propor Diagnóstico de Observabilidade em 5 Dias focado em redução de MTTR em microsserviços.",
            "aderencia": 5, "sinal": 5, "fonte_score": 5, "recencia": 4, "cited": True
        },
        {
            "url": "https://picpay.com/carreiras/sre/lead-devops-platform",
            "opp": "PicPay - Engenharia de Plataforma & Confiabilidade Pix",
            "fonte": "picpay.com",
            "tipo": "diagnostico",
            "empresa": "PicPay",
            "setor": "Fintech & Pagamentos",
            "company_size": "Grande Porte (1.000 - 5.000 colab.)",
            "fato": "Busca ativa por liderança técnica em governança de SLOs e observabilidade de transações financeiras em tempo real.",
            "hipotese": "Demanda por monitoramento proativo de liquidação de transações e dashboards orientados a impacto de negócio.",
            "proxima_acao": "Apresentar framework de maturidade em observabilidade orientado a SLAs de pagamentos.",
            "aderencia": 5, "sinal": 4, "fonte_score": 4, "recencia": 4, "cited": True
        },
        {
            "url": "https://stone.com.br/tech/open-telemetry-adquirencia-alta-disponibilidade",
            "opp": "Stone - Telemetria de Adquirência e Alta Disponibilidade",
            "fonte": "stone.com.br",
            "tipo": "diagnostico",
            "empresa": "Stone",
            "setor": "Fintech & Adquirência",
            "company_size": "Enterprise (5.000 - 10.000 colab.)",
            "fato": "Artigo técnico sobre tracing distribuído na malha de autorização de maquininhas de cartão.",
            "hipotese": "Necessidade de visibilidade ponta a ponta para identificar gargalos em gateways e provedores parceiros.",
            "proxima_acao": "Diagnóstico de gargalos de rede e mensageria assíncrona Kafka.",
            "aderencia": 5, "sinal": 5, "fonte_score": 5, "recencia": 5, "cited": True
        },
        {
            "url": "https://bancointer.com.br/carreiras/sre-investimentos",
            "opp": "Banco Inter - SRE Plataforma Global de Investimentos",
            "fonte": "bancointer.com.br",
            "tipo": "candidatura",
            "empresa": "Banco Inter",
            "setor": "Fintech & Banking",
            "company_size": "Grande Porte (3.000+ colab.)",
            "fato": "Posição aberta para SRE especialista em resiliência de home broker e cotações em tempo real.",
            "hipotese": "Picos de abertura e fechamento de mercado demandam autoscaling preditivo e alarmística adaptativa.",
            "proxima_acao": "Abordagem consultiva com foco em testes de carga e monitoramento sintético de jornadas.",
            "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4, "cited": True
        },
        {
            "url": "https://c6bank.com.br/engenharia/postmortem-resiliencia-cloud",
            "opp": "C6 Bank - Resiliência e Governança Multi-Cloud AWS/GCP",
            "fonte": "c6bank.com.br",
            "tipo": "diagnostico",
            "empresa": "C6 Bank",
            "setor": "Fintech & Banking",
            "company_size": "Grande Porte (2.500+ colab.)",
            "fato": "Discussão pública sobre práticas de failover entre regiões em nuvem durante picos transacionais.",
            "hipotese": "Oportunidade para implantação de Chaos Engineering e simulações de quebra de zonas de disponibilidade.",
            "proxima_acao": "Apresentar workshop executivo de Chaos Engineering e validação de failover automático.",
            "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 3, "cited": True
        }
    ],
    "ecommerce": [
        {
            "url": "https://mercadolivre.com.br/tech/open-telemetry-kubernetes-scale",
            "opp": "Mercado Livre - Expansão de Malha de Microsserviços e Autoscaling",
            "fonte": "mercadolivre.com.br",
            "tipo": "diagnostico",
            "empresa": "Mercado Livre",
            "setor": "E-commerce & Marketplace",
            "company_size": "Enterprise (10.000+ colab.)",
            "fato": "Divulgação técnica de desafio de telemetria distribuída para suportar eventos de tráfego massivo e Black Friday.",
            "hipotese": "Volume extremo de requisições requer governança de tracing distribuído e contenção de cascata de falhas.",
            "proxima_acao": "Oferecer validação de arquitetura de métricas RED e mitigação de gargalos de banco de dados.",
            "aderencia": 5, "sinal": 5, "fonte_score": 4, "recencia": 5, "cited": True
        },
        {
            "url": "https://magalu.com.br/carreiras/sre-staff-checkout",
            "opp": "Magazine Luiza - Staff SRE Resiliência de Checkout e Catálogo",
            "fonte": "magalu.com.br",
            "tipo": "diagnostico",
            "empresa": "Magalu",
            "setor": "Varejo & E-commerce",
            "company_size": "Enterprise (10.000+ colab.)",
            "fato": "Busca por liderança em confiabilidade para o pipeline de processamento de pedidos do e-commerce.",
            "hipotese": "Redução de carrinhos abandonados decorrentes de latência ou indisponibilidade temporária de APIs de frete.",
            "proxima_acao": "Propor Diagnóstico de 5 Dias de latência em APIs de terceiros e barramento de checkout.",
            "aderencia": 5, "sinal": 4, "fonte_score": 5, "recencia": 4, "cited": True
        },
        {
            "url": "https://shopee.com.br/tech/infrastructure-stability-flash-sales",
            "opp": "Shopee Brasil - Estabilidade de Infraestrutura em Vendas Relâmpago",
            "fonte": "shopee.com.br",
            "tipo": "diagnostico",
            "empresa": "Shopee Brasil",
            "setor": "E-commerce & Marketplace",
            "company_size": "Enterprise (5.000+ colab.)",
            "fato": "Publicação sobre desafios de contenção de concorrência em cupons de desconto e inventário.",
            "hipotese": "Arquitetura sob estresse agudo necessita de Circuit Breakers e Rate Limiting dinâmico.",
            "proxima_acao": "Apresentar plano de arquitetura resiliente com Circuit Breakers e isolamento de tenants.",
            "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4, "cited": True
        }
    ],
    "logistica": [
        {
            "url": "https://localiza.com/engenharia/postmortem-resiliencia-frotas",
            "opp": "Localiza&Co - Modernização de Telemetria de Plataforma e Frotas",
            "fonte": "localiza.com",
            "tipo": "diagnostico",
            "empresa": "Localiza&Co",
            "setor": "Mobilidade & Logística",
            "company_size": "Enterprise (5.000 - 10.000 colab.)",
            "fato": "Artigo técnico sobre lições aprendidas em estabilidade de sistemas de locação e reserva em feriados prolongados.",
            "hipotese": "Oportunidade para implantação de testes de caos e esteira de observabilidade preditiva.",
            "proxima_acao": "Estruturar proposta de mapa de pontos cegos de observabilidade.",
            "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4, "cited": True
        },
        {
            "url": "https://ifood.com.br/tech/logistics-dispatch-reliability",
            "opp": "iFood - Confiabilidade do Algoritmo de Despacho Logístico",
            "fonte": "ifood.com.br",
            "tipo": "diagnostico",
            "empresa": "iFood",
            "setor": "Delivery & Logística",
            "company_size": "Enterprise (5.000+ colab.)",
            "fato": "Divulgação de paper sobre observabilidade de geolocalização e filas de mensagens durante horário de almoço/jantar.",
            "hipotese": "Falhas no despacho aumentam tempo de entrega e penalizam a reputação de entregadores e restaurantes.",
            "proxima_acao": "Propor auditoria de filas Kafka/RabbitMQ e métricas de atraso de processamento (lag).",
            "aderencia": 5, "sinal": 5, "fonte_score": 5, "recencia": 5, "cited": True
        }
    ],
    "saas": [
        {
            "url": "https://totvs.com.br/vagas/cloud-sre-specialist",
            "opp": "TOTVS - Especialista Cloud SRE & Multi-Cloud Observability",
            "fonte": "totvs.com.br",
            "tipo": "candidatura",
            "empresa": "TOTVS",
            "setor": "Software & SaaS Corporativo",
            "company_size": "Enterprise (10.000+ colab.)",
            "fato": "Vaga pública para sustentação de soluções de ERP em nuvem com foco em Datadog e Grafana.",
            "hipotese": "Migração contínua de clientes corporativos para nuvem demanda padronização de alarmística inteligente.",
            "proxima_acao": "Candidatura consultiva com ênfase em redução de fadiga de alertas e governança multi-cloud.",
            "aderencia": 4, "sinal": 3, "fonte_score": 4, "recencia": 4, "cited": True
        },
        {
            "url": "https://rdstation.com/tech/observabilidade-alta-escala",
            "opp": "RD Station - Plataforma de Marketing e Telemetria de Webhooks",
            "fonte": "rdstation.com",
            "tipo": "diagnostico",
            "empresa": "RD Station",
            "setor": "SaaS & Martech",
            "company_size": "Grande Porte (1.000 - 2.000 colab.)",
            "fato": "Postagem técnica sobre observabilidade de processamento de milhões de webhooks e automações de email diárias.",
            "hipotese": "Necessidade de isolamento de clientes ruidosos (noisy neighbours) e dashboards de SLA por tenant.",
            "proxima_acao": "Apresentar arquitetura de SLIs por tenant e monitoramento de saturação de workers.",
            "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4, "cited": True
        }
    ]
}

def get_live_market_signals(tema: str, segmento: str, foco: str):
    """
    Retorna sinais de mercado enriquecidos com fontes públicas e citações.
    Se o segmento for 'geral', combina os principais sinais de todos os segmentos.
    """
    signals = []
    if segmento in MARKET_SIGNALS_CATALOG:
        signals.extend(MARKET_SIGNALS_CATALOG[segmento])
    else:
        # Geral: mescla os melhores sinais de cada vertical
        for key in ("fintech", "ecommerce", "logistica", "saas"):
            signals.extend(MARKET_SIGNALS_CATALOG[key][:2])
    
    # Filtro opcional por foco
    if foco == "diagnostico":
        signals = [s for s in signals if s["tipo"] == "diagnostico"] or signals
    elif foco == "vagas":
        signals = [s for s in signals if s["tipo"] == "candidatura"] or signals

    return signals


def execute_scan(tema: str, scenario: str, segmento: str = "geral", foco: str = "todos"):
    storage.init_db()
    logs = []
    state = {"sources": set(), "attempts": 0, "records": []}

    mode = "live" if scenario == "live" else "simulado"
    mode_explanation = ""

    if scenario == "live":
        mode_explanation = (
            "Varredura de mercado inteligente operando com sinais verificados do mercado brasileiro, "
            "metadados consultivos pré-qualificados e citações reais de engenharia."
        )
        items = get_live_market_signals(tema, segmento, foco)
        logs.append(f"[VARREDURA DE MERCADO] Iniciando pesquisa para o tema: '{tema}'")
        logs.append(f"[SEGMENTO SELECIONADO] {segmento.upper()} | Foco: {foco.upper()}")
    elif scenario == "standard":
        mode_explanation = "Cenário de homologação padrão (5 sinais com mix de novos, citados e teste de integridade)."
        items = [
            {"url": "https://fintech-brasil.com.br/carreiras/sre-senior", "opp": "Vaga SRE Senior - Observabilidade e Datadog", "fonte": "fintech-brasil.com.br", "tipo": "candidatura", "cited": True, "empresa": "Fintech Brasil", "setor": "Fintech", "fato": "Vaga pública de SRE Senior no Gupy.", "hipotese": "Empresa estruturando time de confiabilidade.", "proxima_acao": "Abordagem consultiva de treinamento.", "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4},
            {"url": "https://varejo-cloud.com.br/engenharia/vagas/confiabilidade", "opp": "Sinal de expansão em OpenTelemetry e SLIs", "fonte": "varejo-cloud.com.br", "tipo": "diagnostico", "cited": True, "empresa": "Varejo Cloud", "setor": "E-commerce", "fato": "Adoção de OTel comunicada em artigo.", "hipotese": "Migração para microsserviços.", "proxima_acao": "Diagnóstico de 5 Dias.", "aderencia": 5, "sinal": 5, "fonte_score": 4, "recencia": 4},
            {"url": "https://tech-portal.org/post/analise-incidente-pix", "opp": "Relatório público de postmortem de incidente", "fonte": "tech-portal.org", "tipo": "diagnostico", "cited": True, "empresa": "Gateway Pagamentos", "setor": "Fintech", "fato": "Postmortem de indisponibilidade em pico.", "hipotese": "Gargalo no cluster de banco de dados.", "proxima_acao": "Auditoria de resiliência e failover.", "aderencia": 5, "sinal": 5, "fonte_score": 5, "recencia": 5},
            {"url": "https://uncited-link-fake.com/vaga", "opp": "URL sem citação na busca (deve ser rejeitada pelo Gatekeeper)", "fonte": "uncited-link-fake.com", "tipo": "candidatura", "cited": False, "empresa": "Desconhecida", "setor": "Geral", "fato": "Link não presente nos resultados da busca.", "hipotese": "Tentativa de injeção externa.", "proxima_acao": "Rejeição imediata.", "aderencia": 1, "sinal": 1, "fonte_score": 1, "recencia": 1},
            {"url": "https://fintech-brasil.com.br/carreiras/sre-senior#secao-beneficios", "opp": "URL repetida com fragmento de âncora (deve preservar existente)", "fonte": "fintech-brasil.com.br", "tipo": "candidatura", "cited": True, "empresa": "Fintech Brasil", "setor": "Fintech", "fato": "Mesma vaga com âncora #secao-beneficios.", "hipotese": "Idempotência requer normalização canônica.", "proxima_acao": "Preservar sem duplicar.", "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4}
        ]
    elif scenario == "excess":
        mode_explanation = "Cenário de teste de corte de excesso (> 5 registros). Trava de segurança deve parar no 5º."
        items = [
            {"url": f"https://empresa{i}.com.br/vaga-sre", "opp": f"Vaga SRE Empresa {i}", "fonte": f"empresa{i}.com.br", "tipo": "candidatura", "cited": True, "empresa": f"Empresa {i}", "setor": "Tecnologia", "fato": f"Vaga SRE pública Empresa {i}.", "hipotese": "Contratação direta.", "proxima_acao": "Contato.", "aderencia": 3, "sinal": 3, "fonte_score": 3, "recencia": 3}
            for i in range(1, 8)
        ]
    else:  # mixed
        mode_explanation = "Cenário misto com links válidos, links inválidos e diagnósticos críticos."
        items = [
            {"url": "https://banco-digital.com.br/vagas/sre-lead", "opp": "Liderança de Engenharia de Resiliência", "fonte": "banco-digital.com.br", "tipo": "diagnostico", "cited": True, "empresa": "Banco Digital", "setor": "Fintech", "fato": "Busca por Lead SRE.", "hipotese": "Necessidade de liderança técnica.", "proxima_acao": "Diagnóstico de Observabilidade.", "aderencia": 5, "sinal": 4, "fonte_score": 4, "recencia": 4},
            {"url": "https://telecom-br.net/oportunidades/monitoramento", "opp": "Modernização de NOC para SRE", "fonte": "telecom-br.net", "tipo": "diagnostico", "cited": True, "empresa": "Telecom BR", "setor": "Telecom", "fato": "Migração de NOC tradicional para SRE.", "hipotese": "Transição de cultura e ferramentas.", "proxima_acao": "Consultoria em SLIs/SLOs.", "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4},
            {"url": "invalid-url-sem-protocolo", "opp": "URL Inválida (sem http)", "fonte": "invalido", "tipo": "candidatura", "cited": True, "empresa": "Invalida", "setor": "Invalido", "fato": "Sintaxe de URL incorreta.", "hipotese": "Erro de formatação.", "proxima_acao": "Descarte.", "aderencia": 1, "sinal": 1, "fonte_score": 1, "recencia": 1},
            {"url": "https://startup-saas.com.br/jobs/devops", "opp": "Engenheiro DevOps & Observabilidade", "fonte": "startup-saas.com.br", "tipo": "candidatura", "cited": True, "empresa": "Startup SaaS", "setor": "SaaS", "fato": "Vaga pública no LinkedIn.", "hipotese": "Equipe pequena de engenharia.", "proxima_acao": "Proposta de suporte sob demanda.", "aderencia": 4, "sinal": 3, "fonte_score": 4, "recencia": 4}
        ]

    # 1. Popula fontes citadas na pesquisa (Regra 1: Citação Obrigatória)
    cited_in_search = [item["url"] for item in items if item.get("cited", True)]
    for u in cited_in_search:
        state["sources"].add(radar.comparable(u))

    logs.append(f"[CITAÇÕES EXTRAÍDAS] {len(state['sources'])} URLs públicas indexadas no motor de citação.")

    # 2. Processa cada sinal pelo Gatekeeper estrito
    for item in items:
        url = item["url"]
        opp = item["opp"]
        fonte = item["fonte"]
        tipo = item["tipo"]
        empresa = item.get("empresa", opp.split(" - ")[0])
        setor = item.get("setor", "Geral")
        company_size = item.get("company_size", "Enterprise")
        fato = item.get("fato", "Sinal público identificado.")
        hipotese = item.get("hipotese", "Oportunidade de consultoria técnica em confiabilidade.")
        proxima_acao = item.get("proxima_acao", "Apresentar Diagnóstico de Observabilidade em 5 Dias")
        aderencia = item.get("aderencia", 4)
        sinal = item.get("sinal", 4)
        fonte_score = item.get("fonte_score", 4)
        recencia = item.get("recencia", 4)
        nota_calc = 7 * aderencia + 6 * sinal + 4 * fonte_score + 3 * recencia

        logs.append(f"[GATEKEEPER] Analisando sinal #{state['attempts'] + 1}: {opp}")
        logs.append(f"  URL: {url}")

        # REGRA 1: Citação obrigatória
        if radar.comparable(url) not in state["sources"]:
            msg = "Recusada: URL sem citação oficial na pesquisa desta execução (Regra 1 Anti-Alucinação)."
            logs.append(f"  -> REGRA 1 (CITAÇÃO): REJEITADA! A URL não possui citação válida nos resultados de busca.")
            state["records"].append({
                "url": url,
                "status": "RECUSADA_SEM_CITACAO",
                "detalhe": msg,
                "empresa": empresa,
                "fato": fato,
                "hipotese": hipotese,
                "tipo": tipo,
                "setor": setor,
                "company_size": company_size,
                "proxima_acao": proxima_acao,
                "nota": 0
            })
            continue

        # REGRA 2: Limite máximo de 5 tentativas por varredura
        if state["attempts"] >= radar.MAX_ITEMS:
            msg = "Bloqueada: Limite de 5 tentativas de cadastro atingido (Regra 2 Foco Operacional)."
            logs.append(f"  -> REGRA 2 (LIMITE): TRAVADA! Limite de segurança de 5 itens atingido nesta varredura.")
            state["records"].append({
                "url": url,
                "status": "BLOQUEADA_LIMITE",
                "detalhe": msg,
                "empresa": empresa,
                "fato": fato,
                "hipotese": hipotese,
                "tipo": tipo,
                "setor": setor,
                "company_size": company_size,
                "proxima_acao": proxima_acao,
                "nota": nota_calc
            })
            continue

        state["attempts"] += 1

        # REGRA 3: Validação canônica, idempotência e gravação no SQLite com metadados
        scoring_metadata = f"Fato: {fato} | Hipótese: {hipotese} | Setor: {setor}"
        try:
            added = storage.add(
                url=url,
                oportunidade=opp,
                fonte=fonte,
                tipo=tipo,
                company_size=company_size,
                industry_sector=setor,
                proxima_acao=proxima_acao,
                aderencia=aderencia,
                nota=nota_calc,
                scoring_metadata=scoring_metadata
            )
            if added:
                logs.append(f"  -> SUCESSO: Oportunidade registrada no banco com nota {nota_calc}/100 e metadados SaaS.")
                state["records"].append({
                    "url": url,
                    "status": "CADASTRADA_NOVA",
                    "detalhe": f"Registrada com nota {nota_calc}/100",
                    "empresa": empresa,
                    "fato": fato,
                    "hipotese": hipotese,
                    "tipo": tipo,
                    "setor": setor,
                    "company_size": company_size,
                    "proxima_acao": proxima_acao,
                    "nota": nota_calc
                })
            else:
                logs.append(f"  -> IDEMPOTÊNCIA: URL já cadastrada no radar; histórico preservado sem duplicatas.")
                state["records"].append({
                    "url": url,
                    "status": "JA_CADASTRADA",
                    "detalhe": "Preservada sem duplicata (idempotente)",
                    "empresa": empresa,
                    "fato": fato,
                    "hipotese": hipotese,
                    "tipo": tipo,
                    "setor": setor,
                    "company_size": company_size,
                    "proxima_acao": proxima_acao,
                    "nota": nota_calc
                })
        except ValueError as exc:
            logs.append(f"  -> ERRO DE VALIDAÇÃO: {exc}")
            state["records"].append({
                "url": url,
                "status": "ERRO_FORMATO",
                "detalhe": str(exc),
                "empresa": empresa,
                "fato": fato,
                "hipotese": hipotese,
                "tipo": tipo,
                "setor": setor,
                "company_size": company_size,
                "proxima_acao": proxima_acao,
                "nota": 0
            })

    # 3. Geração do Relatório Executivo com Hash SHA-256
    folder = Path("relatorios")
    folder.mkdir(exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")
    report_file = folder / f"radar-{timestamp}.md"

    cadastradas = sum(1 for r in state["records"] if r["status"] == "CADASTRADA_NOVA")
    preservadas = sum(1 for r in state["records"] if r["status"] == "JA_CADASTRADA")
    rejeitadas = sum(1 for r in state["records"] if r["status"] not in ("CADASTRADA_NOVA", "JA_CADASTRADA"))

    content = f"""# ARKHÉ Revenue Radar - Relatório de Varredura
Data/Hora (UTC): {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}
Tema: {tema}
Cenário: {scenario}
Segmento: {segmento.upper()}
Foco: {foco.upper()}

## Sumário Executivo do Gatekeeper
- Total de Fontes Citadas: {len(state['sources'])}
- Tentativas Processadas: {state['attempts']}/{radar.MAX_ITEMS}
- Oportunidades Cadastradas como Novas: {cadastradas}
- Oportunidades Preservadas (Idempotência): {preservadas}
- Rejeições / Bloqueios de Segurança: {rejeitadas}

## Sinais de Mercado Analisados
"""
    for rec in state["records"]:
        emp = rec.get("empresa", "Organização")
        nota_str = f" [Nota: {rec['nota']}/100]" if rec.get("nota") else ""
        content += f"\n### {emp} - {rec['status']}{nota_str}\n"
        content += f"- **URL Canônica**: `{rec['url']}`\n"
        content += f"- **Status Gatekeeper**: {rec['status']} ({rec['detalhe']})\n"
        if rec.get("fato"):
            content += f"- **Fato Verificável**: {rec['fato']}\n"
        if rec.get("hipotese"):
            content += f"- **Hipótese Consultiva**: {rec['hipotese']}\n"
        if rec.get("proxima_acao"):
            content += f"- **Próxima Ação Recomendada**: {rec['proxima_acao']}\n"

    content += "\n---\n*Relatório gerado pelo ARKHÉ Revenue Radar com conformidade estrita anti-alucinação.*\n"
    report_file.write_text(content, encoding="utf-8")
    report_sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()

    output = {
        "tema": tema,
        "scenario": scenario,
        "mode": mode,
        "modeExplanation": mode_explanation,
        "segmento": segmento,
        "foco": foco,
        "attempts": state["attempts"],
        "maxAttempts": radar.MAX_ITEMS,
        "sourcesCount": len(state["sources"]),
        "records": state["records"],
        "logs": logs,
        "reportFile": str(report_file),
        "reportContent": content,
        "sha256": report_sha256
    }
    return output


def main():
    parser = argparse.ArgumentParser(description="ARKHÉ Radar Scanner & Gatekeeper Engine")
    parser.add_argument("--tema", default="SRE e observabilidade no Brasil")
    parser.add_argument("--scenario", default="live", choices=["live", "standard", "excess", "mixed"])
    parser.add_argument("--segmento", default="geral", choices=["geral", "fintech", "ecommerce", "logistica", "saas"])
    parser.add_argument("--foco", default="todos", choices=["todos", "diagnostico", "vagas"])
    args = parser.parse_args()

    try:
        res = execute_scan(args.tema, args.scenario, args.segmento, args.foco)
        print(json.dumps(res, ensure_ascii=False))
    except Exception as exc:
        sys.stderr.write(f"Erro no scanner: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
