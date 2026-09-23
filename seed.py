"""Módulo de seeding de demonstração da versão SaaS do ARKHÉ Revenue Radar."""

import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path
import storage
import acoes

SEEDS = [
    {
        "url": "https://nubank.com.br/carreiras/eng/observability-staff",
        "data": "2026-09-18",
        "oportunidade": "Nubank - Latência em Microsserviços Pix & Expansão OpenTelemetry",
        "fonte": "nubank.com.br",
        "tipo": "diagnostico",
        "aderencia": 5, "sinal": 5, "fonte_score": 5, "recencia": 4,
        "company_size": "Enterprise (10.000+ colab.)",
        "industry_sector": "Fintech & Serviços Financeiros",
        "estado": "contato preparado",
        "proxima_acao": "Enviar proposta executiva ao Head of Cloud Platform",
        "resultado": "Draft aprovado com SHA-256 verificado",
        "workspace_id": "ws-1",
        "tags": "Pix, Latência, OpenTelemetry, Fintech",
        "valor_estimado": 65000.0,
        "contato_cargo": "Head of Cloud Platform"
    },
    {
        "url": "https://mercadolivre.com/tech/chaos-engineering-lead",
        "data": "2026-09-17",
        "oportunidade": "Mercado Livre - Staff SRE Resiliência & Gestão de Black Friday",
        "fonte": "mercadolivre.com",
        "tipo": "candidatura",
        "aderencia": 5, "sinal": 5, "fonte_score": 4, "recencia": 5,
        "company_size": "Enterprise (10.000+ colab.)",
        "industry_sector": "E-commerce & Marketplace",
        "estado": "reunião",
        "proxima_acao": "Apresentação técnica agendada para quinta-feira 14h",
        "resultado": "Lead executivo respondeu via InMail",
        "workspace_id": "ws-1",
        "tags": "Chaos Engineering, Black Friday, Staff SRE, K8s",
        "valor_estimado": 75000.0,
        "contato_cargo": "VP of Engineering"
    },
    {
        "url": "https://stone.com.br/engenharia/telemetria-datadog",
        "data": "2026-09-19",
        "oportunidade": "Stone Pagamentos - Otimização de Custos e Alertas Datadog",
        "fonte": "stone.com.br",
        "tipo": "diagnostico",
        "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 5,
        "company_size": "Grande Porte (1.000 - 5.000 colab.)",
        "industry_sector": "Fintech & Adquirência",
        "estado": "verificada",
        "proxima_acao": "Elaborar rascunho de 5 dias para mapa de pontos cegos",
        "resultado": "",
        "workspace_id": "ws-2",
        "tags": "Datadog, FinOps, Custos Cloud, Telemetria",
        "valor_estimado": 45000.0,
        "contato_cargo": "Lead SRE"
    },
    {
        "url": "https://bancointer.com.br/blog-dev/postmortem-outage-kafka",
        "data": "2026-09-15",
        "oportunidade": "Banco Inter - Postmortem de Desconexão de Clusters Kafka",
        "fonte": "bancointer.com.br",
        "tipo": "diagnostico",
        "aderencia": 5, "sinal": 4, "fonte_score": 4, "recencia": 4,
        "company_size": "Grande Porte (1.000 - 5.000 colab.)",
        "industry_sector": "Bancos & Finanças Digitais",
        "estado": "proposta",
        "proxima_acao": "Aguardando aprovação orçamentária do comitê de arquitetura",
        "resultado": "Proposta de R$ 45.000 enviada em 18/09",
        "workspace_id": "ws-2",
        "tags": "Kafka, Postmortem, Outage, Resiliência",
        "valor_estimado": 45000.0,
        "contato_cargo": "Tech Director"
    },
    {
        "url": "https://quintoandar.com.br/vagas/principal-reliability",
        "data": "2026-09-10",
        "oportunidade": "QuintoAndar - Redução de MTTR e Implementação de SLOs",
        "fonte": "quintoandar.com.br",
        "tipo": "candidatura",
        "aderencia": 4, "sinal": 4, "fonte_score": 5, "recencia": 4,
        "company_size": "Média / Scale-up (500 - 1.000 colab.)",
        "industry_sector": "Proptech & Marketplace",
        "estado": "fechada",
        "proxima_acao": "Contrato de advisory de confiabilidade assinado",
        "resultado": "Contrato fechado! Início em outubro/2026",
        "workspace_id": "ws-3",
        "tags": "SLOs, MTTR, Principal Reliability, Advisory",
        "valor_estimado": 55000.0,
        "contato_cargo": "Head of SRE"
    },
    {
        "url": "https://localiza.com/labs/migracao-cloud-kubernetes",
        "data": "2026-09-20",
        "oportunidade": "Localiza Labs - Monitoramento Prometheus/Thanos em K8s Multi-Região",
        "fonte": "localiza.com",
        "tipo": "diagnostico",
        "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 4,
        "company_size": "Enterprise (5.000 - 10.000 colab.)",
        "industry_sector": "Mobilidade & Logística",
        "estado": "respondeu",
        "proxima_acao": "Alinhar agenda de alinhamento técnico com Arquiteto SRE",
        "resultado": "Arquiteto respondeu demonstrando interesse em benchmark",
        "workspace_id": "ws-1",
        "tags": "Prometheus, Thanos, Multi-Cloud, Kubernetes",
        "valor_estimado": 48000.0,
        "contato_cargo": "Arquiteto Cloud"
    },
    {
        "url": "https://ifood.com.br/tech/observability-sla-routing",
        "data": "2026-06-18",
        "oportunidade": "iFood - Diagnóstico de Latência em Rotas de Delivery",
        "fonte": "ifood.com.br",
        "tipo": "diagnostico",
        "aderencia": 5, "sinal": 4, "fonte_score": 5, "recencia": 3,
        "company_size": "Enterprise (5.000+ colab.)",
        "industry_sector": "Foodtech & Marketplace",
        "estado": "fechada",
        "proxima_acao": "Diagnóstico executivo de 5 dias concluído e entregue",
        "resultado": "Contrato fechado! R$ 45.000",
        "workspace_id": "ws-1",
        "tags": "Observabilidade, Latência, SLA, Logística",
        "valor_estimado": 45000.0,
        "contato_cargo": "Tech Lead SRE"
    },
    {
        "url": "https://c6bank.com.br/engenharia/autorizador-cartoes-resilience",
        "data": "2026-07-14",
        "oportunidade": "C6 Bank - Resiliência de Autorizador Cartões e OpenTelemetry",
        "fonte": "c6bank.com.br",
        "tipo": "candidatura",
        "aderencia": 5, "sinal": 5, "fonte_score": 4, "recencia": 4,
        "company_size": "Grande Porte (1.000 - 5.000 colab.)",
        "industry_sector": "Fintech & Serviços Financeiros",
        "estado": "fechada",
        "proxima_acao": "Assinatura de advisory de arquitetura resiliente",
        "resultado": "Contrato fechado! R$ 55.000",
        "workspace_id": "ws-1",
        "tags": "Autorizador, OpenTelemetry, Resiliência, Cloud",
        "valor_estimado": 55000.0,
        "contato_cargo": "Head of Engineering"
    },
    {
        "url": "https://pagseguro.uol.com.br/tech/datadog-finops-metrics",
        "data": "2026-08-08",
        "oportunidade": "PagSeguro - FinOps Datadog & Redução de Métricas Customizadas",
        "fonte": "pagseguro.uol.com.br",
        "tipo": "diagnostico",
        "aderencia": 4, "sinal": 5, "fonte_score": 4, "recencia": 4,
        "company_size": "Enterprise (5.000+ colab.)",
        "industry_sector": "Fintech & Meios de Pagamento",
        "estado": "fechada",
        "proxima_acao": "Sprint de diagnóstico de métricas Datadog finalizada",
        "resultado": "Contrato fechado! R$ 50.000",
        "workspace_id": "ws-2",
        "tags": "Datadog, FinOps, Métricas, Custos",
        "valor_estimado": 50000.0,
        "contato_cargo": "Engineering Manager"
    },
    {
        "url": "https://picpay.com/carreiras/dist-tracing-mesh",
        "data": "2026-08-22",
        "oportunidade": "PicPay - Distributed Tracing & Service Mesh Latency",
        "fonte": "picpay.com",
        "tipo": "candidatura",
        "aderencia": 5, "sinal": 4, "fonte_score": 4, "recencia": 5,
        "company_size": "Grande Porte (1.000 - 5.000 colab.)",
        "industry_sector": "Fintech & Carteira Digital",
        "estado": "proposta",
        "data_envio_proposta": "2026-08-28",
        "proxima_acao": "Proposta de R$ 60.000 enviada em 28/08 aguardando comitê",
        "resultado": "Proposta formal submetida",
        "workspace_id": "ws-2",
        "tags": "Distributed Tracing, Service Mesh, Istio, Latência",
        "valor_estimado": 60000.0,
        "contato_cargo": "VP de Tecnologia"
    },
    {
        "url": "https://inter.co/carreiras/kafka-observability-lead",
        "data": "2026-09-10",
        "oportunidade": "Banco Inter - Confiabilidade de Mensageria Kafka & Observabilidade",
        "fonte": "inter.co",
        "tipo": "diagnostico",
        "aderencia": 5, "sinal": 5, "fonte_score": 4, "recencia": 4,
        "company_size": "Grande Porte (1.000 - 5.000 colab.)",
        "industry_sector": "Fintech & Banco Digital",
        "estado": "proposta",
        "data_envio_proposta": "2026-09-10",
        "proxima_acao": "Proposta de R$ 52.000 enviada em 10/09 aguardando retorno da diretoria",
        "resultado": "Proposta enviada aguardando deliberação técnica",
        "workspace_id": "ws-1",
        "tags": "Kafka, Mensageria, OpenTelemetry, Resiliência",
        "valor_estimado": 52000.0,
        "contato_cargo": "Diretor de Engenharia"
    },
    {
        "url": "https://loft.com.br/tech/apm-datadog-slos",
        "data": "2026-09-19",
        "oportunidade": "Loft - Otimização de APM Datadog & Governança de SLOs",
        "fonte": "loft.com.br",
        "tipo": "diagnostico",
        "aderencia": 4, "sinal": 4, "fonte_score": 4, "recencia": 5,
        "company_size": "Média / Scale-up (500 - 1.000 colab.)",
        "industry_sector": "Proptech & Marketplace Imobiliário",
        "estado": "proposta",
        "data_envio_proposta": "2026-09-19",
        "proxima_acao": "Proposta de R$ 48.000 enviada recentemente (19/09), call de alinhamento na terça",
        "resultado": "Em análise técnica",
        "workspace_id": "ws-1",
        "tags": "Datadog, APM, SLOs, Proptech",
        "valor_estimado": 48000.0,
        "contato_cargo": "Tech Lead Platform"
    }
]


def run_seed():
    import saas_migration
    saas_migration.run_migration()
    storage.init_db()
    acoes.preparar_tabela_revisoes()
    added_count = 0

    for s in SEEDS:
        try:
            url = storage.validate_url(s["url"])
            storage.add(
                url,
                s["oportunidade"],
                s["fonte"],
                s["tipo"],
                data=s["data"],
                estado=s["estado"],
                proxima_acao=s["proxima_acao"],
                resultado=s["resultado"]
            )
            storage.score(url, s["aderencia"], s["sinal"], s["fonte_score"], s["recencia"])

            # Atualizar colunas SaaS
            with storage.connect() as db:
                db.execute(
                    """UPDATE oportunidades
                       SET workspace_id = ?, tags = ?, valor_estimado = ?, contato_cargo = ?,
                           company_size = ?, industry_sector = ?, data_envio_proposta = ?
                       WHERE url = ?""",
                    (s.get("workspace_id", "ws-1"), s.get("tags", ""), s.get("valor_estimado", 45000.0), s.get("contato_cargo", ""),
                     s.get("company_size", ""), s.get("industry_sector", ""), s.get("data_envio_proposta", s["data"]), url)
                )

            if s["estado"] == "contato preparado":
                identificador = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
                arquivo = acoes.RASCUNHOS / f"{identificador}-nubank-audit.md"
                corpo = (
                    "# Rascunho para revisão - ARKHÉ Revenue Radar\n\n"
                    f"URL da oportunidade: {url}\n\n"
                    "Objetivo: diagnostico\n"
                    "Canal: email\n"
                    "Fato conferido: Vaga aberta de Staff SRE com foco em latência de transações Pix e OpenTelemetry.\n\n"
                    "## Mensagem Executiva\n\n"
                    "Olá time de Engenharia de Plataforma do Nubank,\n\n"
                    "Acompanhamos de perto os desafios de escala nas rotas de microsserviços de pagamento. "
                    "Notamos a movimentação estratégica para expansão de traces distribuídos em OpenTelemetry.\n\n"
                    "Gostaríamos de propor uma Avaliação de Observabilidade em 5 Dias, sem disrupção do ambiente produtivo, "
                    "entregando um Mapa Executivo de Pontos Cegos e estratégias para redução de MTTR em picos de tráfego.\n\n"
                    "Podemos alinhar uma call de 20 minutos nesta quinta-feira?\n"
                )
                acoes.RASCUNHOS.mkdir(exist_ok=True)
                arquivo.write_text(corpo, encoding="utf-8")
                h = hashlib.sha256(arquivo.read_bytes()).hexdigest()
                with acoes.conectar() as db:
                    db.execute(
                        """INSERT INTO revisoes(url, arquivo, hash_aprovado, aprovado_em)
                           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                           ON CONFLICT(url) DO UPDATE SET arquivo = excluded.arquivo, hash_aprovado = excluded.hash_aprovado""",
                        (url, arquivo.name, h)
                    )
            added_count += 1
        except Exception as ex:
            sys.stderr.write(f"Erro no seed {s['url']}: {ex}\n")

    return added_count


if __name__ == "__main__":
    count = run_seed()
    print(f'{{"success": true, "count": {count}}}')
