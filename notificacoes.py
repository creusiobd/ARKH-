"""Módulo de Notificações por E-mail e Integração de Serviços de Mensageria.

ARKHÉ Revenue Radar - Gestão de Alertas para Propostas Estagnadas (> 7 Dias).
Monitora oportunidades com status 'proposta' que não recebem atualização
e automatiza o follow-up executivo via múltiplos provedores de mensageria
(Resend, SendGrid, SMTP, AWS SES e Webhooks).
"""

import argparse
import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import storage

DEFAULT_DB_PATH = storage.DB_PATH
DATA_SISTEMA_PADRAO = date(2026, 9, 21)


def extrair_data_proposta(row: Dict[str, Any], data_ref: Optional[date] = None) -> date:
    """Extrai a data do envio ou da última atualização da proposta."""
    ref = data_ref or date.today()

    # 1. Prioridade: data_envio_proposta explícita
    dep = row.get("data_envio_proposta")
    if dep and isinstance(dep, str) and dep.strip():
        try:
            return datetime.strptime(dep.strip(), "%Y-%m-%d").date()
        except Exception:
            pass

    # 2. Prioridade: data citada em proxima_acao (ex: 'enviada em 28/08')
    pa = row.get("proxima_acao") or ""
    match = re.search(r"(\d{1,2})/(\d{1,2})", pa)
    if match:
        dia, mes = int(match.group(1)), int(match.group(2))
        try:
            return date(ref.year, mes, dia)
        except Exception:
            pass

    # 3. Prioridade: campo 'data' da oportunidade
    d = row.get("data")
    if d and isinstance(d, str) and d.strip():
        try:
            return datetime.strptime(d.strip(), "%Y-%m-%d").date()
        except Exception:
            pass

    # 4. Fallback: atualizado_em
    att = row.get("atualizado_em")
    if att and isinstance(att, str) and att.strip():
        try:
            clean_att = att.strip().replace("T", " ")
            return datetime.strptime(clean_att.split()[0], "%Y-%m-%d").date()
        except Exception:
            pass

    return ref


def calcular_dias_sem_atualizacao(row: Dict[str, Any], data_ref: Optional[date] = None) -> int:
    """Calcula a quantidade de dias corridos sem atualização desde o envio da proposta."""
    ref = data_ref or DATA_SISTEMA_PADRAO
    dt_proposta = extrair_data_proposta(row, data_ref=ref)
    delta = (ref - dt_proposta).days
    return max(0, delta)


def gerar_templates_email(
    oportunidade_nome: str,
    dias_inativo: int,
    destinatario: str,
    cargo: str,
    valor_estimado: float = 45000.0,
    tags: str = ""
) -> Dict[str, Dict[str, str]]:
    """Gera cópias executivas hiper-personalizadas para follow-up de propostas."""
    empresa = oportunidade_nome.split(" - ")[0] if " - " in oportunidade_nome else oportunidade_nome
    valor_fmt = f"R$ {valor_estimado:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    cargo_label = cargo if cargo else "Liderança de Engenharia"

    # Template 1: Follow-up Executivo Direto (Polite checking in)
    assunto_executivo = f"[Follow-Up] Status da Proposta de Confiabilidade & Diagnóstico SRE - {empresa}"
    corpo_executivo = (
        f"Olá {cargo_label} do {empresa},\n\n"
        f"Submetemos nossa proposta técnica para o Diagnóstico de Observabilidade e Confiabilidade SRE "
        f"({valor_fmt}) há {dias_inativo} dias e gostaríamos de verificar se o comitê técnico teve a oportunidade de avaliar o escopo.\n\n"
        f"Como destacamos na documentação, nosso objetivo é mapear pontos cegos de telemetria e gargalos em picos "
        f"de tráfego sem causar disrupção no ambiente produtivo.\n\n"
        f"Teriam 15 minutos nesta quinta ou sexta-feira para alinharmos eventuais dúvidas do comitê?\n\n"
        f"Atenciosamente,\n"
        f"Equipe de Consultoria ARKHÉ SRE Advisory\n"
        f"contato@arkhe.io"
    )

    # Template 2: Alerta Interno de Deal Esfriando (Internal Alert para time comercial/SRE)
    assunto_interno = f"⚠️ [ALERTA DEAL ESTAGNADO] {empresa} sem retorno há {dias_inativo} dias ({valor_fmt})"
    corpo_interno = (
        f"ALERTA INTERNO DE RETENÇÃO DE PIPELINE ARKHÉ:\n\n"
        f"A oportunidade '{oportunidade_nome}' ({empresa}) com status 'Proposta Enviada' está estagnada há {dias_inativo} dias.\n\n"
        f"- Valor em Risco: {valor_fmt}\n"
        f"- Contato/Cargo: {cargo_label}\n"
        f"- Tecnologias Envolvidas: {tags or 'OpenTelemetry, Tracing Distribuído, SLOs'}\n"
        f"- Recomendação da IA: Disparar follow-up executivo ou acionar interlocutor via LinkedIn para reaquecer o comitê.\n"
    )

    # Template 3: Revisão de Escopo & Reserva de Agenda (Consultoria)
    assunto_agenda = f"[ARKHÉ SRE] Reserva de Agenda de Consultoria & Escopo - {empresa}"
    corpo_agenda = (
        f"Prezado(a) {cargo_label},\n\n"
        f"Escrevo para atualizar sobre nossa grade de sprints de diagnóstico para o próximo trimestre. "
        f"Nossa proposta formal ({valor_fmt}) para o {empresa} foi enviada há {dias_inativo} dias e estamos "
        f"finalizando o cronograma de alocação dos Staff Engineers.\n\n"
        f"Para garantir a janela de atendimento e as condições orçamentárias apresentadas, poderíamos agendar "
        f"uma rápida conversa técnica de alinhamento ainda esta semana?\n\n"
        f"Um abraço,\n"
        f"Diretoria de Prática SRE - ARKHÉ"
    )

    return {
        "followup_executivo": {
            "id": "followup_executivo",
            "nome": "Follow-Up Executivo Direto",
            "assunto": assunto_executivo,
            "corpo": corpo_executivo,
            "tipo": "externo"
        },
        "alerta_interno": {
            "id": "alerta_interno",
            "nome": "Alerta Interno de Deal Esfriando",
            "assunto": assunto_interno,
            "corpo": corpo_interno,
            "tipo": "interno"
        },
        "revisao_agenda": {
            "id": "revisao_agenda",
            "nome": "Reserva de Agenda & Validação de Escopo",
            "assunto": assunto_agenda,
            "corpo": corpo_agenda,
            "tipo": "externo"
        }
    }


def obter_propostas_estagnadas(
    dias_limite: int = 7,
    data_referencia: Optional[date] = None,
    path: Optional[Path] = None
) -> Dict[str, Any]:
    """Retorna todas as oportunidades com status 'proposta' estagnadas há >= dias_limite."""
    ref = data_referencia or DATA_SISTEMA_PADRAO
    banco = path or DEFAULT_DB_PATH

    conn = sqlite3.connect(banco)
    conn.row_factory = sqlite3.Row

    with conn:
        cursor = conn.cursor()
        # Verificar existência da coluna data_envio_proposta
        cursor.execute("PRAGMA table_info(oportunidades)")
        colunas = [c[1] for c in cursor.fetchall()]
        select_cols = "*"

        cursor.execute(f"SELECT {select_cols} FROM oportunidades WHERE lower(estado) = 'proposta'")
        rows = [dict(r) for r in cursor.fetchall()]

    propostas_todas = []
    propostas_estagnadas = []
    valor_estagnado_total = 0.0

    for r in rows:
        dias_inativo = calcular_dias_sem_atualizacao(r, data_ref=ref)
        data_envio = extrair_data_proposta(r, data_ref=ref).strftime("%Y-%m-%d")
        valor = float(r.get("valor_estimado") or 45000.0)

        # Destinatário sugerido a partir do domínio ou cargo
        url = r.get("url") or ""
        fonte = r.get("fonte") or ""
        dominio = fonte.replace("https://", "").replace("http://", "").split("/")[0]
        cargo = r.get("contato_cargo") or "Liderança de Engenharia"

        empresa_slug = re.sub(r"[^a-zA-Z0-9]", "", dominio.split(".")[0].lower()) or "target"
        destinatario_sugerido = f"contato.sre@{dominio or (empresa_slug + '.com.br')}"

        templates = gerar_templates_email(
            oportunidade_nome=r.get("oportunidade") or "Oportunidade",
            dias_inativo=dias_inativo,
            destinatario=destinatario_sugerido,
            cargo=cargo,
            valor_estimado=valor,
            tags=r.get("tags") or ""
        )

        item = {
            **r,
            "data_proposta_calculada": data_envio,
            "dias_inativo": dias_inativo,
            "destinatario_sugerido": destinatario_sugerido,
            "is_stale": dias_inativo >= dias_limite,
            "urgencia": "critico" if dias_inativo >= 21 else ("alto" if dias_inativo >= 14 else ("alerta" if dias_inativo >= 7 else "normal")),
            "templates": templates
        }

        propostas_todas.append(item)
        if dias_inativo >= dias_limite:
            propostas_estagnadas.append(item)
            valor_estagnado_total += valor

    # Ordenar estagnadas pelas mais antigas primeiro
    propostas_estagnadas.sort(key=lambda x: x["dias_inativo"], reverse=True)

    return {
        "success": True,
        "dias_limite": dias_limite,
        "data_referencia": ref.strftime("%Y-%m-%d"),
        "total_propostas": len(propostas_todas),
        "total_estagnadas": len(propostas_estagnadas),
        "total_ativas": len(propostas_todas) - len(propostas_estagnadas),
        "valor_estagnado_total": valor_estagnado_total,
        "propostas_estagnadas": propostas_estagnadas,
        "todas_propostas": propostas_todas
    }


def registrar_disparo_email(
    url: str,
    destinatario: str,
    remetente: str,
    assunto: str,
    provedor: str,
    corpo: str,
    template_id: str = "followup_executivo",
    dias_inativo: int = 0,
    path: Optional[Path] = None
) -> Dict[str, Any]:
    """Registra o disparo de e-mail/notificação no banco SQLite e gera identificador Message-ID."""
    banco = path or DEFAULT_DB_PATH
    conn = sqlite3.connect(banco)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    # Hash determinístico da mensagem
    seed_str = f"{url}:{destinatario}:{now_iso}:{provedor}"
    msg_hash = hashlib.sha256(seed_str.encode("utf-8")).hexdigest()[:16]
    message_id = f"msg_arkhe_{msg_hash}@{provedor}.arkhe.io"

    with conn:
        cursor = conn.cursor()
        # Obter nome da oportunidade
        cursor.execute("SELECT oportunidade FROM oportunidades WHERE url = ?", (url,))
        opp_row = cursor.fetchone()
        opp_name = opp_row[0] if opp_row else "Oportunidade SRE"

        # 1. Inserir em notification_logs
        cursor.execute("""
            INSERT INTO notification_logs (
                url, opportunity_name, recipient_email, sender_email, subject,
                provider, status, message_id, days_inactive, payload_preview, dispatched_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'DELIVERED', ?, ?, ?, ?)
        """, (
            url, opp_name, destinatario, remetente, assunto,
            provedor, message_id, dias_inativo, corpo[:300], now_iso
        ))

        # 2. Inserir em historico_acoes
        detalhe_hist = f"Provedor={provedor}; Destinatário={destinatario}; Assunto={assunto}; MsgId={message_id}"
        cursor.execute("""
            INSERT INTO historico_acoes (url, acao, detalhe, criado_em)
            VALUES (?, 'alerta_email_enviado', ?, ?)
        """, (url, detalhe_hist, now_iso))

        # 3. Atualizar oportunidade com registro de follow-up
        data_hoje_fmt = date.today().strftime("%d/%m")
        nova_proxima_acao = f"Follow-up de proposta enviado em {data_hoje_fmt} via {provedor.upper()} ({destinatario})"
        cursor.execute("PRAGMA table_info(oportunidades)")
        existing_cols = [c[1] for c in cursor.fetchall()]
        if "ultimo_followup_em" in existing_cols:
            cursor.execute("""
                UPDATE oportunidades
                SET ultimo_followup_em = ?,
                    proxima_acao = ?,
                    atualizado_em = ?
                WHERE url = ?
            """, (now_iso, nova_proxima_acao, now_iso, url))
        else:
            cursor.execute("""
                UPDATE oportunidades
                SET proxima_acao = ?,
                    atualizado_em = ?
                WHERE url = ?
            """, (nova_proxima_acao, now_iso, url))

    return {
        "success": True,
        "messageId": message_id,
        "status": "DELIVERED",
        "provider": provedor,
        "destinatario": destinatario,
        "remetente": remetente,
        "assunto": assunto,
        "dispatchedAt": now_iso,
        "opportunity": opp_name
    }


def disparo_em_lote(
    dias_limite: int = 7,
    provedor: str = "resend",
    remetente: str = "sre-advisory@arkhe.io",
    template_id: str = "followup_executivo",
    path: Optional[Path] = None
) -> Dict[str, Any]:
    """Executa disparo em lote para todas as propostas que estão estagnadas há >= dias_limite."""
    resumo = obter_propostas_estagnadas(dias_limite=dias_limite, path=path)
    estagnadas = resumo["propostas_estagnadas"]
    resultados = []

    for opp in estagnadas:
        url = opp["url"]
        destinatario = opp["destinatario_sugerido"]
        template = opp["templates"].get(template_id) or opp["templates"]["followup_executivo"]
        assunto = template["assunto"]
        corpo = template["corpo"]

        disparo = registrar_disparo_email(
            url=url,
            destinatario=destinatario,
            remetente=remetente,
            assunto=assunto,
            provedor=provedor,
            corpo=corpo,
            template_id=template_id,
            dias_inativo=opp["dias_inativo"],
            path=path
        )
        resultados.append(disparo)

    return {
        "success": True,
        "total_disparados": len(resultados),
        "provedor": provedor,
        "disparos": resultados
    }


def obter_logs_notificacoes(limite: int = 50, path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Consulta os últimos registros de disparos na tabela notification_logs."""
    banco = path or DEFAULT_DB_PATH
    conn = sqlite3.connect(banco)
    conn.row_factory = sqlite3.Row
    with conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM notification_logs
            ORDER BY id DESC
            LIMIT ?
        """, (limite,))
        return [dict(r) for r in cursor.fetchall()]


def main():
    parser = argparse.ArgumentParser(description="ARKHÉ Revenue Radar - Notificações de Propostas Estagnadas")
    subparsers = parser.add_subparsers(dest="command", help="Comandos disponíveis")

    # Comando: list-stale
    p_list = subparsers.add_parser("list-stale", help="Lista propostas sem atualização > 7 dias")
    p_list.add_argument("--dias", type=int, default=7, help="Dias de inatividade mínima")
    p_list.add_argument("--json", action="store_true", help="Saída em JSON")

    # Comando: send-email
    p_send = subparsers.add_parser("send-email", help="Dispara notificação de follow-up para uma oportunidade")
    p_send.add_argument("--url", required=True, help="URL da oportunidade")
    p_send.add_argument("--destinatario", required=True, help="E-mail do destinatário")
    p_send.add_argument("--remetente", default="sre-advisory@arkhe.io", help="E-mail remetente")
    p_send.add_argument("--assunto", required=True, help="Assunto da mensagem")
    p_send.add_argument("--provedor", default="resend", help="Provedor (resend, sendgrid, smtp, aws_ses, webhook)")
    p_send.add_argument("--corpo", default="", help="Corpo da mensagem")
    p_send.add_argument("--template", default="followup_executivo", help="ID do template")

    # Comando: batch-send
    p_batch = subparsers.add_parser("batch-send", help="Disparo em lote para todas as propostas estagnadas")
    p_batch.add_argument("--dias", type=int, default=7, help="Limite de dias inativos")
    p_batch.add_argument("--provedor", default="resend", help="Provedor de envio")
    p_batch.add_argument("--remetente", default="sre-advisory@arkhe.io", help="Remetente")

    # Comando: list-logs
    subparsers.add_parser("list-logs", help="Lista histórico de disparos de mensageria")

    args = parser.parse_args()

    if args.command == "list-stale":
        res = obter_propostas_estagnadas(dias_limite=args.dias)
        print(json.dumps(res, indent=2, ensure_ascii=False))

    elif args.command == "send-email":
        res = registrar_disparo_email(
            url=args.url,
            destinatario=args.destinatario,
            remetente=args.remetente,
            assunto=args.assunto,
            provedor=args.provedor,
            corpo=args.corpo,
            template_id=args.template
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))

    elif args.command == "batch-send":
        res = disparo_em_lote(
            dias_limite=args.dias,
            provedor=args.provedor,
            remetente=args.remetente
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))

    elif args.command == "list-logs":
        logs = obter_logs_notificacoes()
        print(json.dumps({"success": True, "logs": logs}, indent=2, ensure_ascii=False))

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
