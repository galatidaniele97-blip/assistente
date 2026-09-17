#!/usr/bin/env bash
# Esegue gli script SQL in ordine dentro il container Docker "mes-sql".
# Uso: ./run-scripts.sh            (schema + procedure + dati di esempio)
#      ./run-scripts.sh --test     (in più esegue i test della macchina a stati)
set -euo pipefail
cd "$(dirname "$0")"
PASSWORD="${MSSQL_SA_PASSWORD:-Pizzami!Demo2026}"
SQLCMD=(docker exec -i mes-sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$PASSWORD" -C -b)

echo "Attendo che SQL Server sia pronto..."
for i in $(seq 1 30); do
  if "${SQLCMD[@]}" -Q "SELECT 1" -o /dev/null 2>/dev/null; then break; fi
  sleep 2
  if [ "$i" -eq 30 ]; then echo "SQL Server non risponde" >&2; exit 1; fi
done

for f in 00_database.sql 01_schema.sql 02_procedures.sql 03_seed.sql; do
  echo "==> $f"
  "${SQLCMD[@]}" -i "/mes/db/$f"
done

if [ "${1:-}" = "--test" ]; then
  echo "==> test/state-machine.test.sql"
  "${SQLCMD[@]}" -i "/mes/test/state-machine.test.sql"
fi
echo "Fatto."
