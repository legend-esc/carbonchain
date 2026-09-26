-- slow-queries.sql
--
-- Top 10 slowest queries from pg_stat_statements.
-- Run against the off-chain PostgreSQL index.
--
-- Prerequisite: pg_stat_statements extension must be enabled.
-- See docker-compose.yml for enabling it in local dev.

SELECT
  queryid,
  calls,
  ROUND(total_exec_time::numeric, 2)  AS total_ms,
  ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
  ROUND(100.0 * total_exec_time / SUM(total_exec_time) OVER (), 1) AS percentage,
  LEFT(query, 120)                    AS query_preview
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
