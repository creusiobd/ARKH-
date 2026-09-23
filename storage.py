"""Persistência local do ARKHÉ Revenue Radar. Nenhuma ação de rede aqui."""

import csv
import sqlite3
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit, urldefrag

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "radar.sqlite3"
STATUSES = (
    "nova", "verificada", "descartada", "contato preparado", "enviada",
    "respondeu", "reunião", "proposta", "fechada",
)
CSV_COLUMNS = ("Data", "Oportunidade", "URL", "Tipo", "Aderência", "Status", "Próxima ação", "Resultado")


def validate_url(url):
    url = urldefrag(url.strip()).url
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or any(c.isspace() for c in url):
        raise ValueError("Use uma URL pública http(s) válida.")
    return url


def connect(path=DB_PATH, require_exists=False):
    path = Path(path)
    if require_exists and not path.is_file():
        raise ValueError("Banco ausente. Execute 'python memoria.py init' primeiro.")
    db = sqlite3.connect(path, timeout=10.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA busy_timeout = 5000")
    return db


def init_db(path=DB_PATH):
    with connect(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS oportunidades (
                url TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                oportunidade TEXT NOT NULL,
                fonte TEXT NOT NULL,
                tipo TEXT NOT NULL,
                aderencia INTEGER,
                nota INTEGER,
                estado TEXT NOT NULL DEFAULT 'nova',
                criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS historico_acoes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL REFERENCES oportunidades(url),
                acao TEXT NOT NULL,
                detalhe TEXT NOT NULL DEFAULT '',
                criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS revisoes (
                url TEXT PRIMARY KEY REFERENCES oportunidades(url),
                arquivo TEXT NOT NULL,
                hash_aprovado TEXT,
                aprovado_em TEXT
            );
        """)
        # Acrescenta campos à versão inicial do banco sem apagar oportunidades antigas.
        fields = {row["name"] for row in db.execute("PRAGMA table_info(oportunidades)")}
        for name in ("proxima_acao", "resultado", "company_size", "industry_sector", "scoring_metadata"):
            if name not in fields:
                db.execute(f"ALTER TABLE oportunidades ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")


def get(url, path=DB_PATH):
    with connect(path, require_exists=True) as db:
        row = db.execute("SELECT * FROM oportunidades WHERE url = ?", (validate_url(url),)).fetchone()
    if row is None:
        raise ValueError("URL não cadastrada. Copie a URL de 'memoria.py listar'.")
    return dict(row)


def add(url, oportunidade, fonte, tipo, path=DB_PATH, data=None, estado="nova", proxima_acao="", resultado="",
        company_size="", industry_sector="", scoring_metadata="", aderencia=None, nota=None):
    url = validate_url(url)
    if not all(s.strip() for s in (oportunidade, fonte, tipo)):
        raise ValueError("Oportunidade, fonte e tipo são obrigatórios.")
    if estado not in STATUSES:
        raise ValueError(f"Status inválido: {estado}")
    data = data or date.today().isoformat()
    date.fromisoformat(data)
    init_db(path)
    with connect(path) as db:
        cursor = db.execute(
            """INSERT OR IGNORE INTO oportunidades
               (url, data, oportunidade, fonte, tipo, estado, proxima_acao, resultado,
                company_size, industry_sector, scoring_metadata, aderencia, nota)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (url, data, oportunidade.strip(), fonte.strip(), tipo.strip(), estado, proxima_acao, resultado,
             company_size, industry_sector, scoring_metadata, aderencia, nota),
        )
        if cursor.rowcount:
            db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, ?, ?)",
                       (url, "cadastrada", f"Status: {estado}"))
    return bool(cursor.rowcount)


def score(url, aderencia, sinal, fonte, recencia, path=DB_PATH, scoring_metadata=None):
    valores = (aderencia, sinal, fonte, recencia)
    if any(type(v) is not int or not 0 <= v <= 5 for v in valores):
        raise ValueError("Cada critério deve ser um número inteiro de 0 a 5.")
    nota = 7 * aderencia + 6 * sinal + 4 * fonte + 3 * recencia
    get(url, path)
    with connect(path) as db:
        if scoring_metadata is not None:
            db.execute("UPDATE oportunidades SET aderencia=?, nota=?, scoring_metadata=?, atualizado_em=CURRENT_TIMESTAMP WHERE url=?",
                       (aderencia, nota, scoring_metadata, validate_url(url)))
        else:
            db.execute("UPDATE oportunidades SET aderencia=?, nota=?, atualizado_em=CURRENT_TIMESTAMP WHERE url=?",
                       (aderencia, nota, validate_url(url)))
        db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'pontuada', ?)",
                   (validate_url(url), f"A={aderencia}; S={sinal}; F={fonte}; R={recencia}; nota={nota}"))
    return nota


def update(url, *, estado=None, proxima_acao=None, resultado=None,
           company_size=None, industry_sector=None, scoring_metadata=None,
           aderencia=None, nota=None, path=DB_PATH):
    get(url, path)
    if estado is not None and estado not in STATUSES:
        raise ValueError(f"Status inválido: {estado}")
    values = {
        "estado": estado,
        "proxima_acao": proxima_acao,
        "resultado": resultado,
        "company_size": company_size,
        "industry_sector": industry_sector,
        "scoring_metadata": scoring_metadata,
        "aderencia": aderencia,
        "nota": nota,
    }
    changes = {key: value for key, value in values.items() if value is not None}
    if not changes:
        raise ValueError("Nenhuma alteração informada.")
    setters = ", ".join(f"{key}=?" for key in changes)
    with connect(path) as db:
        db.execute(f"UPDATE oportunidades SET {setters}, atualizado_em=CURRENT_TIMESTAMP WHERE url=?",
                   (*changes.values(), validate_url(url)))
        db.execute("INSERT INTO historico_acoes(url, acao, detalhe) VALUES (?, 'atualizada', ?)",
                   (validate_url(url), "; ".join(f"{k}={v}" for k, v in changes.items())))


def list_rows(path=DB_PATH):
    with connect(path, require_exists=True) as db:
        return [dict(r) for r in db.execute(
            "SELECT * FROM oportunidades ORDER BY COALESCE(nota,-1) DESC, data DESC, url")]


def history(url, path=DB_PATH):
    get(url, path)
    with connect(path) as db:
        return [dict(r) for r in db.execute(
            "SELECT criado_em, acao, detalhe FROM historico_acoes WHERE url=? ORDER BY id", (validate_url(url),))]


def import_csv(file, path=DB_PATH):
    init_db(path)
    added = skipped = 0
    with open(file, encoding="utf-8-sig", newline="") as stream:
        preview = stream.read(4096)
        stream.seek(0)
        dialect = csv.Sniffer().sniff(preview, delimiters=",;")
        reader = csv.DictReader(stream, dialect=dialect)
        if not set(CSV_COLUMNS).issubset(reader.fieldnames or []):
            raise ValueError("Cabeçalhos exigidos: " + ", ".join(CSV_COLUMNS))
        for row in reader:
            url = row["URL"].strip()
            if not url:
                skipped += 1
                continue
            host = urlsplit(validate_url(url)).netloc
            data = row["Data"].strip() or date.today().isoformat()
            status = row["Status"].strip() or "nova"
            if add(url, row["Oportunidade"], host, row["Tipo"], path=path,
                   data=data, estado=status, proxima_acao=row["Próxima ação"],
                   resultado=row["Resultado"]):
                added += 1
            else:
                skipped += 1
            # Uma aderência numérica da planilha é preservada; nota exige os quatro critérios.
            raw_aderencia = row["Aderência"].strip()
            if raw_aderencia and raw_aderencia.isdigit() and 0 <= int(raw_aderencia) <= 5:
                with connect(path) as db:
                    db.execute("UPDATE oportunidades SET aderencia=? WHERE url=? AND aderencia IS NULL",
                               (int(raw_aderencia), validate_url(url)))
    return added, skipped


def export_csv(file, path=DB_PATH):
    rows = list_rows(path)
    with open(file, "w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(CSV_COLUMNS)
        for row in rows:
            writer.writerow((row["data"], row["oportunidade"], row["url"], row["tipo"],
                             "" if row["aderencia"] is None else row["aderencia"],
                             row["estado"], row["proxima_acao"], row["resultado"]))
    return len(rows)
