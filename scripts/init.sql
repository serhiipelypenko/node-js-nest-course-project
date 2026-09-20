-- Виконується автоматично при першій ініціалізації тому Postgres
-- (docker-entrypoint-initdb.d). Створює роль і базу застосунку.
--
-- Пароль тут — СТАРТОВИЙ. Він мусить збігатися з початковим вмістом
-- secrets/db_password. rotate.sh потім змінює його через ALTER ROLE,
-- НЕ чіпаючи цей файл. Після `docker compose down -v` том зникає, init.sql
-- виконається знову і поверне стартовий пароль — тоді треба повернути й
-- secrets/db_password.

CREATE ROLE marketplace WITH LOGIN PASSWORD 'dev_secret_pw';
CREATE DATABASE marketplace OWNER marketplace;
GRANT ALL PRIVILEGES ON DATABASE marketplace TO marketplace;

-- hw-15: службова роль для PgBouncer (auth_query). PgBouncer логіниться нею й
-- питає SCRAM-хеш ролі-клієнта через функцію нижче — тож ротація пароля
-- marketplace (rotate.sh) не вимагає чіпати конфіг PgBouncer.
-- Пароль pgbouncer_auth мусить збігатися з pgbouncer/userlist.txt (dev-фейк).
CREATE ROLE pgbouncer_auth WITH LOGIN PASSWORD 'pgbouncer_auth_dev_pw';

\connect marketplace

CREATE SCHEMA pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;

-- SECURITY DEFINER: pg_shadow бачить лише superuser, а функцію створює він.
-- Віддає хеш ОДНІЄЇ ролі за іменем, і лише службовій ролі.
CREATE FUNCTION pgbouncer.get_auth(p_usename TEXT)
RETURNS TABLE (usename NAME, passwd TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS
$$ SELECT usename, passwd FROM pg_shadow WHERE usename = p_usename $$;

REVOKE ALL ON FUNCTION pgbouncer.get_auth(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;
