# Steel Analyzer — Telegram Pipeline Messages

Date: 2026-05-24
Status: active — manual run reference + future bot source

Это рабочие сообщения для каждого этапа pipeline.
При ручном прогоне — копируешь и вставляешь руками.
При автоматизации (Sprint 10) — бот отправляет их сам.

---

## Этап 0 — Запуск прогона

**Кто отправляет:** Codex / ты сам
**Кому:** в Telegram (себе)

```
🔵 Steel Analyzer запущен
Проект: Nordic A-jaur
Run ID: nordic-ajaur-v4-20260524
Drive folder: 1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5

Шаги:
1. ⬜ Download источников
2. ⬜ Gemini анализ
3. ⬜ Генерация workbooks
4. ⬜ Claude QA review
5. ⬜ Upload approval
6. ⬜ MD5 verify
```

---

## Этап 1 — Download завершён

**Кто отправляет:** steel-drive.mjs / Codex
**Кому:** в Telegram (себе)

```
✅ Download завершён
Run: nordic-ajaur-v4-20260524
Папка: agent-core/steel-bus/runs/nordic-ajaur-v4-20260524/sources/

Файлы:
- Bilaga 1 Ståldokumentation (Skärmtak).pdf — MD5 OK
- Bilaga 3 Ritningar (Skärmtak).pdf — MD5 OK
- Bilaga 1 Ståldokumentation (Ombyggnad).pdf — MD5 OK
[полный список из manifest-drive-download.json]

▶ Следующий шаг: отправить Gemini на анализ
```

---

## Этап 2 — Prompt для Gemini (анализ источников)

**Кто отправляет:** ты
**Кому:** Gemini

```
Steel Analyzer — Nordic A-jaur v4. Полный анализ с нуля.

Run ID: nordic-ajaur-v4-20260524
Sources: agent-core/steel-bus/runs/nordic-ajaur-v4-20260524/sources/
Drive folder: 1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5

Subprojects: Skärmtak, Ombyggnad

Задача:
1. Прочитать все PDF через pdftotext -layout.
2. Построить source inventory: reports / drawings / specs / models / correspondence.
3. Выбрать source of truth по правилам PRD (material list > assembly drawings > calculations).
4. Зафиксировать material decisions — ничего не решать молча.
5. Сгенерировать workbooks: BoM, Material List, Description.
   Выходные файлы: steel-bus/runs/nordic-ajaur-v4-20260524/output/
6. Валидировать Excel через workbook-validator.
7. Написать отчёт: source inventory, decisions, totals, open questions.

Известные решения из v3 (применять если источники подтверждают):
- Skärmtak тrusses — исключить из BoM/ML, оставить в Description
- Ombyggnad basis — без изменений

Контрольные тотals v3 (верифицировать или обосновать расхождение):
- Skärmtak procurement: 28.211 t / 740.700 m²
- Ombyggnad procurement: 21.151 t / 503.900 m²
- Total procurement: 49.363 t / 1244.600 m²

Правила PRD: /docs/handoffs/{steel} {handoff} analyzer prd - 2026-05-12.md

Вернуть: отчёт с source inventory, decisions log, итоговые тотals, open questions, PASS/FAIL.
```

---

## Этап 3 — Gemini отчёт получен

**Кто отправляет:** ты (после получения от Gemini)
**Кому:** в Telegram (себе)

```
📋 Gemini анализ получен
Run: nordic-ajaur-v4-20260524

Статус: [PASS / NEEDS_DECISIONS]
Workbooks: [количество файлов в output/]

Open questions: [N штук — перечислить коротко]

▶ Если open questions — ответить Gemini и продолжить
▶ Если PASS — отправить на Claude QA review
```

---

## Этап 4 — Prompt для Claude (QA review)

**Кто отправляет:** ты
**Кому:** Claude

```
Steel Analyzer QA review — Nordic A-jaur v4.

Run ID: nordic-ajaur-v4-20260524
Output: steel-bus/runs/nordic-ajaur-v4-20260524/output/

Gemini report: [вставить отчёт Gemini полностью]

Проверить по полному QA стандарту:
1. Paint table — все профили покрыты, subtotals на месте
2. Totals — arithmetic check BoM vs Material List
3. Extraction audit — source mapping прослеживается до строки PDF
4. Profile completeness — нет ли пропущенных профилей
5. Truss exclusion — Skärmtak тrusses исключены из BoM/ML, видны в Description
6. Ombyggnad basis — соответствует v3

Контрольные тотals:
- Skärmtak: 28.211 t / 740.700 m²
- Ombyggnad: 21.151 t / 503.900 m²
- Total: 49.363 t / 1244.600 m²

Вернуть: ACCEPTED или NEEDS_FIXES + конкретные замечания по каждому пункту.
```

---

## Этап 5 — Claude QA verdict получен

**Кто отправляет:** ты (после получения от Claude)
**Кому:** в Telegram (себе)

```
🔍 Claude QA verdict: [ACCEPTED / NEEDS_FIXES]
Run: nordic-ajaur-v4-20260524

[Если NEEDS_FIXES — перечислить замечания коротко]

▶ Если NEEDS_FIXES — отправить Gemini на правки
▶ Если ACCEPTED — запросить upload approval
```

---

## Этап 6 — Запрос upload approval

**Кто отправляет:** Codex / ты сам
**Кому:** в Telegram (себе) — **это будущая кнопка**

```
⬆️ Готов к upload
Run: nordic-ajaur-v4-20260524
Drive folder: 1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5

Файлы для upload:
- BoM_Nordic_Ajaur_v4.xlsx
- MaterialList_Nordic_Ajaur_v4.xlsx
- Description_Nordic_Ajaur_v4.xlsx

QA: Claude ACCEPTED ✅
MD5 local: [из workbook-validator]

Команда для подтверждения:
node agent-core/scripts/steel-drive.mjs upload \
  --run nordic-ajaur-v4-20260524 \
  --folder 1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5 \
  --file output/BoM_Nordic_Ajaur_v4.xlsx \
  --owner-approval "I_APPROVE_STEEL_UPLOAD:nordic-ajaur-v4-20260524:1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5"

[В Sprint 10 здесь будет кнопка ✅ Approve / ❌ Reject]
```

---

## Этап 7 — Upload завершён

**Кто отправляет:** steel-drive.mjs / Codex
**Кому:** в Telegram (себе)

```
✅ Upload завершён
Run: nordic-ajaur-v4-20260524

Файлы:
- BoM_Nordic_Ajaur_v4.xlsx → drive_file_id: [ID] — MD5 ✅
- MaterialList_Nordic_Ajaur_v4.xlsx → drive_file_id: [ID] — MD5 ✅
- Description_Nordic_Ajaur_v4.xlsx → drive_file_id: [ID] — MD5 ✅

Manifest: steel-bus/runs/nordic-ajaur-v4-20260524/manifest-drive-upload.json
Drive folder: https://drive.google.com/drive/folders/1v3IsL7b4c_1cWfDC77UTNlWHWx756CW5

▶ Обновить steel-analyzer-results-index.md
```

---

## Этап 8 — Обновление индекса

**Кто отправляет:** Codex
**Кому:** в Telegram (себе)

```
📝 Индекс обновлён
/root/CODEXCLAW/obsidian-vault/projects/steel/steel-analyzer-results-index.md

Nordic A-jaur v4 — 2026-05-24
- BoM: [drive_file_id]
- Material List: [drive_file_id]
- Description: [drive_file_id]
- Totals: 49.363 t / 1244.600 m²

🏁 Run nordic-ajaur-v4-20260524 COMPLETE
```

---

## Nuances log (заполнять во время ручного прогона)

Сюда фиксировать всё, что пошло не так или требует автоматизации:

- [ ] ...
- [ ] ...

Это сырьё для Sprint 9 (workbook generator) и Sprint 10 (Telegram bot).
