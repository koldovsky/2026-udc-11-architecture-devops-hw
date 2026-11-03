# Post-mortem: деградація pickup після v1.8.0

- **Дата і тривалість:** 2026-10-14, приблизно 14:02–14:48 (46 хвилин).
- **Вплив:** частина мешканців не могла забрати посилки; 3380 відповідей 503 і 125 окремих 500 у API-лозі. Докази: `docs/rca.md`.
- **Виявлення:** alerts p95 о 14:06 і 5xx о 14:07, плюс повідомлення мешканців.
- **Причина:** v1.8.0 перейменував `DB_POOL_MAX` на `DB_POOL_SIZE`, але код читає лише `DB_POOL_MAX` і застосував fallback 4.

## Часова шкала

13:37 — окремий SMS-429 alert; 14:02 — deploy v1.8.0; 14:06–14:07 — API alerts; 14:20 — безрезультатний restart; 14:47 — rollback v1.7.3; 14:48 — API відновлено; 15:03 — закрито SMS alert.

## Що спрацювало / що ні

Спрацювали p95/5xx alerts, детальні `PoolTimeoutError` і доступний rollback. Не спрацювали контрактна перевірка env, readiness за межами `/health`, startup-перевірка effective config; restart без зміни конфігурації повторив несправний стан. SMS-429 і heap warning ускладнили розділення причин.

## Action items

Усі заходи нижче мають явно задані тип, роль-власника та перевірюваний критерій. Rollback слід виконувати лише на заздалегідь визначений good release.

| # | Дія | Тип | Власник | Критерій |
|---|---|---|---|---|
| 1 | CI перевіряє, що pool env у compose відповідає ключу, який читає код. | prevent | maintainer CI | Тест `DB_POOL_SIZE` FAIL, `DB_POOL_MAX` PASS; `npm run test:tools` green. |
| 2 | Fail-fast при відсутньому pool config і безпечний startup log effective pool. | prevent | runtime developer | Старт без config завершується помилкою; log має pool max без секретів. |
| 3 | Readiness перевіряє DB acquire і pickup read-path. | detect | SRE | Synthetic check стає non-ready при виснаженні пулу. |
| 4 | Alert/dashboard для waiting, timeout і фактичного pool max. | detect | observability owner | Alert за 2 хв після waiting > 0 протягом 3 хв. |
| 5 | Rollback-процедура з drill. | mitigate | on-call lead | Rollback дає p95 < 500 мс і waiting=0. |
| 6 | Розвести SMS/API SLO та додати deploy overlay. | detect | observability owner | Dashboard показує незалежні початок/кінець подій. |

## Правило перевірки

Захід реалізовано правилом `C5` у `tools/check-deploy.mjs`: воно читає фактичні `env.NAME` з `app/src/config.js` і змінні з `POOL` у `deploy/compose.yaml`, відхиляючи будь-яку deployment-назву, якої застосунок не читає. Це ловить не лише `DB_POOL_MAX` → `DB_POOL_SIZE`, а й аналогічні перейменування; compose без pool override проходить і використовує defaults застосунку.

Додані тести перевіряють: інцидентна конфігурація `DB_POOL_SIZE` проти коду з `DB_POOL_MAX` дає `FAIL`, коректна `DB_POOL_MAX` і конфігурація без pool override дають `PASS`. Перевірка — `npm run test:tools` та `npm run check:deploy`.

У `tools/check-deploy.mjs` потрібне правило, яке відхиляє `DB_POOL_SIZE`, якщо runtime читає `DB_POOL_MAX`; negative/positive cases у `tools/test/`, `npm run test:tools` — PASS. Це ловить клас несумісних конфігурацій.
