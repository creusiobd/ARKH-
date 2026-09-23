"""Módulo de Governança SaaS, Chaves de API, Fila de Jobs e Importação Legada.

Implementa as lacunas antes de lançamento ao público descritas na Página 7 do documento:
1. Tratamento e recuperação de jobs running presos (worker crash / timeout).
2. Gestão de chaves de API akh_ID_SEGREDO com digest SHA-256 e revogação.
3. Controle de quotas diárias (5 radar/dia, 20 rascunhos/dia) e alerta de custo.
4. Importação de CSV legado (cada linha entra como 'nova' para revalidação).
5. Backup de dados ensaiado e validação de integridade por hash SHA-256.
"""

import csv
import io
import json
import os
import secrets
import hashlib
import sqlite3
from datetime import datetime, timezone, date, timedelta
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple

import storage

DB_PATH = storage.DB_PATH

DEFAULT_DAILY_LIMITS = {
    "radar": 5,      # 5 jobs de pesquisa radar por dia/conta
    "drafts": 20,    # 20 jobs de rascunho por dia/conta
}

COST_ESTIMATES = {
    "radar_job_usd": 0.035,   # Custo aproximado por busca web citada + modelo
    "draft_job_usd": 0.012,   # Custo aproximado por rascunho com 150 palavras
    "usd_to_brl": 5.65,
}

def init_governance_schema(db_path=DB_PATH):
    """Inicializa as tabelas da infraestrutura de governança SaaS."""
    storage.init_db(db_path)
    with storage.connect(db_path) as db:
        db.executescript("""
            -- Chaves de API (Segredo nunca gravado em texto puro)
            CREATE TABLE IF NOT EXISTS saas_api_keys (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                name TEXT NOT NULL,
                prefix TEXT NOT NULL,
                digest TEXT NOT NULL, -- SHA-256 do segredo
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revoked_at TEXT
            );

            -- Jobs do Worker (Fila persistida com recuperação de jobs presos)
            CREATE TABLE IF NOT EXISTS saas_jobs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                kind TEXT NOT NULL, -- 'radar' ou 'draft'
                status TEXT NOT NULL DEFAULT 'queued', -- queued, running, succeeded, failed, stuck_investigating
                payload TEXT NOT NULL DEFAULT '{}',
                output TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                retry_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                started_at TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                heartbeat_at TEXT
            );

            -- Tabela de consumo de Quotas Diárias
            CREATE TABLE IF NOT EXISTS saas_quotas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                date_str TEXT NOT NULL, -- YYYY-MM-DD
                kind TEXT NOT NULL,     -- 'radar' ou 'drafts'
                count INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0.0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, date_str, kind)
            );

            -- Outbox / Fila de Eventos de Auditoria Imutáveis
            CREATE TABLE IF NOT EXISTS saas_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                resource_type TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                actor TEXT NOT NULL DEFAULT 'system',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        """)

# ==============================================================================
# 1. GESTÃO DE CHAVES DE API (akh_ID_SEGREDO)
# ==============================================================================

def generate_api_key(tenant_id: str, name: str, db_path=DB_PATH) -> Dict[str, Any]:
    """Gera uma chave akh_ID_SEGREDO. O segredo é exibido UMA única vez."""
    init_governance_schema(db_path)
    # ID alfanumérico limpo sem underscores para separador exato
    key_id = f"key{secrets.token_hex(8)}"
    secret = secrets.token_hex(24)
    # Formato oficial do documento pág 3: akh_ID_SEGREDO
    full_token = f"akh_{key_id}_{secret}"
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    prefix = f"akh_{key_id[:8]}...{secret[:4]}"

    with storage.connect(db_path) as db:
        db.execute(
            """INSERT INTO saas_api_keys (id, tenant_id, name, prefix, digest, active)
               VALUES (?, ?, ?, ?, ?, 1)""",
            (key_id, tenant_id, name, prefix, digest),
        )
        record_audit_event(tenant_id, "api_key_created", "api_key", key_id, {"name": name, "prefix": prefix}, db=db, db_path=db_path)

    return {
        "id": key_id,
        "tenant_id": tenant_id,
        "name": name,
        "prefix": prefix,
        "full_token": full_token, # Exibido apenas na criação
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

def list_api_keys(tenant_id: str, db_path=DB_PATH) -> List[Dict[str, Any]]:
    """Lista chaves sem expor o segredo."""
    init_governance_schema(db_path)
    with storage.connect(db_path) as db:
        rows = db.execute(
            """SELECT id, tenant_id, name, prefix, active, created_at, revoked_at
               FROM saas_api_keys WHERE tenant_id = ? ORDER BY created_at DESC""",
            (tenant_id,),
        ).fetchall()
        return [dict(r) for r in rows]

def revoke_api_key(key_id: str, tenant_id: str, db_path=DB_PATH) -> bool:
    """Revoga uma chave de API."""
    init_governance_schema(db_path)
    now = datetime.now(timezone.utc).isoformat()
    with storage.connect(db_path) as db:
        res = db.execute(
            """UPDATE saas_api_keys SET active = 0, revoked_at = ?
               WHERE id = ? AND tenant_id = ?""",
            (now, key_id, tenant_id),
        )
        success = res.rowcount > 0
        if success:
            record_audit_event(tenant_id, "api_key_revoked", "api_key", key_id, {}, db=db, db_path=db_path)
        return success

def verify_token(token: str, db_path=DB_PATH) -> Optional[Dict[str, Any]]:
    """Valida um token Bearer akh_ID_SEGREDO."""
    if not token or not token.startswith("akh_"):
        return None
    parts = token.split("_", 2)
    if len(parts) != 3:
        return None
    key_id = parts[1]
    secret = parts[2]
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()

    with storage.connect(db_path) as db:
        row = db.execute(
            """SELECT id, tenant_id, name, prefix, digest, active FROM saas_api_keys
               WHERE id = ? AND active = 1""",
            (key_id,),
        ).fetchone()
        if row and secrets.compare_digest(row["digest"], digest):
            return {
                "id": row["id"],
                "tenant_id": row["tenant_id"],
                "name": row["name"],
                "prefix": row["prefix"],
                "active": row["active"],
            }
    return None

# ==============================================================================
# 2. TRATAMENTO DE JOBS RUNNING PRESOS E FILA DE TAREFAS
# ==============================================================================

def enqueue_job(tenant_id: str, kind: str, payload: dict, db_path=DB_PATH) -> str:
    """Cria um novo job no estado 'queued'."""
    init_governance_schema(db_path)
    job_id = f"job_{secrets.token_hex(8)}"
    now = datetime.now(timezone.utc).isoformat()

    with storage.connect(db_path) as db:
        db.execute(
            """INSERT INTO saas_jobs (id, tenant_id, kind, status, payload, created_at, updated_at, heartbeat_at)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)""",
            (job_id, tenant_id, kind, json.dumps(payload), now, now, now),
        )
        record_audit_event(tenant_id, "job_enqueued", "job", job_id, {"kind": kind}, db=db, db_path=db_path)
    return job_id

def list_jobs(tenant_id: Optional[str] = None, limit: int = 50, db_path=DB_PATH) -> List[Dict[str, Any]]:
    """Lista jobs com métricas de execução."""
    init_governance_schema(db_path)
    with storage.connect(db_path) as db:
        if tenant_id:
            rows = db.execute(
                """SELECT * FROM saas_jobs WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?""",
                (tenant_id, limit),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT * FROM saas_jobs ORDER BY updated_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

def detect_and_recover_stuck_jobs(timeout_seconds: int = 180, db_path=DB_PATH) -> Dict[str, Any]:
    """Identifica jobs em status 'running' sem heartbeat recente e os recupera com segurança.
    Conforme página 6 e 7: 'Jobs running presos exigem investigação antes de repetir inferência.'
    """
    init_governance_schema(db_path)
    now = datetime.now(timezone.utc)
    threshold = (now - timedelta(seconds=timeout_seconds)).isoformat()

    with storage.connect(db_path) as db:
        stuck_rows = db.execute(
            """SELECT id, tenant_id, kind, started_at, heartbeat_at, retry_count
               FROM saas_jobs
               WHERE status = 'running' AND (heartbeat_at < ? OR heartbeat_at IS NULL)""",
            (threshold,),
        ).fetchall()

        recovered = []
        for row in stuck_rows:
            job_id = row["id"]
            # Marca como 'stuck_investigating' para impedir repetição cega na IA
            db.execute(
                """UPDATE saas_jobs
                   SET status = 'stuck_investigating',
                       error = 'Job preso sem heartbeat por mais de 3 minutos. Investigação necessária.',
                       updated_at = ?
                   WHERE id = ?""",
                (now.isoformat(), job_id),
            )
            record_audit_event(
                row["tenant_id"],
                "job_stuck_detected",
                "job",
                job_id,
                {"reason": "heartbeat_timeout", "timeout_seconds": timeout_seconds},
                db=db,
                db_path=db_path
            )
            recovered.append({
                "id": job_id,
                "tenant_id": row["tenant_id"],
                "kind": row["kind"],
                "action": "marked_for_investigation"
            })

        return {
            "total_detected": len(recovered),
            "recovered_jobs": recovered,
            "checked_at": now.isoformat(),
        }

def manual_requeue_job(job_id: str, db_path=DB_PATH) -> bool:
    """Reenfileira manualmente um job investigado com incremento de retry_count."""
    init_governance_schema(db_path)
    now = datetime.now(timezone.utc).isoformat()
    with storage.connect(db_path) as db:
        res = db.execute(
            """UPDATE saas_jobs
               SET status = 'queued',
                   retry_count = retry_count + 1,
                   updated_at = ?,
                   heartbeat_at = ?,
                   error = 'Reenfileirado manualmente pelo operador'
               WHERE id = ? AND status IN ('stuck_investigating', 'failed')""",
            (now, now, job_id),
        )
        return res.rowcount > 0

# ==============================================================================
# 3. CONTROLE DE QUOTAS & ALERTAS DE CUSTO
# ==============================================================================

def check_and_consume_quota(tenant_id: str, kind: str, db_path=DB_PATH) -> Tuple[bool, Dict[str, Any]]:
    """Verifica e consome quota diária (5 radar/dia, 20 rascunhos/dia)."""
    init_governance_schema(db_path)
    today = date.today().isoformat()
    limit = DEFAULT_DAILY_LIMITS.get(kind, 10)
    unit_cost = COST_ESTIMATES.get(f"{kind}_job_usd", 0.02)

    with storage.connect(db_path) as db:
        row = db.execute(
            """SELECT count, cost_usd FROM saas_quotas
               WHERE tenant_id = ? AND date_str = ? AND kind = ?""",
            (tenant_id, today, kind),
        ).fetchone()

        current_count = row["count"] if row else 0
        if current_count >= limit:
            return False, {
                "allowed": False,
                "current": current_count,
                "limit": limit,
                "kind": kind,
                "date": today,
                "error": f"Quota diária de {limit} execuções atingida para {kind}.",
            }

        new_count = current_count + 1
        new_cost = new_count * unit_cost

        db.execute(
            """INSERT INTO saas_quotas (tenant_id, date_str, kind, count, cost_usd, updated_at)
               VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(tenant_id, date_str, kind) DO UPDATE SET
                   count = excluded.count,
                   cost_usd = excluded.cost_usd,
                   updated_at = CURRENT_TIMESTAMP""",
            (tenant_id, today, kind, new_count, new_cost),
        )

        return True, {
            "allowed": True,
            "current": new_count,
            "limit": limit,
            "remaining": limit - new_count,
            "kind": kind,
            "date": today,
            "estimated_cost_usd": new_cost,
            "estimated_cost_brl": round(new_cost * COST_ESTIMATES["usd_to_brl"], 2),
        }

def get_tenant_quota_summary(tenant_id: str, db_path=DB_PATH) -> Dict[str, Any]:
    """Retorna o consumo e teto de gastos diários do tenant."""
    init_governance_schema(db_path)
    today = date.today().isoformat()
    with storage.connect(db_path) as db:
        rows = db.execute(
            """SELECT kind, count, cost_usd FROM saas_quotas
               WHERE tenant_id = ? AND date_str = ?""",
            (tenant_id, today),
        ).fetchall()

        data = {r["kind"]: dict(r) for r in rows}

        radar_count = data.get("radar", {}).get("count", 0)
        drafts_count = data.get("drafts", {}).get("count", 0)
        total_usd = sum(d.get("cost_usd", 0.0) for d in data.values())

        return {
            "tenant_id": tenant_id,
            "date": today,
            "radar": {
                "used": radar_count,
                "limit": DEFAULT_DAILY_LIMITS["radar"],
                "pct": round((radar_count / DEFAULT_DAILY_LIMITS["radar"]) * 100, 1),
            },
            "drafts": {
                "used": drafts_count,
                "limit": DEFAULT_DAILY_LIMITS["drafts"],
                "pct": round((drafts_count / DEFAULT_DAILY_LIMITS["drafts"]) * 100, 1),
            },
            "costs": {
                "total_estimated_usd": round(total_usd, 3),
                "total_estimated_brl": round(total_usd * COST_ESTIMATES["usd_to_brl"], 2),
                "is_approaching_cap": (radar_count >= 4 or drafts_count >= 16),
            }
        }

# ==============================================================================
# 4. IMPORTADOR DE CSV LEGADO (Página 7: cada linha entra como nova para revalidar)
# ==============================================================================

def import_legacy_csv(csv_content: str, tenant_id: str = "ws-1", db_path=DB_PATH) -> Dict[str, Any]:
    """Importa o CSV do piloto original.
    Regra obrigatória da página 7: 'cada linha entra como nova para revalidar a fonte.'
    """
    init_governance_schema(db_path)
    imported_count = 0
    skipped_count = 0
    errors = []

    f = io.StringIO(csv_content.strip())
    # Detect delimiter
    sample = csv_content[:1024]
    delimiter = ";" if ";" in sample else ","
    reader = csv.DictReader(f, delimiter=delimiter)

    # Normalize keys
    normalized_rows = []
    for row in reader:
        norm = {k.strip().lower(): v.strip() for k, v in row.items() if k}
        normalized_rows.append(norm)

    today_str = date.today().isoformat()

    with storage.connect(db_path) as db:
        for idx, row in enumerate(normalized_rows):
            url = row.get("url") or row.get("link") or row.get("fonte_url")
            if not url:
                skipped_count += 1
                continue

            try:
                valid_url = storage.validate_url(url)
            except Exception as e:
                errors.append(f"Linha {idx+1}: URL inválida '{url}': {str(e)}")
                skipped_count += 1
                continue

            oportunidade = row.get("oportunidade") or row.get("empresa") or row.get("titulo") or "Oportunidade Importada da Planilha"
            fonte = row.get("fonte") or row.get("canal") or "Planilha Legada CSV"
            tipo = "diagnostico" if "diag" in (row.get("tipo") or "").lower() else "candidatura"
            
            # REGRA DA PÁGINA 7:
            # "cada linha entra como nova para revalidar a fonte."
            # Estado fixo: 'nova', aderência original preservada ou resetada, nota=NULL.
            try:
                db.execute(
                    """INSERT INTO oportunidades (url, data, oportunidade, fonte, tipo, aderencia, nota, estado, criado_em, atualizado_em)
                       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'nova', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                       ON CONFLICT(url) DO UPDATE SET
                           oportunidade = excluded.oportunidade,
                           fonte = excluded.fonte,
                           tipo = excluded.tipo,
                           estado = 'nova',
                           nota = NULL,
                           atualizado_em = CURRENT_TIMESTAMP""",
                    (valid_url, today_str, oportunidade, fonte, tipo),
                )
                db.execute(
                    """INSERT INTO historico_acoes (url, acao, detalhe)
                       VALUES (?, 'importado da planilha legada', 'Importado via CSV com reset para estado nova para revalidacao humana da fonte')""",
                    (valid_url,),
                )
                imported_count += 1
            except Exception as exc:
                errors.append(f"Erro na URL {valid_url}: {str(exc)}")
                skipped_count += 1

    record_audit_event(
        tenant_id,
        "csv_imported",
        "opportunities",
        f"count_{imported_count}",
        {"imported": imported_count, "skipped": skipped_count, "errors_count": len(errors)},
        db_path=db_path
    )

    return {
        "success": True,
        "imported": imported_count,
        "skipped": skipped_count,
        "errors": errors[:5],
    }

# ==============================================================================
# 5. BACKUP & RESTAURAÇÃO ENSAIADOS COM ASSINATURA SHA-256
# ==============================================================================

def create_backup_payload(db_path=DB_PATH) -> Dict[str, Any]:
    """Gera um snapshot integral dos dados com checksum SHA-256."""
    init_governance_schema(db_path)
    with storage.connect(db_path) as db:
        opps = [dict(r) for r in db.execute("SELECT * FROM oportunidades").fetchall()]
        revisoes = [dict(r) for r in db.execute("SELECT * FROM revisoes").fetchall()]
        history = [dict(r) for r in db.execute("SELECT * FROM historico_acoes").fetchall()]
        api_keys = [dict(r) for r in db.execute("SELECT id, tenant_id, name, prefix, active, created_at FROM saas_api_keys").fetchall()]
        jobs = [dict(r) for r in db.execute("SELECT * FROM saas_jobs ORDER BY created_at DESC LIMIT 100").fetchall()]

    data_to_hash = json.dumps({"opps": opps, "revisoes": revisoes, "history": history}, sort_keys=True)
    checksum = hashlib.sha256(data_to_hash.encode("utf-8")).hexdigest()

    return {
        "version": "1.0-release-snapshot",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "checksum_sha256": checksum,
        "counts": {
            "opportunities": len(opps),
            "revisoes": len(revisoes),
            "history": len(history),
            "api_keys": len(api_keys),
            "jobs": len(jobs),
        },
        "data": {
            "opportunities": opps,
            "revisoes": revisoes,
            "history": history,
            "api_keys": api_keys,
            "jobs": jobs,
        }
    }

def restore_backup_payload(payload: Dict[str, Any], db_path=DB_PATH) -> Dict[str, Any]:
    """Restaura o backup validando integridade criptográfica SHA-256."""
    init_governance_schema(db_path)
    data = payload.get("data", {})
    checksum_recebido = payload.get("checksum_sha256")

    # Verifica integridade do payload
    data_to_hash = json.dumps({
        "opps": data.get("opportunities", []),
        "revisoes": data.get("revisoes", []),
        "history": data.get("history", [])
    }, sort_keys=True)
    calculated_checksum = hashlib.sha256(data_to_hash.encode("utf-8")).hexdigest()

    if checksum_recebido and calculated_checksum != checksum_recebido:
        return {
            "success": False,
            "error": "Falha de integridade criptográfica: checksum SHA-256 divergente."
        }

    with storage.connect(db_path) as db:
        # Inserção de oportunidades
        for opp in data.get("opportunities", []):
            db.execute(
                """INSERT INTO oportunidades (url, data, oportunidade, fonte, tipo, aderencia, nota, estado, criado_em, atualizado_em)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(url) DO UPDATE SET
                       oportunidade = excluded.oportunidade,
                       fonte = excluded.fonte,
                       tipo = excluded.tipo,
                       aderencia = excluded.aderencia,
                       nota = excluded.nota,
                       estado = excluded.estado,
                       atualizado_em = excluded.atualizado_em""",
                (opp["url"], opp["data"], opp["oportunidade"], opp["fonte"], opp["tipo"],
                 opp.get("aderencia"), opp.get("nota"), opp.get("estado", "nova"),
                 opp.get("criado_em", datetime.now().isoformat()), opp.get("atualizado_em", datetime.now().isoformat()))
            )

    return {
        "success": True,
        "checksum_verified": calculated_checksum,
        "restored_opportunities": len(data.get("opportunities", [])),
        "restored_at": datetime.now(timezone.utc).isoformat(),
    }

# ==============================================================================
# 6. FILA DE EVENTOS E AUDITORIA (OUTBOX)
# ==============================================================================

def record_audit_event(tenant_id: str, event_type: str, resource_type: str, resource_id: str, payload: dict, actor: str = "operator", db=None, db_path=DB_PATH):
    """Grava evento imutável na fila de auditoria (Outbox pattern)."""
    if db is not None:
        db.execute(
            """INSERT INTO saas_audit_events (tenant_id, event_type, resource_type, resource_id, payload, actor)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (tenant_id, event_type, resource_type, resource_id, json.dumps(payload), actor),
        )
    else:
        with storage.connect(db_path) as conn:
            conn.execute(
                """INSERT INTO saas_audit_events (tenant_id, event_type, resource_type, resource_id, payload, actor)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (tenant_id, event_type, resource_type, resource_id, json.dumps(payload), actor),
            )

def list_audit_events(tenant_id: Optional[str] = None, limit: int = 100, db_path=DB_PATH) -> List[Dict[str, Any]]:
    """Consulta os registros de auditoria."""
    init_governance_schema(db_path)
    with storage.connect(db_path) as db:
        if tenant_id:
            rows = db.execute(
                """SELECT * FROM saas_audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?""",
                (tenant_id, limit),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT * FROM saas_audit_events ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
