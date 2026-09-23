"""Rascunhos e registro de contato manual com aprovação humana.

Este script nunca envia e-mails, mensagens ou candidaturas.
Requer radar.sqlite3 criado por memoria.py, na mesma pasta deste arquivo.
O comando `preparar` usa OPENAI_API_KEY; os outros comandos são locais.
"""

import argparse
import hashlib
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import storage

BASE = Path(__file__).resolve().parent
BANCO = storage.DB_PATH
RASCUNHOS = BASE / "rascunhos"
MODELO = "gpt-5.6-luna"
NOTA_MINIMA = 70  # Regra do piloto: mude aqui se decidir outro corte.


def conectar():
    return storage.connect(BANCO, require_exists=True)


def preparar_tabela_revisoes():
    if not BANCO.is_file():
        raise ValueError("Banco ausente. Execute 'python memoria.py init' primeiro.")
    storage.init_db(BANCO)
    with conectar() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS revisoes (
                   url TEXT PRIMARY KEY REFERENCES oportunidades(url),
                   arquivo TEXT NOT NULL,
                   hash_aprovado TEXT,
                   aprovado_em TEXT
               )"""
        )


def obter_oportunidade(url):
    with conectar() as db:
        row = db.execute(
            """SELECT url, data, oportunidade, fonte, tipo, nota, estado
               FROM oportunidades WHERE url = ?""",
            (url,),
        ).fetchone()
    if row is None:
        raise SystemExit("URL não cadastrada. Copie-a do comando memoria.py listar.")
    return row


def exigir_verificada(row, permitir_reaprovacao=False):
    estados_permitidos = ("verificada", "contato preparado") if permitir_reaprovacao else ("verificada",)
    if row["estado"] not in estados_permitidos:
        raise SystemExit("Marque a oportunidade como verificada em memoria.py.")
    if row["nota"] is None or row["nota"] < NOTA_MINIMA:
        raise SystemExit(
            f"A nota precisa ser pelo menos {NOTA_MINIMA}/100 para este piloto."
        )


def listar():
    with conectar() as db:
        rows = db.execute(
            """SELECT nota, oportunidade, url FROM oportunidades
               WHERE estado = 'verificada' AND nota >= ?
               ORDER BY nota DESC, data DESC""",
            (NOTA_MINIMA,),
        ).fetchall()
    if not rows:
        print("Nenhuma oportunidade verificada atingiu o corte do piloto.")
    for row in rows:
        print(f"{row['nota']}/100 | {row['oportunidade']}\n  {row['url']}")


def preparar(url, objetivo, canal, fato, perfil):
    row = obter_oportunidade(url)
    exigir_verificada(row)
    if objetivo == "candidatura" and not perfil.strip():
        raise SystemExit("Para candidatura, informe --perfil com fatos do seu currículo.")
    if not fato.strip():
        raise SystemExit("Informe em --fato um fato que você verificou na fonte.")
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY ausente. Reabra o terminal após configurá-la.")

    from openai import OpenAI

    foco = (
        "Proponha uma conversa breve sobre um diagnóstico de observabilidade "
        "com escopo de cinco dias, mapa de pontos cegos e recomendações. "
        "Não prometa resultado nem afirme que a empresa quer comprar."
        if objetivo == "diagnostico"
        else "Prepare uma candidatura breve, usando somente os fatos "
        "profissionais fornecidos. Não invente cargos, números ou experiências."
    )
    resposta = OpenAI().responses.create(
        model=MODELO,
        instructions=(
            "Redija um rascunho em português do Brasil para revisão humana. "
            "Use tom direto e respeitoso, até 150 palavras. "
            "Não invente destinatário, e-mail, situação interna, preço ou data. "
            "Apresente o fato verificado como sinal, não como prova de interesse. "
            "Não afirme que você navegou ou confirmou a URL; o fato veio do usuário. "
            "Escreva somente o texto da mensagem, sem endereço de envio. "
            + foco
        ),
        input=(
            f"Canal: {canal}\nObjetivo: {objetivo}\n"
            f"Oportunidade: {row['oportunidade']}\n"
            f"Tipo: {row['tipo']}\nFonte pública: {row['fonte']}\n"
            f"URL: {row['url']}\nData do registro: {row['data']}\n"
            f"Fato conferido pela pessoa: {fato}\n"
            f"Perfil profissional fornecido pela pessoa: {perfil or 'não informado'}"
        ),
    )
    corpo = resposta.output_text.strip()
    if not corpo:
        raise SystemExit("A API não retornou texto; nenhum rascunho foi registrado.")

    RASCUNHOS.mkdir(exist_ok=True)
    identificador = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    carimbo = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    arquivo = RASCUNHOS / f"{identificador}-{carimbo}.md"
    arquivo.write_text(
        f"# Rascunho para revisão\n\n"
        f"URL da oportunidade: {url}\n\n"
        f"Objetivo: {objetivo}\nCanal: {canal}\n"
        f"Fato conferido: {fato}\n\n"
        f"## Mensagem\n\n{corpo}\n",
        encoding="utf-8",
    )

    with conectar() as db:
        db.execute(
            """INSERT INTO revisoes(url, arquivo, hash_aprovado, aprovado_em)
               VALUES (?, ?, NULL, NULL)
               ON CONFLICT(url) DO UPDATE SET
                 arquivo = excluded.arquivo,
                 hash_aprovado = NULL,
                 aprovado_em = NULL""",
            (url, arquivo.name),
        )
        db.execute(
            """INSERT INTO historico_acoes(url, acao, detalhe)
               VALUES (?, 'rascunho gerado', ?)""",
            (url, arquivo.name),
        )
    print(f"Rascunho salvo em: {arquivo}")
    print("Revise fatos, tom, destino e proposta antes de aprovar.")


def revisao_atual(url):
    with conectar() as db:
        row = db.execute(
            "SELECT arquivo, hash_aprovado FROM revisoes WHERE url = ?", (url,)
        ).fetchone()
    if row is None:
        raise SystemExit("Ainda não há rascunho para esta URL.")
    arquivo = RASCUNHOS / row["arquivo"]
    if not arquivo.is_file():
        raise SystemExit(f"Rascunho não encontrado: {arquivo}")
    if f"URL da oportunidade: {url}" not in arquivo.read_text(encoding="utf-8"):
        raise SystemExit("O arquivo não corresponde à URL desta oportunidade.")
    return row, arquivo


def aprovar(url):
    exigir_verificada(obter_oportunidade(url), permitir_reaprovacao=True)
    _, arquivo = revisao_atual(url)
    print(f"Leia e ajuste antes de aprovar: {arquivo}")
    if input("Após revisar, digite APROVAR: ").strip() != "APROVAR":
        print("Sem alterações no status.")
        return

    resumo = hashlib.sha256(arquivo.read_bytes()).hexdigest()
    with conectar() as db:
        db.execute(
            """UPDATE revisoes SET hash_aprovado = ?,
               aprovado_em = CURRENT_TIMESTAMP WHERE url = ?""",
            (resumo, url),
        )
        db.execute(
            """UPDATE oportunidades SET estado = 'contato preparado',
               proxima_acao = 'Enviar manualmente após conferir o destinatário',
               atualizado_em = CURRENT_TIMESTAMP WHERE url = ?""",
            (url,),
        )
        db.execute(
            """INSERT INTO historico_acoes(url, acao, detalhe)
               VALUES (?, 'rascunho aprovado', ?)""",
            (url, f"{arquivo.name}; SHA-256={resumo}"),
        )
    print("Status: contato preparado. Nenhuma mensagem foi enviada.")


def registrar_envio(url, canal, observacao):
    if obter_oportunidade(url)["estado"] != "contato preparado":
        raise SystemExit("O status deve ser 'contato preparado'.")
    revisao, arquivo = revisao_atual(url)
    atual = hashlib.sha256(arquivo.read_bytes()).hexdigest()
    if not revisao["hash_aprovado"] or atual != revisao["hash_aprovado"]:
        raise SystemExit("O rascunho mudou após a aprovação. Revise e aprove novamente.")
    print("Este comando apenas registra um envio que você já realizou.")
    if input("Se já enviou pessoalmente, digite ENVIEI: ").strip() != "ENVIEI":
        print("Envio não registrado.")
        return

    with conectar() as db:
        db.execute(
            """UPDATE oportunidades SET estado = 'enviada',
               proxima_acao = 'Aguardar resposta e planejar acompanhamento',
               resultado = ?, atualizado_em = CURRENT_TIMESTAMP WHERE url = ?""",
            (f"Envio informado manualmente via {canal}: {observacao}", url),
        )
        db.execute(
            """INSERT INTO historico_acoes(url, acao, detalhe)
               VALUES (?, 'envio informado pela pessoa', ?)""",
            (url, f"Canal={canal}; arquivo={arquivo.name}; {observacao}"),
        )
    print("Status: enviada. Histórico atualizado.")


def main():
    parser = argparse.ArgumentParser(description="ARKHÉ: ações com revisão humana")
    comandos = parser.add_subparsers(dest="comando", required=True)
    comandos.add_parser("listar")

    gerar = comandos.add_parser("preparar")
    gerar.add_argument("url")
    gerar.add_argument("--objetivo", choices=("diagnostico", "candidatura"), required=True)
    gerar.add_argument("--canal", choices=("email", "linkedin"), required=True)
    gerar.add_argument("--fato", required=True)
    gerar.add_argument("--perfil", default="")

    revisar = comandos.add_parser("aprovar")
    revisar.add_argument("url")

    registrar = comandos.add_parser("registrar-envio")
    registrar.add_argument("url")
    registrar.add_argument("--canal", choices=("email", "linkedin"), required=True)
    registrar.add_argument("--observacao", required=True)

    args = parser.parse_args()
    try:
        preparar_tabela_revisoes()
        if args.comando != "listar":
            args.url = storage.validate_url(args.url)
        if args.comando == "listar":
            listar()
        elif args.comando == "preparar":
            preparar(args.url, args.objetivo, args.canal, args.fato, args.perfil)
        elif args.comando == "aprovar":
            aprovar(args.url)
        elif args.comando == "registrar-envio":
            registrar_envio(args.url, args.canal, args.observacao)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"Erro: {exc}\n")


if __name__ == "__main__":
    main()
