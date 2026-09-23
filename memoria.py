"""CLI do banco local: python memoria.py --help."""

import argparse
import sys

import storage


def main(argv=None):
    parser = argparse.ArgumentParser(description="ARKHÉ: oportunidades, pontuação e planilha")
    sub = parser.add_subparsers(dest="comando", required=True)
    sub.add_parser("init", help="criar ou atualizar o banco SQLite")
    sub.add_parser("listar", help="mostrar oportunidades por nota")

    add = sub.add_parser("add", help="registrar URL nova sem substituir um registro existente")
    add.add_argument("url")
    add.add_argument("--oportunidade", required=True)
    add.add_argument("--fonte", required=True)
    add.add_argument("--tipo", required=True)

    score = sub.add_parser("pontuar", help="quatro critérios de 0 a 5; nota de 0 a 100")
    score.add_argument("url")
    for name in ("aderencia", "sinal", "fonte", "recencia"):
        score.add_argument(f"--{name}", type=int, required=True)

    update = sub.add_parser("atualizar", help="alterar status, próxima ação ou resultado")
    update.add_argument("url")
    update.add_argument("--status", choices=storage.STATUSES)
    update.add_argument("--proxima-acao")
    update.add_argument("--resultado")

    estado = sub.add_parser("estado", help="atalho para atualizar status")
    estado.add_argument("url")
    estado.add_argument("status", choices=storage.STATUSES)
    hist = sub.add_parser("historico")
    hist.add_argument("url")
    imported = sub.add_parser("importar-csv", help="importar CSV UTF-8 com as oito colunas da planilha")
    imported.add_argument("arquivo")
    exported = sub.add_parser("exportar-csv", help="exportar um CSV UTF-8 para abrir no Excel")
    exported.add_argument("arquivo")

    args = parser.parse_args(argv)
    try:
        if args.comando == "init":
            storage.init_db()
            print(f"Banco pronto: {storage.DB_PATH}")
        elif args.comando == "add":
            created = storage.add(args.url, args.oportunidade, args.fonte, args.tipo)
            print("Oportunidade cadastrada como nova." if created else "URL já cadastrada; registro preservado.")
        elif args.comando == "pontuar":
            nota = storage.score(args.url, args.aderencia, args.sinal, args.fonte, args.recencia)
            print(f"Nota: {nota}/100")
        elif args.comando in ("estado", "atualizar"):
            if args.comando == "estado":
                storage.update(args.url, estado=args.status)
            else:
                storage.update(args.url, estado=args.status, proxima_acao=args.proxima_acao,
                               resultado=args.resultado)
            print("Registro atualizado.")
        elif args.comando == "listar":
            for row in storage.list_rows():
                nota = "—" if row["nota"] is None else str(row["nota"])
                print(f"{nota}/100 | {row['estado']} | {row['oportunidade']}\n  {row['url']}")
        elif args.comando == "historico":
            for row in storage.history(args.url):
                print(f"{row['criado_em']} | {row['acao']} | {row['detalhe']}")
        elif args.comando == "importar-csv":
            created, skipped = storage.import_csv(args.arquivo)
            print(f"Importadas: {created}; ignoradas (vazias ou URLs existentes): {skipped}.")
        elif args.comando == "exportar-csv":
            count = storage.export_csv(args.arquivo)
            print(f"Exportadas: {count}. Arquivo: {args.arquivo}")
    except (ValueError, OSError) as exc:
        parser.exit(2, f"Erro: {exc}\n")


if __name__ == "__main__":
    main()
