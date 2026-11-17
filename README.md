# trading-engine

Binance USDⓈ-M Futures için long + short trading botu. Backtest ve canlı motor **aynı strateji kodunu** çalıştırır. Borsa tek doğruluk kaynağıdır ve hiçbir pozisyon stopsuz kalmaz.

> Uyarı: Bu yazılım kâr garantisi vermez. Futures kaldıraçlıdır ve sermayenin tamamını kaybettirebilir. `docs/PLAN.md`'deki kapılar geçilmeden canlıya alınmamalıdır.

## Nasıl çalışır

```
her dakika ─▶ mutabakat (borsa ↔ veritabanı, eksik stop varsa koy)
          └▶ yeni 4h mum kapandıysa:
               pozisyon var  ─▶ trailing stop'u sıkılaştır (yenisini koy, eskisini iptal et)
               pozisyon yok  ─▶ strateji ─▶ 7 gate ─▶ boyutlandırma ─▶ market giriş ─▶ reduce-only stop
                                                                      stop konamazsa ─▶ piyasadan kapat
```

| Klasör | İçerik |
|---|---|
| `src/strategy/` | Saf strateji fonksiyonları (yalnızca kapanmış mumlar) |
| `src/backtest/` | Dürüst backtest + metrikler + kabul kriterleri |
| `src/risk/` | Gate'ler (en fazla 8), boyutlandırma, fiyat/miktar yuvarlama |
| `src/exchange/` | Binance futures istemcisi ve paper borsası (aynı arayüz) |
| `src/engine/` | Canlı motor ve mutabakat |
| `src/db/`, `src/api/` | Postgres ve dashboard API'si |
| `deploy/` | Hostinger VPS kurulum rehberi |

## Hızlı başlangıç (yerel)

```bash
npm ci
npm test
npm run download -- --interval 4h --from 2021-01-01
npm run backtest -- --interval 4h --split 2025-01-01 --robustness
```

Paper modunda motor (Postgres gerekir):

```bash
cp .env.example .env   # MODE=paper
docker compose up -d --build
```

VPS kurulumu: `deploy/README.md`. Plan ve ilerleme: `docs/PLAN.md`, `PROGRESS.md`.

## Ajan iş akışı

Proje [agent-patterns](https://github.com/aliercankonus/agent-patterns) başlangıç şablonu üzerine kuruludur: `/delegate`, `/e2e-code-review`, `/context-handoff` skill'leri ve `.claude/agents/` altındaki gözden geçirme ajanları. Kurallar `CLAUDE.md`'de.
