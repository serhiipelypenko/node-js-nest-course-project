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
