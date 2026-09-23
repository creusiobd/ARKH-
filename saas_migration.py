import sqlite3
from pathlib import Path

DB_PATH = Path("radar.sqlite3")

def run_migration(verbose=False):
    conn = sqlite3.connect(DB_PATH)
    with conn:
        cursor = conn.cursor()
        
        # Check existing columns in oportunidades
        cursor.execute("PRAGMA table_info(oportunidades)")
        existing_cols = [col[1] for col in cursor.fetchall()]
        
        new_cols = [
            ("workspace_id", "TEXT DEFAULT 'ws-1'"),
            ("tags", "TEXT DEFAULT ''"),
            ("valor_estimado", "REAL DEFAULT 45000.0"),
            ("contato_cargo", "TEXT DEFAULT ''"),
            ("company_size", "TEXT DEFAULT ''"),
            ("industry_sector", "TEXT DEFAULT ''"),
            ("scoring_metadata", "TEXT DEFAULT ''"),
            ("data_envio_proposta", "TEXT DEFAULT ''"),
            ("ultimo_followup_em", "TEXT DEFAULT ''")
        ]
        
        for col_name, col_type in new_cols:
            if col_name not in existing_cols:
                try:
                    cursor.execute(f"ALTER TABLE oportunidades ADD COLUMN {col_name} {col_type}")
                    if verbose:
                        print(f"Coluna adicionada: {col_name}")
                except Exception as e:
                    if verbose:
                        print(f"Erro ao adicionar {col_name}: {e}")
        
        # Create workspace_config table
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS workspace_config (
            workspace_id TEXT PRIMARY KEY,
            name TEXT,
            niche TEXT,
            tier TEXT,
            credits_used INTEGER DEFAULT 0,
            credit_limit INTEGER DEFAULT 100,
            webhook_url TEXT DEFAULT '',
            webhook_channel TEXT DEFAULT 'slack',
            notify_on_qualification INTEGER DEFAULT 1,
            notify_on_approval INTEGER DEFAULT 1,
            email_provider TEXT DEFAULT 'resend',
            email_sender TEXT DEFAULT 'sre-advisory@arkhe.io',
            stale_days_threshold INTEGER DEFAULT 7,
            auto_email_notify INTEGER DEFAULT 1
        )
        """)

        # Add missing columns to workspace_config if already existed
        cursor.execute("PRAGMA table_info(workspace_config)")
        existing_ws_cols = [col[1] for col in cursor.fetchall()]
        ws_new_cols = [
            ("email_provider", "TEXT DEFAULT 'resend'"),
            ("email_sender", "TEXT DEFAULT 'sre-advisory@arkhe.io'"),
            ("stale_days_threshold", "INTEGER DEFAULT 7"),
            ("auto_email_notify", "INTEGER DEFAULT 1")
        ]
        for col_name, col_type in ws_new_cols:
            if col_name not in existing_ws_cols:
                try:
                    cursor.execute(f"ALTER TABLE workspace_config ADD COLUMN {col_name} {col_type}")
                except Exception as e:
                    if verbose:
                        print(f"Erro ao adicionar {col_name} em workspace_config: {e}")

        # Create notification_logs table for audit trail of email & messaging dispatches
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS notification_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT,
            opportunity_name TEXT,
            recipient_email TEXT NOT NULL,
            sender_email TEXT NOT NULL,
            subject TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'DELIVERED',
            message_id TEXT NOT NULL,
            days_inactive INTEGER DEFAULT 0,
            payload_preview TEXT DEFAULT '',
            dispatched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """)
        
        # Seed default workspaces
        workspaces = [
            ("ws-1", "ARKHÉ Advisory HQ", "Consultoria SRE & Observabilidade", "Enterprise SRE Advisory", 42, 100, "https://hooks.slack.com/services/T00/B00/ARKHE_HQ", "slack", 1, 1),
            ("ws-2", "Fintech Cloud Squad", "Meios de Pagamento & Pix Latam", "Growth Pro", 18, 50, "", "slack", 1, 1),
            ("ws-3", "Reliability Scouts", "Executive SRE Headhunting", "Scout Free", 9, 25, "", "discord", 1, 0)
        ]
        
        for ws in workspaces:
            cursor.execute("""
            INSERT INTO workspace_config (workspace_id, name, niche, tier, credits_used, credit_limit, webhook_url, webhook_channel, notify_on_qualification, notify_on_approval)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
                name = excluded.name,
                niche = excluded.niche,
                tier = excluded.tier
            """, ws)
            
        if verbose:
            print("Migração SaaS concluída com sucesso.")

if __name__ == "__main__":
    run_migration(verbose=True)
