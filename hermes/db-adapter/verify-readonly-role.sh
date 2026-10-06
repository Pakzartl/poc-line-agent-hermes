#!/bin/sh
set -eu

psql_bin=${PSQL_BIN:-psql}
connection_env=${DB_READONLY_CONNECTION_ENV:-}
probe_table=${DB_READONLY_PROBE_TABLE:-}

case "$connection_env" in
	''|*[!A-Z0-9_]*)
		echo "DB_READONLY_CONNECTION_ENV must name an uppercase environment variable" >&2
		exit 2
		;;
esac

if ! printf '%s\n' "$probe_table" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$'; then
	echo "DB_READONLY_PROBE_TABLE must be an explicit schema.table identifier" >&2
	exit 2
fi

connection_string=$(printenv "$connection_env" || true)
if [ -z "$connection_string" ]; then
	echo "configured read-only connection environment variable is empty" >&2
	exit 2
fi
export PGDATABASE=$connection_string
unset connection_string

readonly_default=$(
	"$psql_bin" --no-psqlrc -X -Atqc 'SHOW default_transaction_read_only'
)
if [ "$readonly_default" != "on" ]; then
	echo "read-only role verification failed: default_transaction_read_only is not on" >&2
	exit 1
fi

set +e
"$psql_bin" --no-psqlrc -X -v ON_ERROR_STOP=1 \
	-c "BEGIN; SET TRANSACTION READ WRITE; DELETE FROM $probe_table WHERE false; ROLLBACK;" \
	>/dev/null 2>&1
write_status=$?
set -e

if [ "$write_status" -eq 0 ]; then
	echo "read-only role verification failed: a DELETE statement was permitted" >&2
	exit 1
fi

echo "read-only role verified: read-only default is on and write probe was rejected"
